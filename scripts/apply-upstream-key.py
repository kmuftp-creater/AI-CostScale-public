#!/usr/bin/env python3
"""套用「新增上游金鑰」的請求（2026-09-07）。由主機端 cron 每分鐘跑一次。

為什麼是這個架構
---------------
儀表板是對外的網頁應用。要讓它自己改 .env、改 litellm-config.yaml、重啟容器，
最直接的做法是把 docker socket 掛進去——**那等於讓一個對外的網頁應用可以
控制整台機器上所有容器**，代價不成比例。

所以改成：儀表板只寫一個「待套用」檔到 spool 目錄（它唯一多拿到的權限），
主機端這支腳本每分鐘檢查、套用、重啟、驗證、失敗回滾。
儀表板永遠碰不到 docker，也碰不到 .env 本身。

為什麼用文字插入而不是 YAML 讀寫
-------------------------------
`litellm-config.yaml` 裡有大量的說明註解，那些註解是這個專案最有價值的資產之一
（為什麼某個模型走 Vertex、為什麼 rpm 設成這個數字、踩過什麼坑）。
**任何 YAML 函式庫做 load→dump 都會把註解整份丟掉。**
所以這裡在目標 model_name 的最後一筆之後做**純文字插入**，其餘一個字都不動。

契約
----
spool 目錄： /opt/costscale/spool/upstream-keys/
  <id>.json         儀表板寫，權限 600，含明文金鑰，**套用後立刻刪除**
  <id>.status.json  本腳本寫，權限 644，不含金鑰，儀表板讀它顯示結果

請求格式：
  {"id","provider","modelName","envVar","key","backendModel","rpm","pricingType"}

狀態格式：
  {"id","state":"applied|failed","message","at","envVar","modelName"}
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime

# COSTSCALE_ROOT 讓這支能拿「正式檔案的副本」在別的目錄測，不必碰正式機。
# 沒設就是正式路徑。測試時另外設 COSTSCALE_NO_RESTART=1 就不會真的動容器。
ROOT = os.environ.get("COSTSCALE_ROOT", "/opt/costscale")
NO_RESTART = os.environ.get("COSTSCALE_NO_RESTART") == "1"
SPOOL = os.path.join(ROOT, "spool", "upstream-keys")
ENV_PATH = os.path.join(ROOT, ".env")
CFG_PATH = os.path.join(ROOT, "litellm-config.yaml")
COMPOSE = ["docker", "compose", "-f", os.path.join(ROOT, "docker-compose.yml"),
           "-f", os.path.join(ROOT, "docker-compose.vps.yml")]
# **是 4400 不是 4000。** docker-compose.vps.yml 把閘道發佈在 127.0.0.1:4400；
# 主機的 4000 是 app-a 的網站（單頁式，任何 GET 都回 200 HTML）。
# 2026-09-07 到 09-10 這裡寫的是 4000，於是「重啟後驗證、失敗就回滾」
# 一直在檢查 app-a，**從來沒有真正驗過閘道**——9/7 的回滾測試用的是
# COSTSCALE_FORCE_FAIL，所以沒抓到。2026-09-10 做硬上限的端到端時，
# POST 打到 4000 回「Cannot POST」才發現。
# 可用 COSTSCALE_GATEWAY_URL 覆寫（賣給別人時埠不一定一樣）。
GATEWAY = os.environ.get("COSTSCALE_GATEWAY_URL", "http://127.0.0.1:4400")
HEALTH = GATEWAY + "/health/liveliness"
LOG = os.path.join(ROOT, "spool", "apply-upstream-key.log")

ENV_VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,60}$")
PROVIDERS = {
    # provider → litellm 的 model 前綴
    "gemini": "gemini/",
    "openai": "openai/",
    "anthropic": "anthropic/",
    "groq": "groq/",
    "openrouter": "openrouter/",
}


def log(msg):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line)


def write_status(req_id, state, message, extra=None):
    p = os.path.join(SPOOL, req_id + ".status.json")
    d = {"id": req_id, "state": state, "message": message,
         "at": datetime.now().astimezone().isoformat()}
    if extra:
        d.update(extra)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)
    os.chmod(p, 0o644)


def stamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def backup(path):
    b = "%s.bak-%s" % (path, stamp())
    shutil.copy2(path, b)
    return b


def env_pairs():
    """回「設定檔真的有引用」的那些環境變數的 變數名→值。只在記憶體用。

    **不要用「值長什麼樣」來判斷是不是金鑰。** 第一版寫死
    `AIza`／`sk-`／`gsk_` 開頭，結果 User 2026-09-07 新建的兩把 Google 金鑰是
    `AQ.A` 開頭（AI Studio 換過格式），整批被漏掉、尾碼表上看不到。
    改成從 `litellm-config.yaml` 反查 `os.environ/XXX`——
    **閘道要用哪些變數，設定檔自己就寫著，不必猜。**
    """
    wanted = set()
    try:
        with open(CFG_PATH, encoding="utf-8") as f:
            wanted = set(re.findall(r"os\.environ/([A-Z][A-Z0-9_]*)", f.read()))
    except Exception:
        pass
    out = {}
    try:
        with open(ENV_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k in wanted and v:
                    out[k] = v
    except Exception:
        pass
    return out


def env_has(name):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith(name + "="):
                return True
    return False


def next_free(name):
    """`GEMINI_FREE_KEY_6` 已存在時，算出下一個沒被用的編號。
    失敗訊息只說「已存在」等於把人丟在原地——要告訴他改用哪一個。"""
    m = re.match(r"^(.*?)(\d+)$", name)
    if not m:
        return None
    prefix, n = m.group(1), int(m.group(2))
    for i in range(n + 1, n + 50):
        if not env_has("%s%d" % (prefix, i)):
            return "%s%d" % (prefix, i)
    return None


def write_tails():
    """把每一把金鑰的尾 4 碼寫給儀表板看。

    為什麼要有這個：儀表板沒有掛 `.env`（刻意的），所以它只知道變數名、
    不知道那把金鑰長什麼樣。User 的回饋是
    「每一組金鑰都沒有出現尾碼，也不知道哪支是哪支，他說失敗我也沒辦法知道要換哪支」——
    要去 Google 後台停用一把，得先認得出是哪一把，而人認的是尾碼。

    只寫**尾 4 碼**，不是完整值。檔名以 `_` 開頭，套用迴圈會跳過它。
    """
    try:
        tails = {k: v[-4:] for k, v in env_pairs().items()}
        p = os.path.join(SPOOL, "_tails.json")
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"tails": tails, "at": datetime.now().astimezone().isoformat()}, f)
        os.replace(tmp, p)
        os.chmod(p, 0o644)
    except Exception as e:
        log("寫 _tails.json 失敗：%s" % e)


def find_last_entry_of_group(lines, model_name):
    """回傳該 model_name 最後一筆條目的結束行索引（不含），找不到回 None。

    條目的樣子（兩格縮排的 `- model_name:` 開頭，直到下一個同層 `-` 或非縮排行）。
    """
    starts = []
    for i, ln in enumerate(lines):
        if re.match(r"^  - model_name:\s*['\"]?%s['\"]?\s*$" % re.escape(model_name), ln.rstrip()):
            starts.append(i)
    if not starts:
        return None
    last = starts[-1]
    j = last + 1
    while j < len(lines):
        ln = lines[j]
        if ln.strip() == "":
            j += 1
            continue
        # 下一個同層條目、縮排回到頂層，或**區段標題註解**。
        # 註解也要當邊界：`  # ══ Vertex AI ══` 這種分隔線屬於後面那一段，
        # 不是前一筆的尾巴。少了這一條，移除時會把後面那段的標題一起刪掉。
        if re.match(r"^  - ", ln) or re.match(r"^[^\s#]", ln) or re.match(r"^ {0,3}#", ln):
            break
        j += 1
    # 把結尾的空行留在下一塊
    while j - 1 > last and lines[j - 1].strip() == "":
        j -= 1
    return j


def build_entry(req):
    """組出要插入的 YAML 片段。縮排與既有條目一致（兩格）。"""
    out = []
    out.append("  - model_name: %s\n" % req["modelName"])
    out.append("    litellm_params:\n")
    out.append("      model: %s\n" % req["backendModel"])
    out.append("      api_key: os.environ/%s\n" % req["envVar"])
    if req.get("rpm"):
        out.append("      rpm: %d\n" % int(req["rpm"]))
    if req.get("pricingType"):
        out.append("    model_info:\n")
        out.append("      pricing_type: %s\n" % req["pricingType"])
    return out


def model_name_of(lines, start):
    m = re.match(r"^  - model_name:\s*['\"]?([^'\"\s]+)", lines[start])
    return m.group(1) if m else None


def find_entries_by_env(lines, env_var):
    """找出所有掛著「api_key: os.environ/<env_var>」的條目，回 [(起, 迄), ...]。

    一筆條目從 `  - model_name:` 開始，到下一個同層 `  - ` 或頂層行之前結束。
    **一定要回全部、不能只回第一筆。** 實測 `GROQ_KEY_1` 同時掛在 `groq-fast`
    與 `groq-large` 兩筆底下——只刪第一筆的話，另一筆會繼續指著一個已經被
    註解掉的環境變數，LiteLLM 拿到空金鑰，變成間歇性 401。

    **不用 YAML 讀寫**，理由同插入那一段：註解不能掉。
    """
    target = "os.environ/%s" % env_var
    hits = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if "api_key" in s and s.endswith(target):
            hits.append(i)

    spans = []
    for hit in hits:
        start = hit
        while start >= 0 and not re.match(r"^  - model_name:", lines[start]):
            start -= 1
        if start < 0:
            continue
        end = hit + 1
        while end < len(lines):
            ln = lines[end]
            if ln.strip() == "":
                end += 1
                continue
            if re.match(r"^  - ", ln) or re.match(r"^[^\s#]", ln) or re.match(r"^ {0,3}#", ln):
                break
            end += 1
        # 把緊鄰的空行一起帶走，不要留下越刪越多的空白
        while end - 1 > start and lines[end - 1].strip() == "":
            end -= 1
        # 名字要在「起點往前擴去吃空行」之前先取，
        # 擴完之後 lines[start] 是空白行，取出來會是 None。
        name = model_name_of(lines, start)
        while start - 1 >= 0 and lines[start - 1].strip() == "":
            start -= 1
        spans.append((start, end, name or "?"))
    return spans


def count_group(lines, model_name):
    return sum(1 for ln in lines
               if re.match(r"^  - model_name:\s*['\"]?%s['\"]?\s*$" % re.escape(model_name),
                           ln.rstrip()))


def comment_out_env(name):
    """把 `.env` 裡的 `NAME=...` 那一行改成註解，**不是刪掉**。

    為什麼保留值：移除是為了讓閘道不要再用這把金鑰，不是為了銷毀它。
    留著（註解掉、檔案權限一樣 600）代表按錯了還救得回來——
    真正要作廢是去供應商後台停用，那件事這支腳本做不到也不該做。
    回傳有沒有真的動到。
    """
    with open(ENV_PATH, encoding="utf-8") as f:
        lines = f.readlines()
    hit = False
    out = []
    for ln in lines:
        if not hit and ln.strip().startswith(name + "="):
            out.append("# [%s 由儀表板移除] %s" % (stamp(), ln.lstrip()))
            hit = True
        else:
            out.append(ln)
    if hit:
        with open(ENV_PATH, "w", encoding="utf-8") as f:
            f.writelines(out)
        os.chmod(ENV_PATH, 0o600)
    return hit


def gateway_ok(timeout_s=90):
    """等閘道活過來。"""
    # 測試用的縫：回滾路徑是這支腳本最危險也最需要驗的一段，
    # 但要在正式機上真的驗它，得先把閘道弄壞——那是不能接受的代價。
    # 這個旗標讓「套用之後閘道沒活過來」可以在副本上重現，不必動正式機。
    if os.environ.get("COSTSCALE_FORCE_FAIL") == "1":
        return False
    if NO_RESTART:
        return True
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        # 只看狀態碼不夠：佔著這個埠的若是別的服務（見 HEALTH 的註解），
        # 它一樣回 200。LiteLLM 的存活端點回的是 "I'm alive!"，要看到它才算。
        r = subprocess.run(["curl", "-s", "-m", "5", "-w", "\n%{http_code}", HEALTH],
                           capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if code.strip() == "200" and "alive" in body.lower():
            return True
        time.sleep(3)
    return False


def restart_gateway():
    if NO_RESTART:
        log("（測試模式）略過重啟閘道")
        return
    subprocess.run(COMPOSE + ["up", "-d", "litellm"], cwd=ROOT,
                   capture_output=True, text=True, timeout=300)


BACKEND_RE = re.compile(r"^[a-z][a-z0-9_]*/[A-Za-z0-9._\-/:]+$")

CATALOG_PROVIDER = {
    "vertex_ai": "vertex", "gemini": "gemini", "groq": "groq", "openrouter": "openrouter",
    "openai": "openai", "anthropic": "anthropic", "deepseek": "deepseek", "xai": "xai",
}


def find_entries_by_group(lines, model_name):
    """該 model_name 的所有條目 [(起, 迄)]。邊界規則與 find_entries_by_env 相同。"""
    spans = []
    pat = r"^  - model_name:\s*['\"]?%s['\"]?\s*$" % re.escape(model_name)
    for i, ln in enumerate(lines):
        if not re.match(pat, ln.rstrip()):
            continue
        end = i + 1
        while end < len(lines):
            x = lines[end]
            if x.strip() == "":
                end += 1
                continue
            if re.match(r"^  - ", x) or re.match(r"^[^\s#]", x) or re.match(r"^ {0,3}#", x):
                break
            end += 1
        spans.append((i, end))
    return spans


def env_pairs_all():
    """整份 .env。只在記憶體用，不寫出去。"""
    out = {}
    try:
        with open(ENV_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k.strip()] = v
    except Exception:
        pass
    return out


def catalog_has(backend):
    """新目標在供應商型錄裡存不存在。型錄抓不到回 None（不擋，但要講）。

    型錄是 fetch-upstream-models.py 每 6 小時寫的 _models.json。
    有它就擋得掉打錯字這種最常見的失誤——指到一個不存在的型號，
    設定檔看起來完全正常，要等有人真的呼叫才會 404。
    """
    try:
        with open(os.path.join(SPOOL, "_models.json"), encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    head, _, rest = backend.partition("/")
    prov = CATALOG_PROVIDER.get(head)
    if not prov:
        return None
    p = data.get("providers", {}).get(prov)
    if not p:
        return None
    models = p.get("models", [])
    return rest in models or backend in models


def gateway_backend_of(model_name):
    """閘道現在真的把這個部署名打到哪一支。問不到回 None。

    **這一步不能省**（2026-09-21 的教訓）：改完設定檔重啟，只看健康檢查 200
    是不夠的。那天我以為三項修改都上線了，實際上容器根本沒被重建、
    閘道還在跑舊設定，而所有冒煙測試在舊設定下也會過。
    要驗的是「改動本身生效了嗎」，不是「服務還活著嗎」。
    """
    if NO_RESTART:
        return None
    key = env_pairs_all().get("LITELLM_MASTER_KEY")
    if not key:
        return None
    r = subprocess.run(["curl", "-s", "-m", "10", GATEWAY + "/model/info",
                        "-H", "Authorization: Bearer " + key],
                       capture_output=True, text=True)
    try:
        data = json.loads(r.stdout)
    except Exception:
        return None
    for m in data.get("data", []):
        if m.get("model_name") == model_name:
            return (m.get("litellm_params") or {}).get("model")
    return None


def process_retarget(req_id, req):
    """把某個部署名改成打另一支後端模型（2026-09-21）。

    用途：供應商把模型下架或宣告停用時，在儀表板上換掉，不必 ssh 進來改檔案。

    語意是「這個名字底下的每一筆都改」。像 gemini-flash-free 有五把金鑰輪替，
    五筆指著同一支模型，只改一筆會變成一半新一半舊——那是最難查的狀態：
    有時候成功有時候失敗，而且兩次呼叫的答案品質還不一樣。

    四道擋：名字要存在、新目標格式要對、不能是萬用、不能跟現在一樣。
    另外拿供應商型錄核對新目標存不存在（型錄抓不到就只警告不擋）。
    """
    model_name = (req.get("modelName") or "").strip()
    backend = (req.get("backendModel") or "").strip()
    if not model_name or "*" in model_name:
        write_status(req_id, "failed", "部署名不合法：%s" % model_name)
        return
    if not BACKEND_RE.match(backend) or "*" in backend:
        write_status(req_id, "failed",
                     "新的後端模型要寫成「供應商/型號」，例如 vertex_ai/gemini-3.8-flash，"
                     "而且不能含萬用字元。收到的是：%s" % backend,
                     {"modelName": model_name})
        return

    with open(CFG_PATH, encoding="utf-8") as f:
        lines = f.readlines()
    spans = find_entries_by_group(lines, model_name)
    if not spans:
        write_status(req_id, "failed", "設定檔裡沒有叫 %s 的部署。" % model_name,
                     {"modelName": model_name})
        return

    targets = []   # (行索引, 舊值, 縮排)
    for start, end in spans:
        for i in range(start, end):
            m = re.match(r"^(\s+)model:\s*(\S+)\s*$", lines[i])
            if m:
                targets.append((i, m.group(2), m.group(1)))
                break
    if not targets:
        write_status(req_id, "failed", "%s 的條目裡找不到 model: 那一行。" % model_name,
                     {"modelName": model_name})
        return

    olds = {old for _i, old, _ind in targets}
    if olds == {backend}:
        write_status(req_id, "failed",
                     "%s 本來就已經指向 %s，沒有要改的。" % (model_name, backend),
                     {"modelName": model_name})
        return

    known = catalog_has(backend)
    if known is False:
        write_status(req_id, "failed",
                     "供應商的模型清單裡沒有 %s。打錯字的話設定檔看起來完全正常，"
                     "要等有人真的呼叫才會 404，所以這裡先擋下來。" % backend,
                     {"modelName": model_name})
        return
    note = "（沒有供應商型錄可核對，新目標未經驗證）" if known is None else ""

    cfg_bak = backup(CFG_PATH)
    log("[%s] 換模型 %s：%s → %s（%d 處）備份：%s"
        % (req_id, model_name, "、".join(sorted(olds)), backend, len(targets),
           os.path.basename(cfg_bak)))

    try:
        for i, _old, indent in targets:
            lines[i] = "%smodel: %s\n" % (indent, backend)
        with open(CFG_PATH, "w", encoding="utf-8") as f:
            f.writelines(lines)

        try:
            import yaml  # noqa
            with open(CFG_PATH, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            hit = [m for m in (doc.get("model_list") or []) if m.get("model_name") == model_name]
            if len(hit) != len(spans):
                raise ValueError("改完之後 %s 的條目數不對（%d ≠ %d）"
                                 % (model_name, len(hit), len(spans)))
            for m in hit:
                if (m.get("litellm_params") or {}).get("model") != backend:
                    raise ValueError("改完之後還有條目沒指向 %s" % backend)
        except ImportError:
            log("[%s] 沒有 pyyaml，略過語法預檢" % req_id)

        log("[%s] 重啟閘道…" % req_id)
        restart_gateway()
        if not gateway_ok():
            raise RuntimeError("閘道重啟後 90 秒內沒有回到健康狀態")

        live = gateway_backend_of(model_name)
        if live is not None and live != backend:
            raise RuntimeError("閘道重啟後 %s 仍然指向 %s，設定沒有生效" % (model_name, live))

        write_status(req_id, "applied",
                     "已把 %s 從 %s 改成 %s（共 %d 處）並重啟閘道，閘道確認已生效。%s"
                     % (model_name, "、".join(sorted(olds)), backend, len(targets), note),
                     {"modelName": model_name, "backendModel": backend})
        log("[%s] 換模型成功：%s → %s" % (req_id, model_name, backend))

    except Exception as e:
        log("[%s] 換模型失敗，回滾：%s" % (req_id, e))
        try:
            shutil.copy2(cfg_bak, CFG_PATH)
            restart_gateway()
            ok = gateway_ok()
            msg = "換模型失敗已回滾（閘道%s）：%s" % ("已恢復" if ok else "**仍不健康，要人工處理**", e)
        except Exception as e2:
            msg = "換模型失敗且回滾也失敗，要人工處理：%s ／ 回滾錯誤：%s" % (e, e2)
        write_status(req_id, "failed", msg, {"modelName": model_name, "backendModel": backend})


def process_remove(req_id, req):
    """把一把金鑰移出輪替：設定檔刪掉那一筆條目，`.env` 那一行改成註解。

    兩道擋：
      1. 設定檔裡找不到這個變數 → 不動任何東西。
      2. 這是該模型組的**最後一筆** → 拒絕。刪掉會讓整個模型名從閘道消失，
         所有指名它的呼叫端當場全掛，那不是「移除一把金鑰」這個動作該有的後果。
    """
    env_var = req.get("envVar", "")
    if not ENV_VAR_RE.match(env_var or ""):
        write_status(req_id, "failed", "環境變數名不合法：%s" % env_var)
        return

    with open(CFG_PATH, encoding="utf-8") as f:
        lines = f.readlines()
    spans = find_entries_by_env(lines, env_var)
    if not spans:
        write_status(req_id, "failed",
                     "設定檔裡沒有掛 %s 的條目，沒有東西可以移除。" % env_var,
                     {"envVar": env_var})
        return

    # 這把金鑰掛在哪幾個模型組、各要拿掉幾筆
    groups = {}
    for _start, _end, g in spans:
        groups[g] = groups.get(g, 0) + 1
    # 任何一組會被清空就整批拒絕。少一個模型的後果遠大於少一把金鑰。
    for g, n in groups.items():
        if count_group(lines, g) <= n:
            write_status(req_id, "failed",
                         "%s 是模型組 %s 的最後一把，移掉的話這個模型會整個從閘道消失，"
                         "所有指名它的呼叫端會立刻失敗。先新增一把再回來移這把。"
                         % (env_var, g),
                         {"envVar": env_var, "modelName": g})
            return
    model_name = "、".join(sorted(groups))

    env_bak = backup(ENV_PATH)
    cfg_bak = backup(CFG_PATH)
    log("[%s] 移除 %s（%s）備份：%s / %s"
        % (req_id, env_var, model_name, os.path.basename(env_bak), os.path.basename(cfg_bak)))

    try:
        # 由後往前刪，否則刪了前面那一段之後，後面那一段的索引就不對了
        kept = list(lines)
        for start, end, _g in sorted(spans, reverse=True):
            kept = kept[:start] + kept[end:]
        with open(CFG_PATH, "w", encoding="utf-8") as f:
            f.writelines(kept)
        try:
            import yaml  # noqa
            with open(CFG_PATH, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            names = [m.get("model_name") for m in (doc.get("model_list") or [])]
            for g in groups:
                if g not in names:
                    raise ValueError("刪除之後 %s 整組不見了" % g)
            for m in (doc.get("model_list") or []):
                if "os.environ/%s" % env_var in str(m):
                    raise ValueError("刪除之後 %s 還在設定檔裡" % env_var)
        except ImportError:
            log("[%s] 沒有 pyyaml，略過語法預檢" % req_id)

        commented = comment_out_env(env_var)

        log("[%s] 重啟閘道…" % req_id)
        restart_gateway()
        if not gateway_ok():
            raise RuntimeError("閘道重啟後 90 秒內沒有回到健康狀態")

        write_status(req_id, "applied",
                     "已把 %s 移出 %s（共 %d 筆）並重啟閘道。%s"
                     % (env_var, model_name, len(spans),
                        ".env 那一行已改成註解（值留著，按錯救得回來）。"
                        if commented else ".env 裡本來就沒有這個變數。"),
                     {"envVar": env_var, "modelName": model_name})
        log("[%s] 移除成功：%s" % (req_id, env_var))

    except Exception as e:
        log("[%s] 移除失敗，回滾：%s" % (req_id, e))
        try:
            shutil.copy2(env_bak, ENV_PATH)
            os.chmod(ENV_PATH, 0o600)
            shutil.copy2(cfg_bak, CFG_PATH)
            restart_gateway()
            ok = gateway_ok()
            msg = "移除失敗已回滾（閘道%s）：%s" % ("已恢復" if ok else "**仍不健康，要人工處理**", e)
        except Exception as e2:
            msg = "移除失敗且回滾也失敗，要人工處理：%s ／ 回滾錯誤：%s" % (e, e2)
        write_status(req_id, "failed", msg, {"envVar": env_var, "modelName": model_name})


def process(req_path):
    req_id = os.path.basename(req_path)[:-5]
    try:
        with open(req_path, encoding="utf-8") as f:
            req = json.load(f)
    except Exception as e:
        write_status(req_id, "failed", "請求檔讀不到或不是合法 JSON：%s" % e)
        os.remove(req_path)
        return

    # 換模型走另一條路：它不碰 .env，只改設定檔裡的 model: 那一行。
    if req.get("op") == "retarget":
        try:
            process_retarget(req_id, req)
        finally:
            try:
                os.remove(req_path)
            except Exception:
                pass
        return

    # 移除走另一條路：它不需要 provider／金鑰，擋的條件也完全不同。
    if req.get("op") == "remove":
        try:
            process_remove(req_id, req)
        finally:
            try:
                os.remove(req_path)
            except Exception:
                pass
        return

    # ── 驗證 ──────────────────────────────────────────────────────────
    for k in ("provider", "modelName", "envVar", "key", "backendModel"):
        if not req.get(k):
            write_status(req_id, "failed", "缺少欄位 %s" % k)
            os.remove(req_path)
            return
    if req["provider"] not in PROVIDERS:
        write_status(req_id, "failed", "不支援的供應商：%s" % req["provider"])
        os.remove(req_path)
        return
    if not ENV_VAR_RE.match(req["envVar"]):
        write_status(req_id, "failed", "環境變數名不合法：%s" % req["envVar"])
        os.remove(req_path)
        return
    if env_has(req["envVar"]):
        nf = next_free(req["envVar"])
        tip = ("　下一個沒被用的是 %s，把環境變數名改成它再送一次。" % nf) if nf else ""
        write_status(req_id, "failed",
                     "%s 已經存在於 .env，不覆蓋。%s" % (req["envVar"], tip),
                     {"envVar": req["envVar"], "modelName": req["modelName"]})
        os.remove(req_path)
        return
    if "\n" in req["key"] or "\r" in req["key"] or not req["key"].strip():
        write_status(req_id, "failed", "金鑰含換行或是空的")
        os.remove(req_path)
        return
    if req["key"][0] in "<\"'" or req["key"][-1] in ">\"'":
        write_status(req_id, "failed", "金鑰前後有角括號或引號，只貼值本身")
        os.remove(req_path)
        return

    with open(CFG_PATH, encoding="utf-8") as f:
        lines = f.readlines()
    end = find_last_entry_of_group(lines, req["modelName"])
    if end is None:
        write_status(req_id, "failed",
                     "設定檔裡找不到模型組 %s。這一版只能加進既有的模型組。" % req["modelName"])
        os.remove(req_path)
        return

    # ── 備份 ──────────────────────────────────────────────────────────
    env_bak = backup(ENV_PATH)
    cfg_bak = backup(CFG_PATH)
    log("[%s] 備份：%s / %s" % (req_id, os.path.basename(env_bak), os.path.basename(cfg_bak)))

    try:
        # .env 追加
        with open(ENV_PATH, "a", encoding="utf-8") as f:
            f.write("\n# %s 由儀表板新增（%s）\n%s=%s\n"
                    % (req["provider"], stamp(), req["envVar"], req["key"]))
        os.chmod(ENV_PATH, 0o600)

        # config 插入
        new_lines = lines[:end] + ["\n"] + build_entry(req) + lines[end:]
        with open(CFG_PATH, "w", encoding="utf-8") as f:
            f.writelines(new_lines)

        # YAML 語法先自己驗一次，壞掉就不要驚動閘道
        try:
            import yaml  # noqa
            with open(CFG_PATH, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            names = [m.get("model_name") for m in (doc.get("model_list") or [])]
            if names.count(req["modelName"]) < 2 and req["modelName"] not in names:
                raise ValueError("插入之後在 model_list 裡找不到 %s" % req["modelName"])
        except ImportError:
            log("[%s] 沒有 pyyaml，略過語法預檢" % req_id)

        log("[%s] 重啟閘道…" % req_id)
        restart_gateway()
        if not gateway_ok():
            raise RuntimeError("閘道重啟後 90 秒內沒有回到健康狀態")

        write_status(req_id, "applied",
                     "已加入 %s 並重啟閘道" % req["modelName"],
                     {"envVar": req["envVar"], "modelName": req["modelName"]})
        log("[%s] 成功：%s → %s" % (req_id, req["envVar"], req["modelName"]))

    except Exception as e:
        log("[%s] 失敗，回滾：%s" % (req_id, e))
        try:
            shutil.copy2(env_bak, ENV_PATH)
            os.chmod(ENV_PATH, 0o600)
            shutil.copy2(cfg_bak, CFG_PATH)
            restart_gateway()
            ok = gateway_ok()
            msg = "套用失敗已回滾（閘道%s）：%s" % ("已恢復" if ok else "**仍不健康，要人工處理**", e)
        except Exception as e2:
            msg = "套用失敗且回滾也失敗，要人工處理：%s ／ 回滾錯誤：%s" % (e, e2)
        write_status(req_id, "failed", msg,
                     {"envVar": req["envVar"], "modelName": req["modelName"]})
    finally:
        # 請求檔含明文金鑰，無論成敗都要刪掉
        try:
            os.remove(req_path)
        except Exception:
            pass


def main():
    if not os.path.isdir(SPOOL):
        return
    # 底線開頭的是給儀表板讀的資料檔（_tails.json），不是請求。
    pend = sorted(p for p in os.listdir(SPOOL)
                  if p.endswith(".json")
                  and not p.endswith(".status.json")
                  and not p.startswith("_"))
    for name in pend:
        process(os.path.join(SPOOL, name))
    # 每輪都刷新尾碼表，這樣手動改過 .env 之後儀表板也跟得上。
    write_tails()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""抓「每一把上游金鑰實際能用哪些模型」，寫成 spool/upstream-keys/_models.json。

為什麼要有這支（2026-09-21，User：「有的模型會過時，就像 gemini 2.5 系列的即將要全部停用了，
我要避免用到」）：儀表板**刻意沒有掛 .env**，容器裡一把上游金鑰都沒有，所以它自己問不到
供應商「這把金鑰能用什麼」。沿用 _tails.json 的既有分工：主機端讀 .env、去問供應商，
只把**模型名稱與公開的中繼資料**寫進 spool，儀表板讀檔顯示。金鑰值一個位元組都不會離開主機。

「即將停用」到底問不問得到（2026-09-21 逐家實測，結論寫在這裡免得以後又去猜）：
  OpenRouter  有 expiration_date，446 個模型裡 16 個有值，是唯一會直說日期的一家。
  Vertex AI   只有 launchStage（GA / PUBLIC_PREVIEW / EXPERIMENTAL），沒有日期。
  Groq        只有 active 布林值，沒有日期。
  Gemini API  什麼都沒有，只有 version 與 description。
所以「已經消失」是事實（事後才知道），「預覽版」「同系列有更新世代」是推測——
兩者在輸出裡分成不同欄位，介面上也要分開講，不能混為一談。

輸出格式（不含任何金鑰值）：
  {"fetchedAt": ISO8601,
   "keys": {"<環境變數名>": {"provider","ok","count","models":[...],"error"}},
   "providers": {"<供應商>": {"count","models":[...],"meta":{"<模型id>": {...}}}}}
  meta 每一項：{"group","tags":[...],"stage","expires","expiresFrom","label"}
    group  主分類：文字／生圖／語音／影片／嵌入／音樂／其他（給介面分組用）
    tags   能力標籤：看圖、聽語音、讀影片、思考
    stage  ga / preview / experimental / inactive，空字串＝供應商沒說
    expires      供應商宣告的到期日（YYYY-MM-DD）
    expiresFrom  這個日期是誰說的（自己家，或 openrouter 的交叉參考）

用法：
  python3 fetch-upstream-models.py            # 正式跑，寫檔
  python3 fetch-upstream-models.py --dry-run  # 只印摘要，不寫檔
環境變數 COSTSCALE_ROOT 可指向副本目錄（測試用，不必碰正式檔）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.environ.get("COSTSCALE_ROOT", "/opt/costscale")
ENV_PATH = os.path.join(ROOT, ".env")
SPOOL = os.path.join(ROOT, "spool", "upstream-keys")
OUT = os.path.join(SPOOL, "_models.json")
# Vertex 服務帳戶：閘道容器掛在 /secrets/vertex-sa.json，主機端這支要用主機上的路徑。
SA_PATH = os.environ.get("COSTSCALE_VERTEX_SA", os.path.join(ROOT, "keys", "vertex-sa.json"))
TIMEOUT = 25

# ── 分類 ──
# 使用者不一定知道自己該用什麼模型（User 2026-09-21：「有的是文字、有的是語音、有的是圖片」），
# 所以每個模型都算一個「主分類」給介面分組，另外給能力標籤。
G_TEXT, G_IMAGE, G_AUDIO, G_VIDEO, G_EMBED, G_MUSIC, G_OTHER = (
    "文字", "生圖", "語音", "影片", "嵌入", "音樂", "其他")
T_VISION, T_HEAR, T_WATCH, T_THINK = "看圖", "聽語音", "讀影片", "思考"


def classify_by_name(mid):
    """只靠名字推分類。Vertex 沒有模態欄位，只能這樣；其他家拿來補充。"""
    n = mid.lower()
    if "embedding" in n or n.startswith("text-embedding"):
        return G_EMBED, []
    if "transcribe" in n or "whisper" in n:
        return G_AUDIO, [T_HEAR]
    if "tts" in n or "orpheus" in n or "playai" in n:
        return G_AUDIO, []
    if "live" in n or "native-audio" in n or "realtime" in n:
        return G_AUDIO, [T_HEAR]
    if "veo" in n or "video" in n:
        return G_VIDEO, []
    if "lyria" in n or "music" in n:
        return G_MUSIC, []
    if "imagen" in n or "-image" in n or n.endswith("image"):
        return G_IMAGE, []
    if "guard" in n or "moderation" in n or "rerank" in n:
        return G_OTHER, []
    return G_TEXT, []


def classify_by_modality(mid, ins, outs):
    """有 input_modalities / output_modalities 的（Groq、OpenRouter）用這個，準得多。"""
    ins = set(x.lower() for x in (ins or []))
    outs = set(x.lower() for x in (outs or []))
    tags = []
    if "image" in ins:
        tags.append(T_VISION)
    if "audio" in ins:
        tags.append(T_HEAR)
    if "video" in ins:
        tags.append(T_WATCH)

    if "transcription" in outs:
        group = G_AUDIO
    elif "speech" in outs or "audio" in outs:
        group = G_AUDIO
    elif "video" in outs:
        group = G_VIDEO
    elif "image" in outs:
        group = G_IMAGE
    elif "embedding" in outs:
        group = G_EMBED
    elif outs:
        group = G_TEXT
    else:
        group, _ = classify_by_name(mid)
    # 名字說是嵌入／護欄之類的，模態欄位分不出來，讓名字覆寫
    byname, _ = classify_by_name(mid)
    if byname in (G_EMBED, G_OTHER) and group == G_TEXT:
        group = byname
    return group, tags


def classify_gemini(mid, methods, thinking):
    """Gemini API 有 supportedGenerationMethods，比名字可靠。"""
    ms = set(methods or [])
    tags = []
    if thinking:
        tags.append(T_THINK)
    if "embedContent" in ms or "asyncBatchEmbedContent" in ms:
        return G_EMBED, tags
    if "bidiGenerateMusic" in ms:
        return G_MUSIC, tags
    group, extra = classify_by_name(mid)
    if group == G_TEXT and "bidiGenerateContent" in ms:
        group = G_AUDIO  # 即時語音對話
    if group == G_TEXT:
        tags.append(T_VISION)  # Gemini 的文字模型都吃得下圖片
    return group, tags + [t for t in extra if t not in tags]


def log(msg):
    print("%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))


def env_pairs():
    """讀 .env，回 {名稱: 值}。值只存在這支腳本的記憶體裡，不會寫進輸出。"""
    out = {}
    if not os.path.exists(ENV_PATH):
        return out
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
    return out


def get_json(url, headers):
    # User-Agent 不能省：Groq 擋掉 Python 預設的識別字串，回 HTTP 403 error code 1010
    # （2026-09-21 實測，加上之後就通）。
    h = dict(headers)
    h.setdefault("User-Agent", "costscale-upstream-models/1.0")
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def err_text(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = e.read().decode("utf-8")[:200]
        except Exception:
            body = ""
        return "HTTP %s %s" % (e.code, body)
    return str(e)[:200]


def rec(mid, group, tags, stage="", expires="", label=""):
    """一筆模型。id 以外全是公開中繼資料。"""
    return {
        "id": mid,
        "label": label or "",
        "group": group,
        "tags": [t for t in dict.fromkeys(tags or [])],
        "stage": stage,
        "expires": expires,
        "expiresFrom": "",
    }


# ── 各家的「列出模型」端點 ──
def list_gemini(key):
    out = []
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
    while url:
        d = get_json(url, {"x-goog-api-key": key})
        for m in d.get("models", []):
            n = m.get("name", "")
            if n.startswith("models/"):
                n = n[len("models/"):]
            methods = m.get("supportedGenerationMethods") or []
            # 早期版本只留 generateContent，結果嵌入、語音、生圖模型全被濾掉，
            # 使用者反而看不到自己有什麼可用（2026-09-21 改成全留，用分類區分）。
            group, tags = classify_gemini(n, methods, m.get("thinking"))
            out.append(rec(n, group, tags, label=m.get("displayName", "")))
        tok = d.get("nextPageToken")
        url = ("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&pageToken=" + tok) if tok else None
    return out


def list_openai_like(key, url):
    """OpenAI 相容的 /models。Groq 與 OpenRouter 多回了模態與生命週期，能用就用。"""
    d = get_json(url, {"Authorization": "Bearer " + key})
    out = []
    for m in d.get("data", []):
        mid = m.get("id")
        if not mid:
            continue
        arch = m.get("architecture") or {}
        ins = m.get("input_modalities") or arch.get("input_modalities")
        outs = m.get("output_modalities") or arch.get("output_modalities")
        if ins or outs:
            group, tags = classify_by_modality(mid, ins, outs)
        else:
            group, tags = classify_by_name(mid)
        stage = ""
        if m.get("active") is False:
            stage = "inactive"
        out.append(rec(mid, group, tags, stage=stage,
                       expires=(m.get("expiration_date") or ""),
                       label=m.get("name", "")))
    return out


def list_anthropic(key):
    d = get_json("https://api.anthropic.com/v1/models?limit=100",
                 {"x-api-key": key, "anthropic-version": "2023-06-01"})
    out = []
    for m in d.get("data", []):
        if m.get("id"):
            out.append(rec(m["id"], G_TEXT, [T_VISION], label=m.get("display_name", "")))
    return out


def vertex_token(sa_path):
    """用服務帳戶自己簽 JWT 換存取權杖（主機端有 PyJWT 與 cryptography）。"""
    import jwt  # PyJWT
    with open(sa_path, encoding="utf-8") as f:
        sa = json.load(f)
    now = int(time.time())
    claim = {
        "iss": sa["client_email"],
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    assertion = jwt.encode(claim, sa["private_key"], algorithm="RS256")
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))["access_token"]


VERTEX_STAGE = {"GA": "ga", "PUBLIC_PREVIEW": "preview", "EXPERIMENTAL": "experimental"}


def list_vertex(sa_path):
    token = vertex_token(sa_path)
    out = []
    page = None
    while True:
        # **是 v1beta1 的全域端點。** 2026-09-21 逐一實測四種寫法：
        #   aiplatform.googleapis.com/v1beta1/publishers/google/models          可用
        #   us-central1-aiplatform.googleapis.com/v1beta1/publishers/...        可用但清單是該區的工具型模型
        #   同兩個端點的 /v1/ 版本、以及帶 projects/{p}/locations/{loc} 的寫法   全部 404
        url = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=200"
        if page:
            url += "&pageToken=" + page
        d = get_json(url, {"Authorization": "Bearer " + token})
        for m in d.get("publisherModels", []):
            # publishers/google/models/gemini-3.1-flash-lite → gemini-3.1-flash-lite
            mid = m.get("name", "").rsplit("/", 1)[-1]
            group, tags = classify_by_name(mid)
            if group == G_TEXT:
                tags = tags + [T_VISION]
            out.append(rec(mid, group, tags,
                           stage=VERTEX_STAGE.get(m.get("launchStage", ""), "")))
        page = d.get("nextPageToken")
        if not page:
            break
    return out


def provider_of(env_name):
    if env_name.startswith("GEMINI_"):
        return "gemini"
    if env_name.startswith("GROQ_"):
        return "groq"
    return {
        "OPENROUTER_API_KEY": "openrouter",
        "OPENAI_API_KEY": "openai",
        "ANTHROPIC_API_KEY": "anthropic",
        "DEEPSEEK_API_KEY": "deepseek",
        "XAI_API_KEY": "xai",
    }.get(env_name)


FETCHERS = {
    "gemini": list_gemini,
    "groq": lambda k: list_openai_like(k, "https://api.groq.com/openai/v1/models"),
    "openrouter": lambda k: list_openai_like(k, "https://openrouter.ai/api/v1/models"),
    "openai": lambda k: list_openai_like(k, "https://api.openai.com/v1/models"),
    "anthropic": list_anthropic,
    "deepseek": lambda k: list_openai_like(k, "https://api.deepseek.com/models"),
    "xai": lambda k: list_openai_like(k, "https://api.x.ai/v1/models"),
}


def cross_reference_expiry(providers):
    """OpenRouter 是唯一會講到期日的一家；同名模型借它的日期當參考。

    例：OpenRouter 說 google/gemini-2.5-flash 2026-10-20 到期，
    Gemini API 與 Vertex 上的 gemini-2.5-flash 就標「OpenRouter 宣告 10-20 到期」。
    這是**交叉參考不是原廠公告**，所以另存 expiresFrom，介面要照實說是誰講的。
    """
    hints = {}
    for m in providers.get("openrouter", {}).get("meta", {}).values():
        if not m.get("expires"):
            continue
        base = m["id"].rsplit("/", 1)[-1]  # google/gemini-2.5-flash → gemini-2.5-flash
        # 同一個型號在不同轉售商可能有不同日期，取最早的那個
        if base not in hints or m["expires"] < hints[base]:
            hints[base] = m["expires"]
    for prov, data in providers.items():
        if prov == "openrouter":
            continue
        for mid, m in data.get("meta", {}).items():
            if m.get("expires"):
                continue
            base = mid.rsplit("/", 1)[-1]
            if base in hints:
                m["expires"] = hints[base]
                m["expiresFrom"] = "openrouter"


def main():
    dry = "--dry-run" in sys.argv
    env = env_pairs()
    keys = {}
    providers = {}

    def absorb(prov, entry):
        p = providers.setdefault(prov, {"models": set(), "meta": {}})
        for m in entry["_meta"]:
            p["models"].add(m["id"])
            p["meta"].setdefault(m["id"], m)

    for name, value in sorted(env.items()):
        prov = provider_of(name)
        if not prov or not value:
            continue
        entry = {"provider": prov, "ok": False, "count": 0, "models": [], "error": None, "_meta": []}
        try:
            got = FETCHERS[prov](value)
            uniq = {}
            for m in got:
                uniq.setdefault(m["id"], m)
            models = sorted(uniq)
            entry.update(ok=True, count=len(models), models=models)
            entry["_meta"] = [uniq[m] for m in models]
            log("%s（%s）：%d 個模型" % (name, prov, len(models)))
        except Exception as e:
            entry["error"] = err_text(e)
            log("%s（%s）：失敗 %s" % (name, prov, entry["error"]))
        keys[name] = entry
        if entry["ok"]:
            absorb(prov, entry)

    # Vertex 走服務帳戶，不是 .env 裡的金鑰，但同樣要盤。
    # 找不到檔案時也要留下這一筆（error 有值），否則介面會以為「沒有這個來源」而不是「查不到」。
    if True:
        entry = {"provider": "vertex", "ok": False, "count": 0, "models": [], "error": None, "_meta": []}
        try:
            if not os.path.exists(SA_PATH):
                raise FileNotFoundError("找不到服務帳戶檔 " + SA_PATH)
            got = list_vertex(SA_PATH)
            uniq = {}
            for m in got:
                uniq.setdefault(m["id"], m)
            models = sorted(uniq)
            entry.update(ok=True, count=len(models), models=models)
            entry["_meta"] = [uniq[m] for m in models]
            log("VERTEX_SERVICE_ACCOUNT（vertex）：%d 個模型" % len(models))
        except Exception as e:
            entry["error"] = err_text(e)
            log("VERTEX_SERVICE_ACCOUNT（vertex）：失敗 %s" % entry["error"])
        keys["VERTEX_SERVICE_ACCOUNT"] = entry
        if entry["ok"]:
            absorb("vertex", entry)

    out_providers = {}
    for prov, p in providers.items():
        out_providers[prov] = {
            "count": len(p["models"]),
            "models": sorted(p["models"]),
            "meta": p["meta"],
        }
    cross_reference_expiry(out_providers)

    for k in keys.values():
        k.pop("_meta", None)

    doc = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "keys": keys,
        "providers": out_providers,
    }

    if dry:
        for prov, p in sorted(out_providers.items()):
            groups = {}
            for m in p["meta"].values():
                groups[m["group"]] = groups.get(m["group"], 0) + 1
            exp = [m for m in p["meta"].values() if m["expires"]]
            log("%s：%d 個，%s%s" % (
                prov, p["count"],
                "／".join("%s %d" % (g, c) for g, c in sorted(groups.items(), key=lambda t: -t[1])),
                ("，有到期日 %d 個" % len(exp)) if exp else ""))
        return 0

    os.makedirs(SPOOL, exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, OUT)
    os.chmod(OUT, 0o644)
    log("已寫入 %s（%d 把金鑰、%d 家供應商）" % (OUT, len(keys), len(out_providers)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

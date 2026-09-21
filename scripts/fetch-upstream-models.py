#!/usr/bin/env python3
"""抓「每一把上游金鑰實際能用哪些模型」，寫成 spool/upstream-keys/_models.json。

為什麼要有這支（2026-09-21，User：「有的模型會過時，就像 gemini 2.5 系列的即將要全部停用了，
我要避免用到」）：儀表板**刻意沒有掛 .env**，容器裡一把上游金鑰都沒有，所以它自己問不到
供應商「這把金鑰能用什麼」。沿用 _tails.json 的既有分工：主機端讀 .env、去問供應商，
只把**模型名稱**寫進 spool，儀表板讀檔顯示。金鑰值一個位元組都不會離開主機。

輸出格式（不含任何金鑰值）：
  {"fetchedAt": ISO8601,
   "keys": {"<環境變數名>": {"provider","ok","count","models":[...],"error"}},
   "providers": {"<供應商>": {"count","models":[...]}}}   # 同一家多把金鑰的聯集

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


# ── 各家的「列出模型」端點，回傳模型名稱清單 ──
def list_gemini(key):
    names = []
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
    while url:
        d = get_json(url, {"x-goog-api-key": key})
        for m in d.get("models", []):
            n = m.get("name", "")
            if n.startswith("models/"):
                n = n[len("models/"):]
            methods = m.get("supportedGenerationMethods") or []
            # 只留能生成內容的；嵌入模型另有用途，列進來只會混淆
            if not methods or "generateContent" in methods:
                names.append(n)
        tok = d.get("nextPageToken")
        url = ("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&pageToken=" + tok) if tok else None
    return names


def list_openai_like(key, url):
    d = get_json(url, {"Authorization": "Bearer " + key})
    return [m.get("id", "") for m in d.get("data", []) if m.get("id")]


def list_anthropic(key):
    d = get_json("https://api.anthropic.com/v1/models?limit=100",
                 {"x-api-key": key, "anthropic-version": "2023-06-01"})
    return [m.get("id", "") for m in d.get("data", []) if m.get("id")]


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


def list_vertex(sa_path):
    token = vertex_token(sa_path)
    names = []
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
            names.append(m.get("name", "").rsplit("/", 1)[-1])
        page = d.get("nextPageToken")
        if not page:
            break
    return names


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


def main():
    dry = "--dry-run" in sys.argv
    env = env_pairs()
    keys = {}
    providers = {}

    for name, value in sorted(env.items()):
        prov = provider_of(name)
        if not prov or not value:
            continue
        entry = {"provider": prov, "ok": False, "count": 0, "models": [], "error": None}
        try:
            models = sorted(set(FETCHERS[prov](value)))
            entry.update(ok=True, count=len(models), models=models)
            log("%s（%s）：%d 個模型" % (name, prov, len(models)))
        except Exception as e:
            entry["error"] = err_text(e)
            log("%s（%s）：失敗 %s" % (name, prov, entry["error"]))
        keys[name] = entry
        if entry["ok"]:
            providers.setdefault(prov, set()).update(entry["models"])

    # Vertex 走服務帳戶，不是 .env 裡的金鑰
    ventry = {"provider": "vertex", "ok": False, "count": 0, "models": [], "error": None}
    try:
        if not os.path.exists(SA_PATH):
            raise FileNotFoundError("找不到服務帳戶檔 " + SA_PATH)
        models = sorted(set(list_vertex(SA_PATH)))
        ventry.update(ok=True, count=len(models), models=models)
        log("Vertex 服務帳戶：%d 個模型" % len(models))
    except Exception as e:
        ventry["error"] = err_text(e)
        log("Vertex 服務帳戶：失敗 %s" % ventry["error"])
    keys["VERTEX_SERVICE_ACCOUNT"] = ventry
    if ventry["ok"]:
        providers.setdefault("vertex", set()).update(ventry["models"])

    payload = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "keys": keys,
        "providers": {p: {"count": len(s), "models": sorted(s)} for p, s in providers.items()},
    }
    if dry:
        log("dry-run，不寫檔。供應商統計："
            + "、".join("%s %d" % (p, v["count"]) for p, v in payload["providers"].items()))
        return 0

    os.makedirs(SPOOL, exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    os.chmod(OUT, 0o644)   # 不含金鑰；儀表板容器要讀得到
    log("已寫入 " + OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

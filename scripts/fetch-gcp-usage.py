#!/usr/bin/env python3
"""
把 GCP Vertex AI 的用量抓進 CostScale。

**這是專案層的總量，含經過閘道的那一部分**（閘道的 vertex_project 就是同一個
your-gcp-project），不是只有直連。原本的註解寫「沒有經過閘道那部分」是錯的，
2026-08-25 實測更正：直連量＝本表總量 − LiteLLM 的 vertex_ai 用量。

用 Cloud Monitoring 的 publisher 計量，取每日每模型的呼叫次數與 token，
並依 type 標籤分開輸入與輸出，再用閘道的價目表換算金額，
寫入 costscale.gcp_usage。重跑同一天會覆蓋，不會重複累加。

需要服務帳戶具備 roles/monitoring.viewer。
"""
import base64
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

SA_PATH = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "/root/vertex-sa.json")
PROJECT = os.environ.get("GCP_PROJECT", "your-gcp-project")
DAYS = int(os.environ.get("GCP_FETCH_DAYS", "7"))
DSN = os.environ["DATABASE_URL"]
LITELLM_URL = os.environ.get("LITELLM_BASE_URL", "http://litellm:4000")
LITELLM_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

TOKEN_METRIC = "publisher/online_serving/token_count"
CALL_METRIC = "publisher/online_serving/model_invocation_count"


def access_token(sa: dict) -> str:
    def b64(x: bytes) -> bytes:
        return base64.urlsafe_b64encode(x).rstrip(b"=")

    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claim = b64(json.dumps({
        "iss": sa["client_email"],
        "scope": "https://www.googleapis.com/auth/monitoring.read",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now, "exp": now + 3600,
    }).encode())
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = b64(key.sign(header + b"." + claim, padding.PKCS1v15(), hashes.SHA256()))
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": (header + b"." + claim + b"." + sig).decode(),
    }).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token", data=body, timeout=30) as r:
        return json.load(r)["access_token"]


def fetch_series(token: str, metric: str, start, end, group_by_type: bool, align: int = 86400):
    """回傳 [(model, date, type, 值)]；group_by_type=False 時 type 為 None

    align 是 alignmentPeriod 的秒數。Cloud Monitoring 的分桶是**從 endTime 往回推**
    （2026-08-25 實測，見第六十節），所以呼叫端必須自己把 endTime 對齊到 UTC 午夜，
    否則分桶會跟著執行時刻漂移。日期取 startTime 那一端。
    """
    fields = ["resource.label.model_user_id"]
    if group_by_type:
        fields.append("metric.label.type")
    query = [
        ("filter", f'metric.type = "aiplatform.googleapis.com/{metric}"'),
        ("interval.startTime", start.strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("interval.endTime", end.strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("aggregation.alignmentPeriod", f"{align}s"),
        ("aggregation.perSeriesAligner", "ALIGN_SUM"),
        ("aggregation.crossSeriesReducer", "REDUCE_SUM"),
    ]
    query += [("aggregation.groupByFields", f) for f in fields]
    url = (f"https://monitoring.googleapis.com/v3/projects/{PROJECT}/timeSeries?"
           + urllib.parse.urlencode(query))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)

    out = []
    for series in data.get("timeSeries", []):
        model = series.get("resource", {}).get("labels", {}).get("model_user_id") or "(未標示)"
        ttype = series.get("metric", {}).get("labels", {}).get("type") if group_by_type else None
        for point in series.get("points", []):
            # 取 startTime 那一端：分桶 [D 00:00, D+1 00:00) 屬於 D。
            # 原本取 endTime，整批資料會被標晚一天（2026-08-25 查出並修正）。
            day = point["interval"]["startTime"][:10]
            val = point["value"].get("int64Value") or point["value"].get("doubleValue") or 0
            out.append((model, day, ttype, int(float(val))))
    return out


def price_table() -> dict:
    """向閘道取價目表：{模型名: (輸入單價, 輸出單價)}。取不到就回空字典，金額留 0。"""
    if not LITELLM_KEY:
        return {}
    try:
        req = urllib.request.Request(
            f"{LITELLM_URL}/model/info",
            headers={"Authorization": f"Bearer {LITELLM_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        print(f"警告：取不到閘道價目表（{err}），金額欄位將留 0")
        return {}

    rows = data.get("data") if isinstance(data, dict) else data
    table = {}
    for m in rows or []:
        info = m.get("model_info") or {}
        ic, oc = info.get("input_cost_per_token"), info.get("output_cost_per_token")
        if not (ic or oc):
            continue
        # 用底層模型名建索引（vertex_ai/gemini-2.5-flash → gemini-2.5-flash），
        # GCP 監控回報的是底層模型名，不是閘道自訂的部署名稱
        raw = (m.get("litellm_params") or {}).get("model") or m.get("model_name") or ""
        base = raw.split("/")[-1]
        table.setdefault(base, (float(ic or 0), float(oc or 0)))
    return table


def main() -> int:
    import psycopg

    sa = json.load(open(SA_PATH, encoding="utf-8"))
    token = access_token(sa)
    prices = price_table()

    # 分兩段查，兩段都把 endTime 釘在確定的邊界上：
    #   1. 完整日：end 是今日 UTC 午夜，alignmentPeriod 86400 秒 → 精準的午夜分桶。
    #   2. 今日：end 是現在，alignmentPeriod 取「午夜到現在」的秒數 → 剛好一桶。
    # 不能只用一次 start=now-Nd／end=now，那樣分桶會跟著執行時刻漂移。
    now = datetime.datetime.now(datetime.timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((now - midnight).total_seconds())

    windows = [(midnight - datetime.timedelta(days=DAYS), midnight, 86400)]
    if elapsed >= 60:
        # 剛過午夜那幾十秒不查，alignmentPeriod 太小會被 API 打回。
        windows.append((midnight, now, elapsed))

    merged: dict = {}
    for w_start, w_end, w_align in windows:
        for model, day, ttype, val in fetch_series(token, TOKEN_METRIC, w_start, w_end, True, w_align):
            row = merged.setdefault((model, day), {"invocations": 0, "input": 0, "output": 0})
            if ttype == "input":
                row["input"] += val
            elif ttype == "output":
                row["output"] += val
        for model, day, _t, val in fetch_series(token, CALL_METRIC, w_start, w_end, False, w_align):
            row = merged.setdefault((model, day), {"invocations": 0, "input": 0, "output": 0})
            row["invocations"] += val

    if not merged:
        print("沒有取得任何資料（可能是這段期間沒有 Vertex 用量）")
        return 0

    priced = 0
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        for (model, day), v in merged.items():
            ic, oc = prices.get(model, (0.0, 0.0))
            cost = v["input"] * ic + v["output"] * oc
            if ic or oc:
                priced += 1
            cur.execute("""
                INSERT INTO costscale.gcp_usage
                    (project_id, model, day, invocations, tokens,
                     input_tokens, output_tokens, est_cost, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (project_id, model, day) DO UPDATE
                SET invocations   = EXCLUDED.invocations,
                    tokens        = EXCLUDED.tokens,
                    input_tokens  = EXCLUDED.input_tokens,
                    output_tokens = EXCLUDED.output_tokens,
                    est_cost      = EXCLUDED.est_cost,
                    fetched_at    = now()
            """, (PROJECT, model, day, v["invocations"], v["input"] + v["output"],
                  v["input"], v["output"], round(cost, 8)))
        conn.commit()

    print(f"已寫入 {len(merged)} 筆（模型 × 日期），其中 {priced} 筆有價目可換算，期間 {DAYS} 天")
    return 0


if __name__ == "__main__":
    sys.exit(main())

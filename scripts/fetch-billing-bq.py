#!/usr/bin/env python3
"""
把兩本帳的 BigQuery 帳單匯出抓進 CostScale 的 costscale.billing_daily。

兩本帳（2026-08-20 啟用匯出，2026-08-21 查證資料已落地）：
  vertex    vertex-billing 的帳單帳戶 XXXXXX-XXXXXX-XXXXXX，表在 your-gcp-project
  aistudio  aistudio-billing  的帳單帳戶 YYYYYY-YYYYYY-YYYYYY，表在 your-aistudio-project

歸屬邏輯是兩套，不是一套：
  Vertex 那份的列帶 client_id／feature 標籤（實查 959/1042 有 client_id），照標籤歸戶。
  AI Studio 那份沒有任何自訂標籤（labels 是 Vertex 專屬），只能靠 project.id 歸戶。

用服務帳戶 costscale-sa@your-gcp-project 讀兩邊，需 BigQuery 資料檢視者與工作使用者。
跨帳號授權已於 2026-08-20 完成，2026-08-21 實測兩張表都讀得到。

沒有用 google-cloud-bigquery 套件：VPS 上沒裝，而手簽 JWT 打 REST 這條路
fetch-gcp-usage.py 已經跑了一個月，沿用同一套比多帶一個相依穩。
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
DSN = os.environ["DATABASE_URL"]
# 跑查詢的計費專案。服務帳戶的「工作使用者」權限在這個專案上。
JOB_PROJECT = os.environ.get("BQ_JOB_PROJECT", "your-gcp-project")
# 預設 45 天。不是 7 天——匯出還在回填，窗口太窄會漏掉正在補進來的舊資料。
DAYS = int(os.environ.get("BILLING_FETCH_DAYS", "45"))

VERTEX_TABLE = os.environ.get(
    "BQ_TABLE_VERTEX",
    "your-gcp-project.billing_export.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX")
AISTUDIO_TABLE = os.environ.get(
    "BQ_TABLE_AISTUDIO",
    "your-aistudio-project.billing_export.gcp_billing_export_v1_YYYYYY_YYYYYY_YYYYYY")

UNLABELED = "(未標示)"

# 發票層級的列。它與明細列是同一筆錢的兩種表示，一起加會灌水。
# 實查：Billing Adjustment (Standalone) 476 元、Tax (Standalone) 24 元，project.id 為 NULL。
EXCLUDED_SERVICES = ("Invoice",)

SOURCES = [
    # (來源代號, 資料表, 歸戶欄位的 SQL 運算式)
    ("vertex", VERTEX_TABLE,
     "IFNULL((SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'client_id'), @unlabeled)"),
    # AI Studio 那份沒有自訂標籤，歸戶只能退回專案。
    ("aistudio", AISTUDIO_TABLE,
     "IFNULL(project.id, @unlabeled)"),
]


def access_token(sa: dict) -> str:
    def b64(x: bytes) -> bytes:
        return base64.urlsafe_b64encode(x).rstrip(b"=")

    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claim = b64(json.dumps({
        "iss": sa["client_email"],
        "scope": "https://www.googleapis.com/auth/bigquery.readonly",
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


def query(token: str, sql: str, params: dict) -> list:
    """跑一次同步查詢，回傳 [dict]。參數一律走 queryParameters，不做字串拼接。"""
    qp = []
    for name, value in params.items():
        kind = "INT64" if isinstance(value, int) else "STRING"
        qp.append({
            "name": name,
            "parameterType": {"type": kind},
            "parameterValue": {"value": str(value)},
        })
    body = json.dumps({
        "query": sql,
        "useLegacySql": False,
        "timeoutMs": 120000,
        "parameterMode": "NAMED",
        "queryParameters": qp,
    }).encode()
    req = urllib.request.Request(
        "https://bigquery.googleapis.com/bigquery/v2/projects/%s/queries" % JOB_PROJECT,
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    if not data.get("jobComplete", False):
        raise RuntimeError("BigQuery 查詢逾時未完成，請調高 timeoutMs 後重試")
    cols = [f["name"] for f in data.get("schema", {}).get("fields", [])]
    out = []
    for row in data.get("rows", []):
        out.append({c: f.get("v") for c, f in zip(cols, row["f"])})
    return out


def fetch_source(token: str, source: str, table: str, client_expr: str) -> tuple:
    """回傳 (逐日費用列, 水位 dict, 被排除的金額)。"""
    excluded = ", ".join("'" + s + "'" for s in EXCLUDED_SERVICES)

    rows = query(token, """
        SELECT
          FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time))      AS day,
          IFNULL(project.id, @unlabeled)                       AS project_id,
          {client_expr}                                        AS client_id,
          service.description                                  AS service,
          sku.description                                      AS sku,
          currency                                             AS currency,
          SUM(cost)                                            AS gross,
          SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credit,
          -- usage.amount 對 token 類的 SKU 就是 token 數。
          -- usage.unit 字面上寫 "requests"，但那是 Google 對「可計費單位個數」的統稱：
          -- 「Gemini 3.1 Flash Lite Global Text Input」30 天 1,140 萬，
          -- 同期實際請求只有一千多次，顯然不是請求數
          --（2026-08-23 實測，與 Cloud Monitoring 的 token_count 量級吻合）。
          -- 這是 AI Studio 那本帳唯一拿得到 token 數的地方——它沒有 Vertex 那種
          -- aiplatform 指標，而服務帳戶也只在 Vertex 專案裡有 Monitoring 權限。
          SUM(IFNULL(usage.amount, 0))                                  AS usage_amount,
          ANY_VALUE(usage.unit)                                         AS usage_unit
        FROM `{table}`
        WHERE service.description NOT IN ({excluded})
          AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
        GROUP BY day, project_id, client_id, service, sku, currency
    """.replace("{client_expr}", client_expr)
       .replace("{table}", table)
       .replace("{excluded}", excluded),
       {"unlabeled": UNLABELED, "days": DAYS})

    # 水位不加天數限制：要看的是整張表補到哪裡，不是這次抓取的窗口。
    state = query(token, """
        SELECT
          FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', MAX(export_time)) AS max_export_time,
          FORMAT_DATE('%Y-%m-%d', MAX(DATE(usage_start_time)))    AS max_usage_day,
          COUNT(*)                                                AS rows_seen
        FROM `{table}`
    """.replace("{table}", table), {})[0]

    # 排除掉的金額要報出來。靜默排除等於把「排錯了」藏起來，
    # 下次總額對不上時沒有人查得到是這裡少的。
    dropped = query(token, """
        SELECT IFNULL(SUM(cost), 0) AS gross
        FROM `{table}`
        WHERE service.description IN ({excluded})
          AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
    """.replace("{table}", table).replace("{excluded}", excluded),
       {"days": DAYS})[0]

    return rows, state, float(dropped["gross"] or 0)


def main() -> int:
    import psycopg

    sa = json.load(open(SA_PATH, encoding="utf-8"))
    token = access_token(sa)

    collected = []
    states = []
    for source, table, client_expr in SOURCES:
        try:
            rows, state, dropped = fetch_source(token, source, table, client_expr)
        except urllib.error.HTTPError as err:
            # 一本帳讀不到不該讓另一本也停掉。兩份是分開的帳戶、分開的授權。
            detail = err.read().decode("utf-8", "replace")[:300]
            print("警告：%s 讀取失敗 HTTP %s：%s" % (source, err.code, detail))
            continue
        print("%s：取得 %d 列，資料補到 %s，匯出最後寫入 %s，排除發票層級 %.2f"
              % (source, len(rows), state["max_usage_day"],
                 state["max_export_time"], dropped))
        for r in rows:
            r["source"] = source
        collected.extend(rows)
        state["source"] = source
        state["excluded_gross"] = dropped
        states.append(state)

    if not states:
        print("錯誤：兩本帳都讀不到，沒有寫入任何資料")
        return 1

    currencies = {r["currency"] for r in collected}
    if currencies - {"TWD"}:
        # 幣別若變動，下游把它當台幣加總就會錯得很難看，寧可吵一次。
        print("警告：出現非 TWD 幣別 %s，billing_daily 的金額不再是同一種幣，"
              "下游加總前必須先分幣別" % sorted(currencies))

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        for r in collected:
            gross = float(r["gross"] or 0)
            credit = float(r["credit"] or 0)
            cur.execute("""
                INSERT INTO costscale.billing_daily
                    (source, day, project_id, client_id, service, sku, currency,
                     gross, credit, net, usage_amount, usage_unit, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (source, day, project_id, client_id, service, sku) DO UPDATE
                SET currency     = EXCLUDED.currency,
                    gross        = EXCLUDED.gross,
                    credit       = EXCLUDED.credit,
                    net          = EXCLUDED.net,
                    usage_amount = EXCLUDED.usage_amount,
                    usage_unit   = EXCLUDED.usage_unit,
                    fetched_at   = now()
            """, (r["source"], r["day"], r["project_id"], r["client_id"],
                  r["service"], r["sku"], r["currency"],
                  round(gross, 6), round(credit, 6), round(gross + credit, 6),
                  round(float(r["usage_amount"] or 0), 6), r["usage_unit"]))

        for s in states:
            cur.execute("""
                INSERT INTO costscale.billing_export_state
                    (source, max_export_time, max_usage_day, rows_seen, excluded_gross, fetched_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (source) DO UPDATE
                SET max_export_time = EXCLUDED.max_export_time,
                    max_usage_day   = EXCLUDED.max_usage_day,
                    rows_seen       = EXCLUDED.rows_seen,
                    excluded_gross  = EXCLUDED.excluded_gross,
                    fetched_at      = now()
            """, (s["source"], s["max_export_time"], s["max_usage_day"],
                  int(s["rows_seen"] or 0), round(float(s["excluded_gross"]), 6)))
        conn.commit()

    total_gross = sum(float(r["gross"] or 0) for r in collected)
    total_net = sum(float(r["gross"] or 0) + float(r["credit"] or 0) for r in collected)
    print("已寫入 %d 列，窗口 %d 天，原價合計 %.2f、抵免後 %.2f（TWD）"
          % (len(collected), DAYS, total_gross, total_net))

    cutoff = str(datetime.date.today() - datetime.timedelta(days=3))
    stale = [s["source"] for s in states
             if s["max_usage_day"] and s["max_usage_day"] < cutoff]
    if stale:
        print("注意：%s 的資料只補到三天前以外，介面顯示的本月花費會偏低，"
              "這是匯出尚未追上，不是花費減少" % ", ".join(stale))
    return 0


if __name__ == "__main__":
    sys.exit(main())

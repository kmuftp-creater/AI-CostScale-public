#!/usr/bin/env python3
"""
把訂閱的剩餘額度抓進 costscale.sub_usage。

資料鏈：
  ChatGPT 用量端點 ─▶ 家機的橋接 /usage ─SSH 隧道─▶ VPS ─▶ 本腳本 ─▶ 資料庫

為什麼不由儀表板直接打橋接：那會讓總覽頁的載入時間綁在隧道通不通上，
家機關機時整頁變慢或報錯。走「腳本寫資料庫、介面讀資料庫」與
fetch-gcp-usage.py 一致，家機離線時介面顯示的是最後一次抓到的值加上時間。

橋接那端只讀 auth.json、永不回寫——回寫會撞 refresh-token 重用偵測。
本腳本連 token 都碰不到，只拿到換算後的百分比。
"""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

DSN = os.environ["DATABASE_URL"]
# 10.87.213.1 是 costscale_default 網路上的 VPS 主機位址，
# 8788 是 SSH 反向隧道的轉發埠（見 bridge/supervisor.ps1）。
BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://10.87.213.1:8788")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")


def fetch() -> dict:
    req = urllib.request.Request(
        BRIDGE_URL.rstrip("/") + "/usage",
        headers={"Authorization": "Bearer " + BRIDGE_TOKEN},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def main() -> int:
    import psycopg

    if not BRIDGE_TOKEN:
        print("錯誤：未設定 BRIDGE_TOKEN")
        return 1

    try:
        data = fetch()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        # 家機關機、隧道斷掉都會走到這裡。這不是錯誤狀態，是常態的一種——
        # 保留資料庫裡上一次的值，介面靠 fetched_at 顯示它有多舊。
        print("橋接不通（%s），保留上一次抓到的值不動" % err)
        return 0

    rows = []
    for provider, info in data.items():
        if not info:
            print("%s：查不到用量（可能未登入或上游改格式）" % provider)
            continue
        for w in info.get("windows", []):
            reset_at = w.get("resetAt")
            rows.append((
                provider,
                w["label"],
                w.get("windowSeconds"),
                round(float(w["usedPercent"]), 2),
                round(float(w["remainingPercent"]), 2),
                datetime.datetime.fromtimestamp(reset_at, datetime.timezone.utc)
                if isinstance(reset_at, (int, float)) else None,
                info.get("plan") or None,
                bool(info.get("limitReached")),
            ))

    if not rows:
        print("沒有任何可寫入的額度資料")
        return 0

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        for r in rows:
            cur.execute("""
                INSERT INTO costscale.sub_usage
                    (provider, window_label, window_seconds, used_percent,
                     remaining_percent, reset_at, plan, limit_reached, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (provider, window_label) DO UPDATE
                SET window_seconds    = EXCLUDED.window_seconds,
                    used_percent      = EXCLUDED.used_percent,
                    remaining_percent = EXCLUDED.remaining_percent,
                    reset_at          = EXCLUDED.reset_at,
                    plan              = EXCLUDED.plan,
                    limit_reached     = EXCLUDED.limit_reached,
                    fetched_at        = now()
            """, r)
            # 歷史軌跡（D-3）：每次都寫，包含沒變化的點——
            # 沒變化本身就是速率資訊，只記變化點會讓平緩期算不出斜率。
            cur.execute("""
                INSERT INTO costscale.sub_usage_history
                    (provider, window_label, used_percent, remaining_percent, reset_at)
                VALUES (%s, %s, %s, %s, %s)
            """, (r[0], r[1], r[3], r[4], r[5]))
        # 逾期清理順手做，不另設排程。30 天足夠看趨勢，再久對預測沒有幫助。
        cur.execute(
            "DELETE FROM costscale.sub_usage_history WHERE fetched_at < now() - interval '30 days'"
        )
        conn.commit()

    for r in rows:
        print("%s %s：已用 %.0f%%，剩 %.0f%%%s"
              % (r[0], r[1], r[3], r[4], "（已達上限）" if r[7] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

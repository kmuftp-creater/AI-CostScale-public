#!/usr/bin/env python3
"""
抓當日 USD/TWD 匯率寫進 costscale.fx_rates，
並把「今天到期扣款」的訂閱用當天匯率凍結成一筆 subscription_charges。

來源選擇的實測結果（2026-08-21 於 VPS 實打）：
  台灣銀行牌告 CSV（rate.bot.com.tw/xrt/flcsv/0/day）
      本來是首選，但從 VPS 打會拿到機器人挑戰頁（Challenge Validation），
      不是匯率資料。這種頁面不該想辦法繞過，所以台銀不列入自動來源。
  open.er-api.com                主來源。免金鑰，每日更新，實測 TWD=31.862233
  fawazahmed0/currency-api       備援。免金鑰，走 jsDelivr，實測 TWD=31.836833
  api.exchangerate.host          已改為必須金鑰，排除
  frankfurter / ECB              清單裡沒有 TWD，排除

兩個來源實測相差 0.08%，可以互為備援。主來源失敗才用備援，
而且來源會寫進 fx_rates.source——換來源時匯率會有小跳動，
沒有這欄的話下次會被當成資料錯誤查半天。
"""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

DSN = os.environ["DATABASE_URL"]
BASE = "USD"
QUOTE = "TWD"

PRIMARY_URL = "https://open.er-api.com/v6/latest/USD"
FALLBACK_URL = ("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest"
                "/v1/currencies/usd.json")


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "ai-costscale/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch_rate() -> tuple:
    """回傳 (匯率, 來源代號)。兩個來源都失敗才拋例外。"""
    try:
        data = _get_json(PRIMARY_URL)
        if data.get("result") != "success":
            raise ValueError("open.er-api 回傳 result=%s" % data.get("result"))
        return float(data["rates"][QUOTE]), "open.er-api"
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError, json.JSONDecodeError) as err:
        print("警告：主來源失敗（%s），改用備援" % err)

    data = _get_json(FALLBACK_URL)
    return float(data["usd"][QUOTE.lower()]), "currency-api"


def main() -> int:
    import psycopg

    today = datetime.date.today()
    rate, source = fetch_rate()
    print("%s 匯率 1 %s = %.6f %s（來源 %s）" % (today, BASE, rate, QUOTE, source))

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO costscale.fx_rates (day, base, quote, rate, source, fetched_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (day, base, quote) DO UPDATE
            SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()
        """, (today, BASE, QUOTE, round(rate, 6), source))

        cur.execute("SELECT value FROM costscale.settings WHERE key = 'fx_markup_pct'")
        row = cur.fetchone()
        markup = float(row[0]) if row and row[0] else 0.0

        # 今天到期扣款的訂閱。billing_day 的約束是 1..28，
        # 所以不會有「31 號的訂閱遇到 2 月」這種月底邊界問題。
        cur.execute("""
            SELECT id, service, fee, currency, billing_cycle
              FROM costscale.subscriptions
             WHERE status = 'active'
               AND billing_day = EXTRACT(DAY FROM %s::date)
               AND (billing_cycle = 'monthly'
                    OR (billing_cycle = 'yearly'
                        AND billing_month = EXTRACT(MONTH FROM %s::date)))
        """, (today, today))
        due = cur.fetchall()

        frozen = 0
        for sub_id, service, fee, currency, cycle in due:
            fee = float(fee)
            if currency == QUOTE:
                # 本來就是台幣，不需要換匯也不該加手續費。
                used_rate, used_source, used_markup = 1.0, "n/a", 0.0
                amount = fee
            else:
                used_rate, used_source, used_markup = rate, source, markup
                amount = fee * rate * (1 + markup / 100.0)

            # ON CONFLICT DO NOTHING：同一天重跑不覆蓋已凍結的匯率。
            # 這是刻意的——凍結的意義就是寫進去之後不再變。
            cur.execute("""
                INSERT INTO costscale.subscription_charges
                    (sub_id, charged_on, fee, currency, fx_rate, fx_source, markup_pct, amount_twd)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (sub_id, charged_on) DO NOTHING
            """, (sub_id, today, round(fee, 6), currency, round(used_rate, 6),
                  used_source, round(used_markup, 3), round(amount, 2)))
            if cur.rowcount:
                frozen += 1
                print("  凍結 %s（%s）%s %s → NT$%.2f" % (service, cycle, currency, fee, amount))

        conn.commit()

    if due:
        print("今天到期 %d 筆，新凍結 %d 筆（其餘為先前已凍結，未覆寫）" % (len(due), frozen))
    else:
        print("今天沒有到期的訂閱扣款")
    return 0


if __name__ == "__main__":
    sys.exit(main())

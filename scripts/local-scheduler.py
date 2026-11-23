#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本機安裝模式的排程容器（取代雲端主機上的 cron）。

只做 INSTALL.md 第 7 節四支必要排程中「不需要操作 Docker」的兩支：
  1. 匯率抓取與訂閱月費入帳：直接呼叫既有的 scripts/fetch-fx.py（跟 run-fx-fetch.sh 跑的是同一支），每小時一次。
  2. 預算檢查：呼叫儀表板的 POST /api/budgets/check（跟 check-budgets.sh 打的是同一個端點），每小時一次。

另外兩支（apply-upstream-key.py 套用「新增上游金鑰」佇列、watchdog-litellm.sh 閘道看門狗）要操作 Docker，
本機模式不提供：這個容器不掛 Docker socket。

時程：容器啟動後 10 秒第一次抓匯率，120 秒（等儀表板起來）第一次檢查預算，之後各自每小時一次。
某一次失敗（網路不通、儀表板還沒好）時 5 分鐘後重試，不必等一小時。
每次執行都印一行結果到容器 log：  docker compose logs scheduler

環境變數（由 docker-compose.yml 的 scheduler 服務提供）：
  DATABASE_URL       給 fetch-fx.py
  ALERT_CRON_TOKEN   預算檢查的 Bearer token
  DASHBOARD_URL      預設 http://dashboard:3000
"""
import datetime
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

FX_SCRIPT = os.environ.get("FX_SCRIPT", "/scripts/fetch-fx.py")
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://dashboard:3000").rstrip("/")
TOKEN = os.environ.get("ALERT_CRON_TOKEN", "").strip()
INTERVAL = int(os.environ.get("SCHED_INTERVAL_SECONDS", "3600"))
RETRY = int(os.environ.get("SCHED_RETRY_SECONDS", "300"))
FX_FIRST = int(os.environ.get("SCHED_FX_FIRST_SECONDS", "10"))
BUDGET_FIRST = int(os.environ.get("SCHED_BUDGET_FIRST_SECONDS", "120"))
TAIPEI = datetime.timezone(datetime.timedelta(hours=8))

_stop = False


def _on_signal(signum, frame):
    global _stop
    _stop = True


def log(job, ok, msg):
    now = datetime.datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M:%S")
    print("%s [%s] %s：%s" % (now, job, "成功" if ok else "失敗", msg), flush=True)


def scrub(text):
    """log 不得出現連線字串裡的密碼與 token。"""
    dsn = os.environ.get("DATABASE_URL", "")
    m = re.match(r"^[a-z]+://[^:]+:([^@]+)@", dsn)
    if m and m.group(1):
        text = text.replace(m.group(1), "***")
    if TOKEN:
        text = text.replace(TOKEN, "***")
    return text


def run_fx():
    try:
        r = subprocess.run([sys.executable, "-u", FX_SCRIPT], capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        log("匯率", False, "fetch-fx.py 執行超過 300 秒，已中止")
        return False
    lines = [l.strip() for l in (r.stdout + "\n" + r.stderr).splitlines() if l.strip()]
    tail = scrub(" / ".join(lines[-2:])) if lines else "（沒有輸出）"
    log("匯率", r.returncode == 0, tail[:300])
    return r.returncode == 0


def run_budget():
    if not TOKEN or TOKEN.lower() == "placeholder" or TOKEN.lower().startswith("change-me"):
        log("預算", False, "ALERT_CRON_TOKEN 沒設或還是範本值，預算檢查端點會回 503。重新執行設定工具補上，再 docker compose up -d")
        return False
    req = urllib.request.Request(DASHBOARD_URL + "/api/budgets/check", method="POST", headers={"Authorization": "Bearer " + TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code, body = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code, body = e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log("預算", False, "連不上儀表板 %s（%s）" % (DASHBOARD_URL, getattr(e, "reason", e)))
        return False
    body = scrub(" ".join(body.split()))
    log("預算", code == 200, ("HTTP %d  %s" % (code, body))[:300])
    return code == 200


def main():
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    start = time.monotonic()
    jobs = {"fx": {"fn": run_fx, "due": start + FX_FIRST}, "budget": {"fn": run_budget, "due": start + BUDGET_FIRST}}
    print("排程容器啟動：匯率與訂閱入帳、預算檢查各每 %d 秒一次（失敗 %d 秒後重試）。" % (INTERVAL, RETRY), flush=True)
    while not _stop:
        now = time.monotonic()
        for j in jobs.values():
            if now >= j["due"]:
                try:
                    ok = j["fn"]()
                except Exception as e:  # 單一排程出錯不能讓整個容器結束
                    log("排程", False, scrub("未預期的錯誤：%s" % e))
                    ok = False
                j["due"] = time.monotonic() + (INTERVAL if ok else RETRY)
        for _ in range(5):
            if _stop:
                break
            time.sleep(1)
    print("排程容器收到停止訊號，結束。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# 預算檢查。由 cron 每小時呼叫，超標或接近上限時寫入告警並寄信。
# token 從 .env 讀，不寫進 crontab——crontab 任何登入者都看得到。
set -euo pipefail
cd /opt/costscale

TOKEN=$(grep -m1 '^ALERT_CRON_TOKEN=' .env | cut -d= -f2-)
# 儀表板的對外網址，與 docker-compose 的 AUTH_URL 同一個（例：https://cost.example.com）
BASE=$(grep -m1 '^AUTH_URL=' .env | cut -d= -f2-)
BASE=${BASE%/}
if [ -z "$TOKEN" ]; then
    echo "$(date '+%F %T') 未設定 ALERT_CRON_TOKEN，略過"
    exit 0
fi

RESP=$(curl -s -m 60 -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/budgets/check")
CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

if [ "$CODE" != "200" ]; then
    echo "$(date '+%F %T') HTTP $CODE  $BODY"
    exit 1
fi

# 只在有動作或有失敗時記錄，避免每小時一行把 log 灌爆。
if printf '%s' "$BODY" | grep -q '"newlyFired":0' && printf '%s' "$BODY" | grep -q '"failed":0'; then
    exit 0
fi
echo "$(date '+%F %T') $BODY"

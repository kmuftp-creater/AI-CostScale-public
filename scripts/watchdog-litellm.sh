#!/bin/bash
# 閘道看門狗：LiteLLM 容器失去健康時自動重啟。
#
# 為什麼需要：接上閘道的專案裡有付費核心功能（例如某個試穿專案的試穿）。
# 容器 restart 政策只處理「行程結束」，不處理「還活著但不健康」。
# 這支把後者也接住，縮短故障時間。專案端仍應保留自己的退路，
# 看門狗只是降低發生機率，不是替代品。
set -euo pipefail
cd /opt/costscale
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.vps.yml"
LOG=/var/log/costscale-watchdog.log

STATE=$(docker inspect --format '{{.State.Health.Status}}' costscale-litellm-1 2>/dev/null || echo "missing")

if [ "$STATE" = "healthy" ]; then
  exit 0
fi

# 不健康時先給一次寬限，避免啟動中或瞬時抖動就重啟
sleep 20
STATE=$(docker inspect --format '{{.State.Health.Status}}' costscale-litellm-1 2>/dev/null || echo "missing")
if [ "$STATE" = "healthy" ] || [ "$STATE" = "starting" ]; then
  exit 0
fi

echo "$(date '+%F %T') 閘道狀態為 $STATE，執行重啟" >> "$LOG"
$COMPOSE restart litellm >> "$LOG" 2>&1 || true
sleep 45
NEW=$(docker inspect --format '{{.State.Health.Status}}' costscale-litellm-1 2>/dev/null || echo "missing")
echo "$(date '+%F %T') 重啟後狀態：$NEW" >> "$LOG"

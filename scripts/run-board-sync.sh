#!/bin/bash
# 同步看板的 GitHub 側資料（Phase 5 A2 建，A3 改寫）
#
# 2026-08-22 起改成打儀表板的 API，不再自己跑 python：
# 介面的「重新整理」按鈕與這支排程要跑同一份實作，否則兩邊行為會漂移。
# 實作在 dashboard/lib/board-write.ts。
set -e
cd /opt/costscale
TOKEN=$(grep "^ALERT_CRON_TOKEN=" .env | cut -d= -f2-)
if [ -z "$TOKEN" ]; then
  echo "錯誤：.env 缺 ALERT_CRON_TOKEN"
  exit 1
fi
RESP=$(curl -s -m 600 -w '\n%{http_code}' -X POST -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:3300/api/board/sync || true)
CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')
echo "$BODY"
if [ "$CODE" = "200" ]; then
  exit 0
fi
# 沒設定 GitHub 權杖代表沒在用看板，是正常狀態，不算失敗
if printf '%s' "$BODY" | grep -q '未設定 GITHUB_TOKEN'; then
  exit 0
fi
echo "錯誤：看板同步失敗（HTTP ${CODE:-無回應}）" >&2
exit 1

#!/bin/bash
# 自助發放虛擬金鑰（給沒有瀏覽器工作階段的專案 AI 用）
#
# 儀表板發鑰要 Google 登入，專案 AI 沒有瀏覽器 session 走不了那條路。
# 這支腳本做的事跟儀表板「新增軟體」完全一樣：向閘道申請虛擬金鑰，
# 並登記進 costscale.apps，用量才會歸戶到該專案名下。
#
# 用法：
#   /opt/costscale/scripts/issue-key.sh <軟體名稱> [說明]
#   /opt/costscale/scripts/issue-key.sh <軟體名稱> --force    # 重發（撤銷舊鑰）
#
# 金鑰只會印出一次，請立刻存好。

set -euo pipefail

APP_NAME="${1:-}"
ARG2="${2:-}"
FORCE=0
DESCRIPTION=""

if [ -z "$APP_NAME" ]; then
  echo "用法：$0 <軟體名稱> [說明|--force]" >&2
  exit 1
fi
if [ "$ARG2" = "--force" ]; then
  FORCE=1
else
  DESCRIPTION="$ARG2"
fi

if ! printf '%s' "$APP_NAME" | grep -qE '^[a-zA-Z0-9._-]{1,60}$'; then
  echo "錯誤：軟體名稱只能用英數與 . _ -，長度 1 到 60。" >&2
  exit 1
fi

cd /opt/costscale

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.vps.yml"
MASTER_KEY=$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)
GATEWAY="http://127.0.0.1:4400"

psql_q() { $COMPOSE exec -T db psql -U costscale -d costscale -tAc "$1"; }

# 1. 這個軟體是否已經登記過
EXISTING=$(psql_q "SELECT COALESCE(vkey_id,'') FROM costscale.apps WHERE name = '${APP_NAME//\'/\'\'}'" || true)
EXISTING=$(printf '%s' "$EXISTING" | tr -d '[:space:]')

if [ -n "$EXISTING" ] && [ "$FORCE" -eq 0 ]; then
  echo "「$APP_NAME」已經有金鑰了（末四碼 ...${EXISTING: -4}）。"
  echo "金鑰無法重新取回；要重發請加 --force，舊鑰會被撤銷。"
  exit 2
fi

# 2. 重發：舊金鑰先改名讓出別名，**不要先撤銷**（2026-08-29 改）
#
# 原本這裡是「先撤舊的、再發新的」。兩個問題：
#   a. 發新的那一步失敗，這個軟體會變成一把金鑰都沒有，而舊的已經撤了救不回來。
#   b. LiteLLM 要求金鑰別名全站唯一，所以不讓出別名就發不出同名的新鑰。
# 儀表板的「重新簽發」2026-08-26 就已經改成「改名 → 發新 → 記帳 → 才撤舊」，
# 這支腳本漏了。現在補齊，順序與那邊一致。
RETIRED_ALIAS=""
if [ -n "$EXISTING" ] && [ "$FORCE" -eq 1 ]; then
  RETIRED_ALIAS="${APP_NAME}-retired-$(date +%s)"
  RENAME_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/key/update" \
    -H "Authorization: Bearer $MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"$EXISTING\",\"key_alias\":\"$RETIRED_ALIAS\"}" || true)
  if [ "$RENAME_CODE" = "404" ]; then
    # 資料庫指著一把閘道上已經不存在的 token——封存過、或人工撤銷過的軟體
    # 就是這個狀態。**沒有東西要讓出別名，也沒有東西要撤銷，直接往下發新的。**
    # 但那個舊 token 仍然要推進 retired_vkey_ids（第 4 步做），
    # 因為 SpendLogs 裡的歷史紀錄還指著它。
    echo "舊金鑰在閘道上已不存在（HTTP 404），略過改名與撤銷，直接發新的。"
    RETIRED_ALIAS=""
  elif [ "$RENAME_CODE" != "200" ]; then
    echo "舊金鑰改名失敗（HTTP $RENAME_CODE），什麼都沒變動。" >&2
    exit 1
  fi
fi

# 3. 向閘道申請新金鑰
RESP=$(curl -s -X POST "$GATEWAY/key/generate" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"key_alias\":\"$APP_NAME\",\"metadata\":{\"app\":\"$APP_NAME\"}}")

NEW_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("key",""))' 2>/dev/null || true)
TOKEN_ID=$(printf '%s' "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token") or d.get("token_id") or "")' 2>/dev/null || true)

if [ -z "$NEW_KEY" ]; then
  echo "發鑰失敗，閘道回應：" >&2
  printf '%s\n' "$RESP" | head -c 400 >&2
  # 發不出新的就把舊金鑰的別名改回去，不留半套狀態。舊鑰仍然有效。
  if [ -n "$RETIRED_ALIAS" ]; then
    curl -s -o /dev/null -X POST "$GATEWAY/key/update" \
      -H "Authorization: Bearer $MASTER_KEY" -H "Content-Type: application/json" \
      -d "{\"key\":\"$EXISTING\",\"key_alias\":\"$APP_NAME\"}" || \
      echo "　另外：舊金鑰的別名已改成 $RETIRED_ALIAS 且改不回來，需人工處理。" >&2
  fi
  exit 1
fi

# 4. 登記進 costscale.apps（用量歸戶靠這一步）
#
# **舊金鑰要推進 retired_vkey_ids**（2026-08-29 補）。歸戶是拿 apps.vkey_id
# 比對 LiteLLM_SpendLogs.api_key，換一把之後舊 token 的歷史紀錄還在、
# 但對不回任何軟體——**那個專案換鑰之前的花費會從排行榜消失、整批跑進「未歸戶」**，
# 數字加起來還是對的，只是歸錯地方，而且沒有任何錯誤訊息。
# 儀表板的「重新簽發」2026-08-26 就已經處理（第六十六節第四段），這支腳本漏了。
# 實例：app-c-probe 用 --force 重發兩次，19 筆紀錄裡只剩 2 筆對得回去。
#
# 新舊寫在同一句 SQL，避免中間掛掉變成「新金鑰生效但舊金鑰沒記下」——
# 那會讓歷史永久對不回來。
SAFE_NAME="${APP_NAME//\'/\'\'}"
SAFE_DESC="${DESCRIPTION//\'/\'\'}"
psql_q "INSERT INTO costscale.apps (name, description, vkey_id, status)
        VALUES ('$SAFE_NAME', NULLIF('$SAFE_DESC',''), '$TOKEN_ID', 'active')
        ON CONFLICT (name) DO UPDATE
        SET vkey_id = EXCLUDED.vkey_id,
            retired_vkey_ids = CASE
              WHEN NULLIF('$EXISTING','') IS NULL THEN costscale.apps.retired_vkey_ids
              WHEN '$EXISTING' = ANY(costscale.apps.retired_vkey_ids) THEN costscale.apps.retired_vkey_ids
              ELSE array_append(costscale.apps.retired_vkey_ids, '$EXISTING')
            END,
            description = COALESCE(EXCLUDED.description, costscale.apps.description),
            status = 'active'" > /dev/null

# 5. 套上模型白名單（2026-08-28 新增）
#
# 不套會怎樣：/key/generate 沒帶 models 時，LiteLLM 存的是**空陣列**，
# 而空陣列的語意是「全部放行」——新軟體一發鑰就打得到 sub-claude、
# sub-codex、sub-gemini、sub-imagegen，也就是 User 自己的訂閱額度，
# 完全繞過儀表板「應用程式」頁那一關訂閱授權。
# 實測確認：本腳本剛發的新鑰直打 sub-claude 回 200，/v1/models 也把四條
# 訂閱通道全列給它看。
#
# 訂閱通道不由本腳本開放。只帶該軟體在 app_subscriptions 裡「已經有的」授權，
# 新軟體那是空的；--force 重發時則不會把既有授權洗掉。
# 要新開放訂閱通道請走儀表板，那裡才有額度守門的配套。
SUBS=$(psql_q "SELECT COALESCE(string_agg(s.sub_model, ',' ORDER BY s.sub_model), '')
               FROM costscale.app_subscriptions s
               JOIN costscale.apps a ON a.id = s.app_id
               WHERE a.name = '$SAFE_NAME'" || true)
VERTEX_PT=$(psql_q "SELECT vertex_passthrough FROM costscale.apps WHERE name = '$SAFE_NAME'" || true)
MODEL_INFO=$(curl -s "$GATEWAY/model/info" -H "Authorization: Bearer $MASTER_KEY" || true)

ACL_BODY=$(printf '%s' "$MODEL_INFO" | \
  TOKEN_ID="$TOKEN_ID" SUBS="$SUBS" VERTEX_PT="$VERTEX_PT" python3 -c '
import sys, json, os
# 退路清單：閘道查不到部署名時用萬用樣式。**不可以給空陣列**——
# 空陣列會被 LiteLLM 當成「什麼都不准打」，等於把這個軟體直接鎖死。
FALLBACK = ["gemini-*", "groq-*", "openrouter*", "claude-sonnet-paid", "gpt-paid"]
try:
    d = json.load(sys.stdin)
    rows = d if isinstance(d, list) else (d.get("data") or [])
except Exception:
    rows = []
names = set()
for m in rows:
    n = (m or {}).get("model_name") or ""
    # 排除三種，規則要與 dashboard/lib/litellm.ts 的 listGatewayModelNames 一致：
    # 訂閱通道（要逐一授權）、萬用部署（列進白名單等於沒改）、
    # 以及 /model/info 把 gemini-* 展開成整套 Vertex 型錄的那些帶前綴的名字。
    if not n or n.startswith("sub-") or "*" in n or "/" in n:
        continue
    names.add(n)
out = sorted(names) if names else list(FALLBACK)
if (os.environ.get("VERTEX_PT") or "").strip() == "t":
    out.append("vertex_ai/*")
out += [s for s in (os.environ.get("SUBS") or "").strip().split(",") if s.strip()]
print(json.dumps({"key": os.environ["TOKEN_ID"], "models": out}))
' 2>/dev/null || true)

ACL_NOTE="已套上模型白名單"
if [ -z "$ACL_BODY" ]; then
  ACL_NOTE="！白名單沒套上（算不出清單）——這把金鑰現在打得到所有模型含訂閱通道，請到儀表板按「重新同步白名單」"
else
  ACL_RESP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/key/update" \
    -H "Authorization: Bearer $MASTER_KEY" -H "Content-Type: application/json" \
    -d "$ACL_BODY" || true)
  if [ "$ACL_RESP" = "200" ]; then
    psql_q "UPDATE costscale.apps SET acl_synced_at = now(), acl_error = NULL WHERE name = '$SAFE_NAME'" > /dev/null || true
  else
    ACL_NOTE="！白名單沒套上（/key/update 回 $ACL_RESP）——這把金鑰現在打得到所有模型含訂閱通道，請到儀表板按「重新同步白名單」"
    psql_q "UPDATE costscale.apps SET acl_error = '白名單推送失敗：HTTP $ACL_RESP' WHERE name = '$SAFE_NAME'" > /dev/null || true
  fi
fi

# 6. 最後才撤舊金鑰。撤不掉只是留下一把孤兒金鑰，不影響新金鑰可用——
#    順序反過來（先撤再發）才會出現「兩把都沒有」那種救不回來的狀態。
REVOKE_NOTE=""
if [ -n "$RETIRED_ALIAS" ]; then
  REVOKE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/key/delete" \
    -H "Authorization: Bearer $MASTER_KEY" -H "Content-Type: application/json" \
    -d "{\"key_aliases\":[\"$RETIRED_ALIAS\"]}" || true)
  if [ "$REVOKE_CODE" = "200" ]; then
    REVOKE_NOTE="舊金鑰已撤銷，歷史用量已記進 retired_vkey_ids 仍歸戶在「$APP_NAME」名下。"
  else
    REVOKE_NOTE="！舊金鑰撤銷失敗（HTTP $REVOKE_CODE），它仍然有效、別名為 $RETIRED_ALIAS，需人工撤銷。"
  fi
fi

echo
echo "════════════════════════════════════════════════════"
echo " 軟體：$APP_NAME"
echo " 虛擬金鑰（只顯示這一次，請立刻存好）："
echo
echo "   $NEW_KEY"
echo
echo " 用法："
echo "   Gemini 原生：${GATEWAY_PUBLIC_URL:-https://llm.example.com}"
echo "   OpenAI 相容：${GATEWAY_PUBLIC_URL:-https://llm.example.com}/v1"
echo
echo " 可用模型（即時查詢）："
echo "   curl -s ${GATEWAY_PUBLIC_URL:-https://llm.example.com}/v1beta/models"
echo "════════════════════════════════════════════════════"
echo
echo "已登記進儀表板的應用程式清單，用量會歸戶到「$APP_NAME」名下。"
echo "$ACL_NOTE。訂閱通道（sub-*）預設不開放，要開放請到儀表板「應用程式」頁授權。"
# 用 if 不用 `[ ... ] && echo`：這是最後一行，而 set -e 之下
# 條件為假會讓整支腳本以非零退出，看起來像發鑰失敗。
if [ -n "$REVOKE_NOTE" ]; then echo "$REVOKE_NOTE"; fi

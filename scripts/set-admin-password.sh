#!/bin/bash
# 設定（或更換）儀表板的管理員帳號與密碼。
#
# 用法（在安裝這個系統的主機上，以能寫 .env 的使用者執行）：
#   bash /opt/costscale/scripts/set-admin-password.sh
#
# 互動：問帳號（預設沿用 .env 現有的，沒有就是 admin）與密碼（輸入兩次、不顯示、至少 10 個字元）。
# 非互動：用環境變數 CS_ADMIN_USER、CS_ADMIN_PASSWORD（有 CS_ADMIN_PASSWORD 就不問）。
#   密碼放在環境變數時，用完要 unset，也不要直接打在命令列前面（會留在 shell 歷史）。
#
# 做的事：用 python3 的 hashlib.scrypt 算出密碼雜湊，只把「帳號」與「雜湊」寫進 .env 的
# AUTH_ADMIN_USER、AUTH_ADMIN_PASSWORD_HASH 兩行（已有就取代，其他行不動，權限維持 600）。
# .env 以「寫到同目錄的暫存檔、設好 600、再 mv 取代」的方式更新，中途失敗不會留下半份 .env。
# 密碼與雜湊都不會印到畫面。改完要執行腳本最後印出的 docker compose 指令（只重建儀表板），新設定才會生效。
#
# 雜湊格式：scrypt:<N>:<r>:<p>:<salt hex>:<雜湊 hex>，不含 $（docker compose 會把 $ 當變數替換）。
# 參數 N=16384、r=8、p=1、金鑰長度 32 位元組、salt 16 位元組亂數，要與
# dashboard/lib/admin-password.ts 的驗證端一致。
#
# 這個檔案也被 install.sh 用 source 載入（只用裡面的函式），所以最下面有「被載入時不執行」的判斷。

ADMIN_MIN_PASSWORD=10
ADMIN_MAX_PASSWORD=256
ADMIN_HELP_LAST_LINE=20

# 帳號：英數開頭，其餘英數與 . _ -，3 到 32 字元（要與 dashboard/lib/admin-password.ts 的 ADMIN_USER_PATTERN 一致）
admin_valid_user() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$ ]]; }
ADMIN_USER_RULE="只收英數與 . _ -，要以英數開頭，3 到 32 個字元"

# 祕密欄位的值是否等同「未設定」：空、只有空白、placeholder、change-me 或 sk-change-me 開頭（不分大小寫）。
# 要與 dashboard/lib/secret-check.ts 的 secretProblem 判斷一致。回傳 0 代表未設定。
secret_unset() {
  local v="${1:-}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v,,}"
  case "$v" in
    ""|placeholder|change-me*|sk-change-me*) return 0 ;;
  esac
  return 1
}

# AUTH_SECRET 至少要幾個字元（要與 dashboard/lib/secret-check.ts 的 MIN_AUTH_SECRET_LENGTH 一致）
AUTH_SECRET_MIN_LENGTH=32

# AUTH_SECRET 是否不能用：未設定，或去掉前後空白後短於 32 個字元。回傳 0 代表不能用。
auth_secret_bad() {
  local v="${1:-}"
  secret_unset "$v" && return 0
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  [ "${#v}" -lt "$AUTH_SECRET_MIN_LENGTH" ]
}

# 密碼：長度 10 到 256，不含換行與其他控制字元。回傳 0 合格；不合格時把原因寫進 ADMIN_PW_REASON
ADMIN_PW_REASON=""
admin_valid_password() {
  local pw="$1"
  if [ "${#pw}" -lt "$ADMIN_MIN_PASSWORD" ]; then
    ADMIN_PW_REASON="密碼至少要 ${ADMIN_MIN_PASSWORD} 個字元（現在 ${#pw} 個）"
    return 1
  fi
  if [ "${#pw}" -gt "$ADMIN_MAX_PASSWORD" ]; then
    ADMIN_PW_REASON="密碼最多 ${ADMIN_MAX_PASSWORD} 個字元"
    return 1
  fi
  if [[ "$pw" =~ [[:cntrl:]] ]]; then
    ADMIN_PW_REASON="密碼不能含換行或其他控制字元"
    return 1
  fi
  return 0
}

# 算雜湊。密碼經 stdin 傳給 python（printf 是 shell 內建，不會出現在 ps），結果印到 stdout。
# 用法：hash=$(admin_make_hash "$password")
admin_make_hash() {
  printf '%s' "$1" | python3 -I -c 'import hashlib, os, sys
pw = sys.stdin.buffer.read()
salt = os.urandom(16)
h = hashlib.scrypt(pw, salt=salt, n=16384, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
print("scrypt:16384:8:1:%s:%s" % (salt.hex(), h.hex()))'
}

# 雜湊格式是否合格（只看格式，不驗密碼）。install.sh 用它判斷 .env 裡是不是已經有可用的設定。
admin_hash_format_ok() { [[ "$1" =~ ^scrypt:(16384|32768|65536):[1-8]:[1-4]:[0-9a-f]{32,128}:[0-9a-f]{64}$ ]]; }

# 原子寫檔：執行 <指令...>，把它的標準輸出寫進與目標同目錄的暫存檔，設成 600，再 mv 取代目標。
# mv 在同一個檔案系統內是原子的，所以目標檔不是舊的完整內容，就是新的完整內容，不會有寫到一半的狀態。
# 任何一步失敗、或收到 INT／TERM／HUP，都會刪掉暫存檔；暫存檔一建立就是 600，不會有權限過寬的瞬間。
# 用法：admin_atomic_write <目標檔> <指令> [參數...]
admin_atomic_write() {
  local target="$1" tmp rc=1
  shift
  tmp=$(mktemp "$(dirname "$target")/.$(basename "$target").tmp.XXXXXX") || return 1
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'; exit 130" INT TERM HUP
  if chmod 600 "$tmp" && "$@" >"$tmp"; then
    # 目標已存在時，保留原本的擁有者（以 root 以外的使用者執行時才有差別）
    if [ -e "$target" ]; then chown --reference="$target" "$tmp" 2>/dev/null || true; fi
    if mv -f "$tmp" "$target"; then rc=0; fi
  fi
  [ "$rc" -eq 0 ] || rm -f "$tmp"
  trap - INT TERM HUP
  return "$rc"
}

# 印出「更新後的 .env 內容」：兩個欄位已有就取代那一行，沒有就附加在最後，其他行原樣保留。
# 用法：admin_env_render <.env 路徑> <帳號> <雜湊>
admin_env_render() {
  local f="$1" u="$2" h="$3" line seen_u=0 seen_h=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "AUTH_ADMIN_USER="* ]]; then
      if [ "$seen_u" -eq 0 ]; then printf 'AUTH_ADMIN_USER=%s\n' "$u" || return 1; fi
      seen_u=1
    elif [[ "$line" == "AUTH_ADMIN_PASSWORD_HASH="* ]]; then
      if [ "$seen_h" -eq 0 ]; then printf 'AUTH_ADMIN_PASSWORD_HASH=%s\n' "$h" || return 1; fi
      seen_h=1
    else
      printf '%s\n' "$line" || return 1
    fi
  done <"$f"
  if [ "$seen_u" -ne 1 ]; then printf 'AUTH_ADMIN_USER=%s\n' "$u" || return 1; fi
  if [ "$seen_h" -ne 1 ]; then printf 'AUTH_ADMIN_PASSWORD_HASH=%s\n' "$h" || return 1; fi
  return 0
}

# 把兩個欄位寫進 .env（原子寫入，權限 600）。
# 用法：admin_env_write <.env 路徑> <帳號> <雜湊>
admin_env_write() {
  admin_atomic_write "$1" admin_env_render "$1" "$2" "$3"
}

admin_env_value() { # admin_env_value <.env 路徑> <欄位>：沒有就印空字串
  local line
  line=$(grep -m1 "^$2=" "$1" 2>/dev/null || true)
  printf '%s' "${line#*=}"
}

admin_main() {
  set -Eeuo pipefail
  local here env_file user pw pw2 hash cur_user
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  env_file="${CS_ENV_FILE:-$here/.env}"

  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    sed -n "2,${ADMIN_HELP_LAST_LINE}p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
  fi
  if [ ! -f "$env_file" ]; then
    echo "找不到 $env_file。請先完成安裝（bash $here/scripts/install.sh），或把 .env 放回原位。" >&2
    exit 1
  fi
  if [ ! -w "$env_file" ] || [ ! -w "$(dirname "$env_file")" ]; then
    echo "沒有 $env_file 或它所在資料夾的寫入權限。請用 root 執行，或加上 sudo。" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "找不到 python3。請先安裝：apt-get install -y python3" >&2
    exit 1
  fi

  cur_user=$(admin_env_value "$env_file" AUTH_ADMIN_USER)
  [ -n "$cur_user" ] || cur_user="admin"

  if [ -n "${CS_ADMIN_PASSWORD:-}" ]; then
    # 非互動
    user="${CS_ADMIN_USER:-$cur_user}"
    pw="$CS_ADMIN_PASSWORD"
    # 讀進區域變數後就把環境變數拿掉，後面啟動的子行程（python 等）的環境裡不會再有密碼
    unset CS_ADMIN_PASSWORD
    admin_valid_user "$user" || { echo "帳號格式不對：${ADMIN_USER_RULE}。" >&2; exit 1; }
    admin_valid_password "$pw" || { echo "$ADMIN_PW_REASON。" >&2; exit 1; }
  else
    if [ ! -t 0 ]; then
      echo "標準輸入不是終端機，沒辦法問問題。要在腳本裡執行，請用環境變數 CS_ADMIN_USER、CS_ADMIN_PASSWORD 提供。" >&2
      exit 1
    fi
    while :; do
      read -r -p "管理員帳號（直接按 Enter 用 ${cur_user}）：" user || { echo "讀不到輸入。" >&2; exit 1; }
      [ -n "$user" ] || user="$cur_user"
      admin_valid_user "$user" && break
      echo "  帳號格式不對：${ADMIN_USER_RULE}。請再輸入一次。"
    done
    while :; do
      read -r -s -p "新密碼（至少 ${ADMIN_MIN_PASSWORD} 個字元，輸入時畫面不會顯示）：" pw || { echo "讀不到輸入。" >&2; exit 1; }
      echo
      if ! admin_valid_password "$pw"; then
        echo "  ${ADMIN_PW_REASON}。請再輸入一次。"
        continue
      fi
      read -r -s -p "再輸入一次新密碼：" pw2 || { echo "讀不到輸入。" >&2; exit 1; }
      echo
      if [ "$pw" != "$pw2" ]; then
        echo "  兩次輸入不一樣。請重新輸入。"
        continue
      fi
      break
    done
  fi

  hash=$(admin_make_hash "$pw")
  admin_hash_format_ok "$hash" || { echo "產生雜湊失敗（python3 的 hashlib.scrypt 沒有輸出預期的格式）。" >&2; exit 1; }
  admin_env_write "$env_file" "$user" "$hash" || { echo "寫入 $env_file 失敗，.env 沒有被更動。" >&2; exit 1; }

  echo "已更新 $env_file：管理員帳號是 ${user}，密碼已換成新的（密碼與雜湊都不會顯示在畫面上）。"
  echo "舊密碼的登入狀態會在新設定生效後一併失效。"
  if auth_secret_bad "$(admin_env_value "$env_file" AUTH_SECRET)"; then
    echo ""
    echo "注意：.env 的 AUTH_SECRET 是空的、還是範本預設值，或短於 ${AUTH_SECRET_MIN_LENGTH} 個字元。這時儀表板會拒絕所有登入，新密碼也登不進去。"
    echo "請先用 openssl rand -hex 32 產生一組亂數，填進 .env 的 AUTH_SECRET（等號後面），再執行下面那一行。"
  fi
  echo ""
  echo "還差一步：在 $here 執行下面這一行，新設定才會生效（restart 不會讀到新的 .env；這一行只重建儀表板，不會動到閘道）："
  echo "  cd $here && docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d dashboard"
}

# 被 source 載入時（install.sh、單元測試）不自動執行
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  admin_main "$@"
fi

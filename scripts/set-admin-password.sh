#!/bin/bash
# 設定（或更換）儀表板的管理員帳號與密碼。
#
# 用法（在安裝這個系統的主機上，以能寫 .env 的使用者執行）：
#   bash /opt/costscale/scripts/set-admin-password.sh
#
# 互動：問帳號（預設沿用 .env 現有的，沒有就是 admin）與密碼（輸入兩次、不顯示、至少 10 個字元）。
# 非互動：用環境變數 CS_ADMIN_USER、CS_ADMIN_PASSWORD（有 CS_ADMIN_PASSWORD 就不問）。
#
# 做的事：用 python3 的 hashlib.scrypt 算出密碼雜湊，只把「帳號」與「雜湊」寫進 .env 的
# AUTH_ADMIN_USER、AUTH_ADMIN_PASSWORD_HASH 兩行（已有就取代，其他行不動，權限維持 600）。
# 密碼與雜湊都不會印到畫面。改完要執行腳本最後印出的 docker compose 指令，新設定才會生效。
#
# 雜湊格式：scrypt:<N>:<r>:<p>:<salt hex>:<雜湊 hex>，不含 $（docker compose 會把 $ 當變數替換）。
# 參數 N=16384、r=8、p=1、金鑰長度 32 位元組、salt 16 位元組亂數，要與
# dashboard/lib/admin-password.ts 的驗證端一致。
#
# 這個檔案也被 install.sh 用 source 載入（只用裡面的函式），所以最下面有「被載入時不執行」的判斷。

ADMIN_MIN_PASSWORD=10
ADMIN_MAX_PASSWORD=256

# 帳號：英數與 . _ -，3 到 32 字元
admin_valid_user() { [[ "$1" =~ ^[A-Za-z0-9._-]{3,32}$ ]]; }

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

# 把兩個欄位寫進 .env：已有就取代那一行，沒有就附加在最後，其他行原樣保留，權限 600。
# 用法：admin_env_write <.env 路徑> <帳號> <雜湊>
admin_env_write() {
  local f="$1" u="$2" h="$3" tmp line seen_u=0 seen_h=0
  tmp=$(mktemp)
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "AUTH_ADMIN_USER="* ]]; then
      if [ "$seen_u" -eq 0 ]; then printf 'AUTH_ADMIN_USER=%s\n' "$u" >>"$tmp"; fi
      seen_u=1
    elif [[ "$line" == "AUTH_ADMIN_PASSWORD_HASH="* ]]; then
      if [ "$seen_h" -eq 0 ]; then printf 'AUTH_ADMIN_PASSWORD_HASH=%s\n' "$h" >>"$tmp"; fi
      seen_h=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$f"
  [ "$seen_u" -eq 1 ] || printf 'AUTH_ADMIN_USER=%s\n' "$u" >>"$tmp"
  [ "$seen_h" -eq 1 ] || printf 'AUTH_ADMIN_PASSWORD_HASH=%s\n' "$h" >>"$tmp"
  cat "$tmp" >"$f"
  rm -f "$tmp"
  chmod 600 "$f"
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
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
  fi
  if [ ! -f "$env_file" ]; then
    echo "找不到 $env_file。請先完成安裝（bash $here/scripts/install.sh），或把 .env 放回原位。" >&2
    exit 1
  fi
  if [ ! -w "$env_file" ]; then
    echo "沒有 $env_file 的寫入權限。請用 root 執行，或加上 sudo。" >&2
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
    admin_valid_user "$user" || { echo "帳號格式不對：只收英數與 . _ -，3 到 32 個字元。" >&2; exit 1; }
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
      echo "  帳號格式不對：只收英數與 . _ -，3 到 32 個字元。請再輸入一次。"
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
  admin_env_write "$env_file" "$user" "$hash"

  echo "已更新 $env_file：管理員帳號是 ${user}，密碼已換成新的（密碼與雜湊都不會顯示在畫面上）。"
  echo "舊密碼的登入狀態會在新設定生效後一併失效。"
  echo ""
  echo "還差一步：在 $here 執行下面這一行，新設定才會生效（restart 不會讀到新的 .env）："
  echo "  cd $here && docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d"
}

# 被 source 載入時（install.sh、單元測試）不自動執行
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  admin_main "$@"
fi

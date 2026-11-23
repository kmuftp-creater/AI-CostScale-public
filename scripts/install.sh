#!/bin/bash
# AI CostScale 互動式安裝腳本：把 INSTALL.md 第 1 到 7 節自動做完
#
# 用法（以 root 執行，程式碼要已經放在 /opt/costscale）：
#   bash /opt/costscale/scripts/install.sh
#   bash /opt/costscale/scripts/install.sh --help
#
# 設計原則：
#   - 可以重複執行。每一步先檢查「是不是已經做好」，做好的就跳過。
#   - 既有的 .env 不覆蓋、不改已有的值，只補缺少的欄位。
#   - 不刪資料庫 volume、不 down -v、不動防火牆與 SSH、不把金鑰寫進版控的檔案。
#   - 金鑰與亂數不印到畫面，也不寫進 log。

set -Eeuo pipefail

# ────────────────────────────── 常數 ──────────────────────────────

readonly APP_DIR="/opt/costscale"
readonly LOG_FILE="/var/log/costscale-install.log"
readonly COMPOSE_MIN="2.24.4"
readonly TOTAL_STEPS=9
readonly SITE_NAME="costscale"
readonly CRON_BEGIN="# >>> costscale install (managed block, do not edit) >>>"
readonly CRON_END="# <<< costscale install (managed block) <<<"
readonly SS_DIR="/etc/ssl/costscale"
readonly SS_CA="/usr/local/share/ca-certificates/costscale-selfsigned.crt"
readonly ORIG_ARGS="$*"

TLS_MODE="letsencrypt"
NON_INTERACTIVE=0
STEP_NO=0
STEP_NAME="開始前"
STEP_HINT="$LOG_FILE"
WARNINGS=()

DASH_DOMAIN=""
GW_DOMAIN=""
ALLOWED_EMAILS=""
GOOGLE_ID=""
GOOGLE_SECRET=""
GEMINI_KEY=""
LE_EMAIL=""

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full)
COMPOSE_STR="docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full"

# ────────────────────────────── 輸出與錯誤處理 ──────────────────────────────

say() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >>"$LOG_FILE" 2>/dev/null || true
}

step() {
  STEP_NO=$((STEP_NO + 1))
  STEP_NAME="$1"
  STEP_HINT="$LOG_FILE"
  say ""
  say "第 ${STEP_NO} 步／共 ${TOTAL_STEPS} 步：$1"
}

warn() {
  say "  警告：$1"
  WARNINGS+=("$1")
}

rerun_cmd() {
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    echo "bash $APP_DIR/scripts/install.sh $ORIG_ARGS（CS_ 開頭的環境變數要一併帶上，已寫進 .env 的欄位可以省略）"
  else
    echo "bash $APP_DIR/scripts/install.sh $ORIG_ARGS"
  fi
}

# die <原因> [該看哪裡]
die() {
  say ""
  say "安裝在「第 ${STEP_NO} 步：${STEP_NAME}」停住了。"
  say "  原因：$1"
  say "  該看哪裡：${2:-$STEP_HINT}"
  say "  修好之後，重新執行同一行指令即可，做好的部分會自動跳過："
  say "    $(rerun_cmd)"
  exit 1
}

on_err() {
  local code=$? line=$1
  say ""
  say "安裝在「第 ${STEP_NO} 步：${STEP_NAME}」發生未預期的錯誤（腳本第 ${line} 行，結束碼 ${code}）。"
  say "  該看哪裡：${STEP_HINT}"
  say "  修好之後，重新執行同一行指令即可，做好的部分會自動跳過："
  say "    $(rerun_cmd)"
  exit "$code"
}
trap 'on_err $LINENO' ERR

# 執行會輸出大量文字的指令：畫面與 log 都看得到。pipefail 會把失敗傳出來。
run_logged() {
  "$@" 2>&1 | tee -a "$LOG_FILE"
}

usage() {
  cat <<'EOF'
AI CostScale 互動式安裝腳本

把 INSTALL.md 第 1 到 7 節自動做完：裝工具、問幾個問題、產生 .env、啟動服務、
設定 nginx 與 HTTPS、安裝必要排程。

前提：Ubuntu 22.04 以上、root 權限、程式碼已放在 /opt/costscale。

用法：
  bash /opt/costscale/scripts/install.sh [選項]

選項：
  --tls letsencrypt|selfsigned|skip
        letsencrypt（預設）  向 Let's Encrypt 申請正式憑證。兩個網域的 DNS 要先指到這台主機。
                              選這個模式並繼續，代表同意 Let's Encrypt 的使用條款。
        selfsigned           產生自簽憑證，只供內網或測試使用，瀏覽器會顯示不安全。
        skip                 不動 nginx，你自己處理 HTTPS。
  --non-interactive
        不問問題，全部答案改由環境變數提供：
          CS_DASH_DOMAIN       儀表板網域，例如 cost.example.com
          CS_GW_DOMAIN         閘道網域，例如 llm.example.com
          CS_ALLOWED_EMAILS    可登入的 Google 帳號，逗號分隔
          CS_GOOGLE_ID         Google OAuth 用戶端 ID（可省略，之後再補）
          CS_GOOGLE_SECRET     Google OAuth 用戶端密鑰（可省略，之後再補）
          CS_GEMINI_FREE_KEY   Gemini 免費金鑰（可省略）
          CS_LE_EMAIL          Let's Encrypt 通知信箱（letsencrypt 模式且尚未有憑證時必填）
        .env 已經有的欄位不需要再提供。
  -h, --help
        顯示這段說明。

可以重複執行：做好的步驟會跳過，既有的 .env 不會被覆蓋。
紀錄檔：/var/log/costscale-install.log（不含任何金鑰）
EOF
}

# ────────────────────────────── 參數 ──────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --tls)
      shift
      [ $# -gt 0 ] || { echo "--tls 後面要接 letsencrypt、selfsigned 或 skip" >&2; exit 2; }
      TLS_MODE="$1"
      ;;
    --tls=*) TLS_MODE="${1#--tls=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不認得的參數：$1（用 --help 看說明）" >&2; exit 2 ;;
  esac
  shift
done
case "$TLS_MODE" in
  letsencrypt|selfsigned|skip) ;;
  *) echo "--tls 只能是 letsencrypt、selfsigned 或 skip，收到：$TLS_MODE" >&2; exit 2 ;;
esac

# ────────────────────────────── 通用工具 ──────────────────────────────

# 值是否「還沒填」：空、placeholder、範本裡的 change-me、範例網域
is_unset() {
  local v="${1:-}"
  case "$v" in
    ""|placeholder|change-me*|sk-change-me*|*example.com*) return 0 ;;
  esac
  return 1
}

env_get() { # env_get KEY：沒有這個欄位回空字串
  [ -f "$APP_DIR/.env" ] || { printf ''; return 0; }
  local line
  line=$(grep -m1 "^$1=" "$APP_DIR/.env" 2>/dev/null || true)
  printf '%s' "${line#*=}"
}

env_has() { [ -f "$APP_DIR/.env" ] && grep -q "^$1=" "$APP_DIR/.env"; }

env_set() { # env_set KEY VALUE：已有這個欄位就取代，沒有就附加。只用 shell 內建指令，值不會出現在 ps
  local k="$1" v="$2" tmp line found=0
  case "$v" in *$'\n'*) die "欄位 $k 的值含有換行，無法寫入 .env" ;; esac
  tmp=$(mktemp)
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "$k="* ]]; then
      printf '%s=%s\n' "$k" "$v" >>"$tmp"
      found=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$APP_DIR/.env"
  [ "$found" -eq 1 ] || printf '%s=%s\n' "$k" "$v" >>"$tmp"
  cat "$tmp" >"$APP_DIR/.env"
  rm -f "$tmp"
}

has_systemd() { [ -d /run/systemd/system ]; }

# 用 pid 檔判斷程式是否在跑（最小化的 Ubuntu 映像沒有 pgrep）
proc_running() {
  local pid
  [ -f "$1" ] || return 1
  pid=$(cat "$1" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 服務管理集中在這裡。有 systemd 用 systemctl，沒有（例如容器）就直接啟動程式。
# 用法：svc_start docker|nginx|cron   svc_reload nginx
svc_start() {
  local name="$1"
  if has_systemd; then
    systemctl enable "$name" >/dev/null 2>&1 || true
    systemctl start "$name"
    return 0
  fi
  case "$name" in
    docker)
      if ! docker info >/dev/null 2>&1; then
        say "  沒有 systemd，直接啟動 dockerd（紀錄在 /var/log/dockerd.log）"
        setsid nohup dockerd >/var/log/dockerd.log 2>&1 </dev/null &
        local i
        for i in $(seq 1 60); do
          docker info >/dev/null 2>&1 && return 0
          sleep 1
        done
        die "dockerd 60 秒內沒有起來" "/var/log/dockerd.log"
      fi
      ;;
    nginx)
      proc_running /run/nginx.pid || nginx
      ;;
    cron)
      proc_running /run/crond.pid || cron
      ;;
  esac
}

svc_reload() {
  local name="$1"
  if has_systemd; then
    systemctl reload "$name"
    return 0
  fi
  case "$name" in
    nginx)
      if proc_running /run/nginx.pid; then nginx -s reload; else nginx; fi
      ;;
  esac
}

# wait_until <秒數> <說明> <指令...>
wait_until() {
  local limit="$1" desc="$2" i
  shift 2
  for ((i = 0; i < limit; i += 3)); do
    if "$@" >/dev/null 2>&1; then
      say "  OK：$desc"
      return 0
    fi
    sleep 3
  done
  return 1
}

container_of() { "${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -1; }

container_health() { # 印出 healthy／unhealthy／starting／none
  local id
  id=$(container_of "$1")
  [ -n "$id" ] || { echo none; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo none
}

is_healthy() { [ "$(container_health "$1")" = "healthy" ]; }
is_running() { [ "$(docker inspect -f '{{.State.Status}}' "$(container_of "$1")" 2>/dev/null || true)" = "running" ]; }

http_code() { # http_code <curl 參數...>
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || true
}

norm_domain() {
  local d="${1,,}"
  d="${d#http://}"; d="${d#https://}"; d="${d%%/*}"
  printf '%s' "$d"
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$ ]]; }

# ────────────────────────────── 第 1 步：檢查環境 ──────────────────────────────

check_environment() {
  step "檢查環境（root、Ubuntu 版本、安裝位置、記憶體）"
  touch "$LOG_FILE" 2>/dev/null || true
  chmod 600 "$LOG_FILE" 2>/dev/null || true

  if [ "$(id -u)" -ne 0 ]; then
    die "要用 root 執行。請先切到 root（sudo -i），再執行同一行指令。" "不需要看紀錄"
  fi

  if [ ! -r /etc/os-release ]; then
    die "讀不到 /etc/os-release，無法判斷作業系統。本腳本只支援 Ubuntu 22.04 以上。" "/etc/os-release"
  fi
  local os_id os_ver
  os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
  os_ver=$(. /etc/os-release && printf '%s' "${VERSION_ID:-0}")
  if [ "$os_id" != "ubuntu" ] || [ "$(printf '%s\n%s\n' "22.04" "$os_ver" | sort -V | head -1)" != "22.04" ]; then
    die "這台是 ${os_id} ${os_ver}。本腳本只支援 Ubuntu 22.04 以上；其他系統請照 INSTALL.md 第 1 到 7 節手動安裝。" "/etc/os-release"
  fi
  say "  作業系統：Ubuntu ${os_ver}"

  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  if [ "$here" != "$APP_DIR" ]; then
    die "程式碼放在 ${here}，必須放在 ${APP_DIR}（排程腳本、nginx 設定都寫死這個路徑）。請執行：git clone <倉庫網址> ${APP_DIR}，再執行 bash ${APP_DIR}/scripts/install.sh" "不需要看紀錄"
  fi
  say "  程式碼位置：${APP_DIR}"

  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${mem_kb:-0}" -lt 1800000 ]; then
    warn "記憶體只有約 $((mem_kb / 1024)) MB，建議 2 GB 以上。建置儀表板時可能因記憶體不足失敗；失敗的話請加 swap 或換大一點的主機。"
  else
    say "  記憶體：約 $((mem_kb / 1024)) MB"
  fi
}

# ────────────────────────────── 第 2 步：問答 ──────────────────────────────

# ask <變數名> <環境變數名> <說明> <必填 1|0> <祕密 1|0>
ask() {
  local var="$1" envname="$2" desc="$3" required="$4" secret="${5:-0}" ans=""
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    ans="${!envname:-}"
    if [ -z "$ans" ] && [ "$required" -eq 1 ]; then
      die "非互動模式缺少環境變數 ${envname}（${desc}）" "不需要看紀錄；用 --help 看全部環境變數"
    fi
  else
    say ""
    say "  $desc"
    local tag="" prompt
    [ "$required" -eq 1 ] || tag="（可以直接按 Enter 跳過）"
    while :; do
      prompt="  ${var}${tag}："
      if [ "$secret" -eq 1 ]; then
        read -rs -p "$prompt" ans || die "讀不到輸入。要在沒有終端機的環境執行，請改用 --non-interactive" "不需要看紀錄"
        echo
      else
        read -r -p "$prompt" ans || die "讀不到輸入。要在沒有終端機的環境執行，請改用 --non-interactive" "不需要看紀錄"
      fi
      if [ -z "$ans" ] && [ "$required" -eq 1 ]; then
        echo "  這一題一定要填。"
        continue
      fi
      break
    done
  fi
  printf -v "$var" '%s' "$ans"
}

collect_answers() {
  step "回答幾個問題（已經寫在 .env 裡的項目會直接沿用，不再問）"
  [ "$NON_INTERACTIVE" -eq 1 ] && say "  非互動模式：答案從 CS_ 開頭的環境變數讀取"

  if [ "$NON_INTERACTIVE" -eq 0 ] && [ ! -t 0 ]; then
    die "標準輸入不是終端機，沒辦法問問題。要在腳本或自動化環境執行，請加 --non-interactive 並用 CS_ 環境變數提供答案（--help 有清單）" "不需要看紀錄"
  fi

  # 先看既有 .env
  local cur_url cur_gw cur_mail cur_gid cur_gsec cur_gem
  cur_url=$(env_get AUTH_URL); cur_gw=$(env_get GATEWAY_PUBLIC_URL)
  cur_mail=$(env_get AUTH_ALLOWED_EMAILS)
  cur_gid=$(env_get AUTH_GOOGLE_ID); cur_gsec=$(env_get AUTH_GOOGLE_SECRET)
  cur_gem=$(env_get GEMINI_FREE_KEY_1)

  if [ -f "$APP_DIR/.env" ]; then
    say "  發現既有的 .env：不會覆蓋。沿用裡面已填的值，只補缺少或還是範本預設值的欄位。"
  fi

  if is_unset "$cur_url"; then
    ask DASH_DOMAIN CS_DASH_DOMAIN "儀表板的網域（例如 cost.example.com）。要先在 DNS 服務商建一筆 A 紀錄指向這台主機。" 1
    DASH_DOMAIN=$(norm_domain "$DASH_DOMAIN")
  else
    DASH_DOMAIN=$(norm_domain "$cur_url")
    say "  沿用 .env 的儀表板網域：$DASH_DOMAIN"
  fi
  valid_domain "$DASH_DOMAIN" || die "儀表板網域格式不對：$DASH_DOMAIN（要像 cost.example.com，不含 https:// 與斜線）" "不需要看紀錄"

  if is_unset "$cur_gw"; then
    ask GW_DOMAIN CS_GW_DOMAIN "閘道的網域（例如 llm.example.com）。要與儀表板網域不同，DNS 也要指向這台主機。" 1
    GW_DOMAIN=$(norm_domain "$GW_DOMAIN")
  else
    GW_DOMAIN=$(norm_domain "$cur_gw")
    say "  沿用 .env 的閘道網域：$GW_DOMAIN"
  fi
  valid_domain "$GW_DOMAIN" || die "閘道網域格式不對：$GW_DOMAIN（要像 llm.example.com，不含 https:// 與斜線）" "不需要看紀錄"
  [ "$DASH_DOMAIN" != "$GW_DOMAIN" ] || die "儀表板與閘道要用兩個不同的網域，現在兩個都是 $DASH_DOMAIN" "不需要看紀錄"

  if is_unset "$cur_mail"; then
    ask ALLOWED_EMAILS CS_ALLOWED_EMAILS "可以登入儀表板的 Google 帳號，多個用逗號分隔（例如 me@gmail.com,boss@gmail.com）。只有這些帳號登得進去。" 1
    ALLOWED_EMAILS=$(printf '%s' "$ALLOWED_EMAILS" | tr -d '[:space:]')
    local e
    IFS=',' read -r -a _mails <<<"$ALLOWED_EMAILS"
    for e in "${_mails[@]}"; do
      [[ "$e" =~ ^[^@,]+@[^@,]+\.[^@,]+$ ]] || die "帳號格式不對：$e（要像 me@gmail.com）" "不需要看紀錄"
    done
  else
    ALLOWED_EMAILS="$cur_mail"
    say "  沿用 .env 的登入白名單"
  fi

  if is_unset "$cur_gid" || is_unset "$cur_gsec"; then
    if [ "$NON_INTERACTIVE" -eq 0 ]; then
      say ""
      say "  Google 登入需要一組 OAuth 用戶端（INSTALL.md 第 4 節有完整步驟）："
      say "    1. Google Cloud Console →「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」，類型選「網頁應用程式」。"
      say "    2. 「已授權的重新導向 URI」填下面這一行，一個字都不要多（結尾不能有斜線）："
      say "         https://${DASH_DOMAIN}/api/auth/callback/google"
      say "    3. 建立後會得到「用戶端 ID」與「用戶端密鑰」。還沒準備好可以先跳過，裝好之後再補。"
    fi
    ask GOOGLE_ID CS_GOOGLE_ID "Google OAuth 用戶端 ID（長得像 123456-abc.apps.googleusercontent.com）。" 0
    if [ -n "$GOOGLE_ID" ]; then
      ask GOOGLE_SECRET CS_GOOGLE_SECRET "Google OAuth 用戶端密鑰（輸入時畫面不會顯示）。" 0 1
    fi
    if [ -z "$GOOGLE_ID" ] || [ -z "$GOOGLE_SECRET" ]; then
      GOOGLE_ID=""; GOOGLE_SECRET=""
      say "  已跳過 Google 登入設定，結尾會提醒你怎麼補。"
    fi
  else
    say "  沿用 .env 的 Google OAuth 設定"
  fi

  if is_unset "$cur_gem"; then
    ask GEMINI_KEY CS_GEMINI_FREE_KEY "Gemini 免費金鑰（到 https://aistudio.google.com/apikey 建立，可以免費拿）。裝好後用它測試第一次呼叫。輸入時畫面不會顯示。" 0 1
  else
    say "  沿用 .env 的 Gemini 免費金鑰"
  fi

  if [ "$TLS_MODE" = "letsencrypt" ] && [ ! -e "/etc/letsencrypt/live/${DASH_DOMAIN}/fullchain.pem" ]; then
    ask LE_EMAIL CS_LE_EMAIL "Let's Encrypt 憑證要用的信箱（憑證快到期、帳號有事時它會寄信通知）。繼續即代表同意 Let's Encrypt 使用條款。" 1
    [[ "$LE_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "信箱格式不對：$LE_EMAIL" "不需要看紀錄"
  fi
  say "  問答完成。接下來不用再回答，可以等它跑完（首次約 5 到 10 分鐘）。"
}

# ────────────────────────────── 第 3 步：安裝工具 ──────────────────────────────

pkg_installed() { dpkg -s "$1" >/dev/null 2>&1; }

install_tools() {
  step "安裝缺少的工具（Docker、git、curl、python3、nginx、certbot、cron）"
  STEP_HINT="$LOG_FILE（apt 的完整輸出都在裡面）"
  export DEBIAN_FRONTEND=noninteractive

  local apt_updated=0
  apt_update_once() {
    if [ "$apt_updated" -eq 0 ]; then
      run_logged apt-get update
      apt_updated=1
    fi
  }

  local pkgs=() p
  for p in ca-certificates curl git python3 nginx certbot python3-certbot-nginx cron openssl; do
    pkg_installed "$p" || pkgs+=("$p")
  done
  if [ "${#pkgs[@]}" -gt 0 ]; then
    say "  安裝：${pkgs[*]}"
    apt_update_once
    run_logged apt-get install -y "${pkgs[@]}"
  else
    say "  一般工具都已經有了，跳過"
  fi

  local need_docker=0
  command -v docker >/dev/null 2>&1 || need_docker=1
  if [ "$need_docker" -eq 0 ] && ! docker compose version >/dev/null 2>&1; then
    need_docker=2 # 有 docker 但沒有 compose 外掛
  fi
  if [ "$need_docker" -ne 0 ]; then
    say "  照 Docker 官方 apt 套件庫安裝 Docker Engine 與 Compose 外掛（INSTALL.md 第 1.1 節）"
    apt_update_once
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    local codename arch
    codename=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
    arch=$(dpkg --print-architecture)
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$codename" >/etc/apt/sources.list.d/docker.list
    run_logged apt-get update
    if [ "$need_docker" -eq 1 ]; then
      run_logged apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
      run_logged apt-get install -y docker-compose-plugin
    fi
  else
    say "  Docker 與 Compose 外掛已經有了，跳過"
  fi

  svc_start docker
  svc_start nginx
  svc_start cron

  local ver
  ver=$(docker compose version --short 2>/dev/null || true)
  ver="${ver#v}"; ver="${ver%%+*}"; ver="${ver%%-*}"
  if [ -z "$ver" ]; then
    die "docker compose 沒有輸出版本。Compose 外掛沒裝好。" "docker compose version"
  fi
  if [ "$(printf '%s\n%s\n' "$COMPOSE_MIN" "$ver" | sort -V | head -1)" != "$COMPOSE_MIN" ]; then
    die "Docker Compose 版本是 ${ver}，要 ${COMPOSE_MIN} 以上（覆寫檔用到 !override，舊版不認得）。請改用 Docker 官方 apt 套件庫的 docker-compose-plugin，不要用 Ubuntu 預設的 docker.io。" "docker compose version"
  fi
  say "  Docker Compose ${ver}：OK"
}

# ────────────────────────────── 第 4 步：.env ──────────────────────────────

rand_hex() { openssl rand -hex 24; }

# 設定欄位：只有「不存在」或「還是範本預設值」才寫入，已有的真值不動
env_fill() { # env_fill KEY VALUE
  local k="$1" v="$2"
  if ! env_has "$k"; then
    env_set "$k" "$v"
  elif is_unset "$(env_get "$k")"; then
    env_set "$k" "$v"
  fi
}

build_env() {
  step "產生 .env（既有的 .env 不覆蓋，只補缺的）"
  STEP_HINT="$APP_DIR/.env（只看欄位名稱，不要把內容貼給別人）"
  cd "$APP_DIR"
  [ -f .env.example ] || die "找不到 $APP_DIR/.env.example，程式碼不完整。" "$APP_DIR"

  umask 077
  if [ ! -f .env ]; then
    if docker volume inspect costscale_dbdata >/dev/null 2>&1; then
      die "找到先前安裝留下的資料庫 volume（costscale_dbdata），但 .env 不見了。新產生的資料庫密碼對不上舊資料庫，服務會一直連不上。腳本不會刪資料庫。請把原本的 .env 放回 $APP_DIR/.env 再重新執行；確定舊資料不要了，才由你自己手動處理 volume。" "docker volume ls"
    fi
    say "  還沒有 .env：以 .env.example 為底建立"
    cp .env.example .env
    chmod 600 .env
    # 新建的 .env 裡，下面這些一定重新產生
    env_set DB_PASSWORD "$(rand_hex)"
    env_set LITELLM_MASTER_KEY "sk-$(rand_hex)"
    env_set AUTH_SECRET "$(rand_hex)"
    env_set ALERT_CRON_TOKEN "$(rand_hex)"
    env_set OTEL_INGEST_TOKEN "$(rand_hex)"
    env_set BRIDGE_TOKEN "$(rand_hex)"
    say "  已為 6 個需要亂數的欄位各產生一組新的值（不會顯示在畫面上）"
  else
    say "  沿用既有 .env，不覆蓋、不改已有的值"
    chmod 600 .env
    # 補上 .env.example 有、但 .env 沒有的欄位
    local line k added=0
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
      k="${BASH_REMATCH[1]}"
      if ! env_has "$k"; then
        printf '%s\n' "$line" >>.env
        added=$((added + 1))
      fi
    done <.env.example
    [ "$added" -eq 0 ] || say "  補上了 ${added} 個缺少的欄位（用範本預設值）"
    # 亂數欄位若不存在或還是範本預設值，補一組新的；已經有真值的不動
    local kk
    for kk in DB_PASSWORD AUTH_SECRET ALERT_CRON_TOKEN OTEL_INGEST_TOKEN BRIDGE_TOKEN; do
      if is_unset "$(env_get "$kk")"; then
        env_set "$kk" "$(rand_hex)"
        say "  $kk 原本是空的或範本預設值，已產生新值"
      fi
    done
    if is_unset "$(env_get LITELLM_MASTER_KEY)"; then
      env_set LITELLM_MASTER_KEY "sk-$(rand_hex)"
      say "  LITELLM_MASTER_KEY 原本是空的或範本預設值，已產生新值"
    fi
  fi

  env_fill AUTH_URL "https://${DASH_DOMAIN}"
  env_fill GATEWAY_PUBLIC_URL "https://${GW_DOMAIN}"
  [ -z "$ALLOWED_EMAILS" ] || env_fill AUTH_ALLOWED_EMAILS "$ALLOWED_EMAILS"
  if [ -n "$GOOGLE_ID" ] && [ -n "$GOOGLE_SECRET" ]; then
    env_fill AUTH_GOOGLE_ID "$GOOGLE_ID"
    env_fill AUTH_GOOGLE_SECRET "$GOOGLE_SECRET"
  else
    # 還沒有真值就寫 placeholder，結尾會提醒要補
    is_unset "$(env_get AUTH_GOOGLE_ID)" && env_set AUTH_GOOGLE_ID placeholder
    is_unset "$(env_get AUTH_GOOGLE_SECRET)" && env_set AUTH_GOOGLE_SECRET placeholder
  fi
  if [ -n "$GEMINI_KEY" ]; then
    env_fill GEMINI_FREE_KEY_1 "$GEMINI_KEY"
  fi

  # 正式環境一定要 0：這個欄位不是「補缺」，是安全底線
  if [ "$(env_get AUTH_DISABLED)" != "0" ]; then
    env_set AUTH_DISABLED 0
    say "  AUTH_DISABLED 設為 0（正式環境一定要開啟登入）"
  fi
  chmod 600 .env
  say "  .env 權限：$(stat -c '%a' .env)"

  # 與你填的答案對照：既有值與這次答案不同時提醒，不覆蓋
  local cur
  cur=$(env_get AUTH_URL)
  [ "$cur" = "https://${DASH_DOMAIN}" ] || warn ".env 的 AUTH_URL 是 ${cur}，與這次的儀表板網域 ${DASH_DOMAIN} 不同，沿用 .env 的值。"
}

# ────────────────────────────── 第 5 步：目錄與檔案 ──────────────────────────────

prepare_files() {
  step "建立佇列目錄與 Vertex 空檔，並讓排程腳本可以執行"
  cd "$APP_DIR"

  mkdir -p "$APP_DIR/spool/upstream-keys"
  chown 1001 "$APP_DIR/spool/upstream-keys"
  chmod 700 "$APP_DIR/spool/upstream-keys"
  say "  spool/upstream-keys：owner 1001、權限 700"

  local vs="/root/vertex-sa.json"
  if [ -d "$vs" ]; then
    if [ -z "$(ls -A "$vs" 2>/dev/null)" ]; then
      say "  $vs 是空資料夾（Docker 之前自動建的），改成空檔"
      rmdir "$vs"
      touch "$vs"
    else
      die "$vs 是一個有內容的資料夾，腳本不會刪它。閘道要掛載的是「檔案」。請把裡面的服務帳戶金鑰檔移出來，刪掉這個資料夾，再把金鑰檔放到 $vs。" "ls -la $vs"
    fi
  elif [ ! -e "$vs" ]; then
    touch "$vs"
    say "  已建立空檔 $vs（不用 Vertex 也要有；要用時把真的服務帳戶金鑰覆蓋上去）"
  else
    say "  $vs 已存在，保持原樣"
  fi

  chmod +x "$APP_DIR"/scripts/*.sh "$APP_DIR"/deploy/*.sh 2>/dev/null || true
}

# ────────────────────────────── 第 6 步：啟動 ──────────────────────────────

start_stack() {
  step "啟動服務並等它們就緒（首次要下載映像並建置儀表板，約 3 到 5 分鐘，網路慢更久）"
  cd "$APP_DIR"
  STEP_HINT="$COMPOSE_STR logs --tail 100 dashboard（建置問題看這個）；$COMPOSE_STR logs --tail 100 litellm；$LOG_FILE"

  local attempt ok=0
  for attempt in 1 2 3; do
    if run_logged "${COMPOSE[@]}" up -d --build; then
      ok=1
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      say "  第 ${attempt} 次啟動失敗。建置時要連 fonts.googleapis.com 下載字型，偶爾會失敗，10 秒後自動重試。"
      sleep 10
    fi
  done
  [ "$ok" -eq 1 ] || die "docker compose up 連試 3 次都失敗。常見原因：主機連不上外網、記憶體不足、10.87.213.0/24 網段與主機網路重疊（錯誤訊息含 Pool overlaps，見 INSTALL.md 第 9.1 節）。" "$LOG_FILE 最後幾十行的錯誤訊息"

  say "  等待服務就緒（有時間上限）……"
  wait_until 300 "資料庫 healthy" is_healthy db \
    || die "資料庫 300 秒內沒有變成 healthy。" "$COMPOSE_STR logs --tail 100 db"
  wait_until 360 "閘道 healthy" is_healthy litellm \
    || die "閘道 360 秒內沒有變成 healthy（第一次啟動要跑資料庫遷移，通常 1 分鐘內）。" "$COMPOSE_STR logs --tail 100 litellm"
  wait_until 120 "閘道 /health/liveliness 回 I'm alive" bash -c "curl -s --max-time 10 http://127.0.0.1:4400/health/liveliness | grep -q \"I'm alive\"" \
    || die "閘道的存活檢查沒有回 I'm alive。" "$COMPOSE_STR logs --tail 100 litellm"
  wait_until 240 "儀表板 /login 回 200" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3300/login)\" = 200 ]" \
    || die "儀表板 /login 240 秒內沒有回 200。" "$COMPOSE_STR logs --tail 100 dashboard"
}

# ────────────────────────────── 第 7 步：nginx 與 HTTPS ──────────────────────────────

SITE_TEMPLATE=$(
  cat <<'EOF'
# 由 scripts/install.sh 產生（TLS 模式：__MODE__）。內容對應 INSTALL.md 第 6 節。
# 儀表板
server {
    __LISTEN__
    server_name __DASH__;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;
    }
}

# 閘道：只放行白名單
server {
    __LISTEN__
    server_name __GW__;
    client_max_body_size 50m;

    # 存活檢查，不需要金鑰
    location = /health/liveliness {
        include snippets/nginx-snippet-costscale-llm-proxy.conf;
    }

    # OpenAI 相容端點（/v1/chat/completions、/v1/images/generations、/v1/models …）
    location /v1/ {
        include snippets/nginx-snippet-costscale-no-master-key.conf;
        include snippets/nginx-snippet-costscale-llm-proxy.conf;
    }

    # Gemini 原生端點（/v1beta/models/…:generateContent）
    location /v1beta/ {
        include snippets/nginx-snippet-costscale-no-master-key.conf;
        include snippets/nginx-snippet-costscale-llm-proxy.conf;
    }

    # 其餘（包括 /key/*、/model/*、/ui）一律不存在
    location / {
        return 404;
    }
}
EOF
)

gen_site() { # gen_site <mode>
  local mode="$1" listen out
  if [ "$mode" = "selfsigned" ]; then
    listen="listen 443 ssl;
    ssl_certificate ${SS_DIR}/fullchain.pem;
    ssl_certificate_key ${SS_DIR}/privkey.pem;"
  else
    listen="listen 80;"
  fi
  out="${SITE_TEMPLATE//__LISTEN__/$listen}"
  out="${out//__MODE__/$mode}"
  out="${out//__DASH__/$DASH_DOMAIN}"
  out="${out//__GW__/$GW_DOMAIN}"
  printf '%s\n' "$out"
  if [ "$mode" = "selfsigned" ]; then
    cat <<EOF

# 80 一律轉到 443
server {
    listen 80;
    server_name ${DASH_DOMAIN} ${GW_DOMAIN};
    return 301 https://\$host\$request_uri;
}
EOF
  fi
}

# 寫入前若目標已存在且內容不同，先備份成 .bak-日期時間。印出 changed／same。
write_with_backup() { # write_with_backup <目標> <新內容檔>
  local target="$1" newf="$2"
  if [ -e "$target" ] && cmp -s "$target" "$newf"; then
    echo same
    return 0
  fi
  if [ -e "$target" ]; then
    cp -p "$target" "${target}.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  cat "$newf" >"$target"
  echo changed
}

public_ip() {
  local u ip
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

check_dns() {
  local ip d resolved
  if ! ip=$(public_ip); then
    warn "查不到這台主機的對外 IP，跳過 DNS 比對，直接申請憑證；申請失敗的話請檢查兩個網域的 A 紀錄。"
    return 0
  fi
  say "  這台主機的對外 IP：$ip"
  local bad=0
  for d in "$DASH_DOMAIN" "$GW_DOMAIN"; do
    resolved=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    if printf '%s' " $resolved" | grep -q " $ip "; then
      say "  DNS OK：$d → $ip"
    else
      say "  DNS 不對：$d 目前解析到「${resolved:-沒有紀錄}」，應該是 $ip"
      bad=1
    fi
  done
  if [ "$bad" -eq 1 ]; then
    die "有網域的 DNS 還沒指到這台主機（$ip）。請到你買網域或管理 DNS 的服務商，替上面標示不對的網域各建一筆 A 紀錄，值填 $ip。記錄生效短則幾分鐘、長則幾小時，用 getent hosts <網域> 查得到 $ip 之後再繼續。其他服務都已經裝好，不用重來。" "DNS 服務商的管理頁面（A 紀錄）"
  fi
}

install_guard_and_snippets() {
  STEP_HINT="nginx -t 與 /var/log/nginx/error.log"
  bash "$APP_DIR/deploy/gen-master-key-guard.sh" >>"$LOG_FILE" 2>&1 \
    || die "主金鑰檢查檔（conf.d/costscale-master-key-guard.conf）產生失敗，或 nginx -t 沒過。" "bash $APP_DIR/deploy/gen-master-key-guard.sh（直接執行看訊息）"
  mkdir -p /etc/nginx/snippets
  cp "$APP_DIR"/deploy/nginx-snippet-costscale-*.conf /etc/nginx/snippets/
  say "  主金鑰檢查檔與兩個共用片段已就位"
}

setup_selfsigned_cert() {
  mkdir -p "$SS_DIR"
  chmod 700 "$SS_DIR"
  local need=1
  if [ -f "$SS_DIR/fullchain.pem" ] && [ -f "$SS_DIR/privkey.pem" ]; then
    local txt
    txt=$(openssl x509 -in "$SS_DIR/fullchain.pem" -noout -text 2>/dev/null || true)
    if printf '%s' "$txt" | grep -q "DNS:${DASH_DOMAIN}" && printf '%s' "$txt" | grep -q "DNS:${GW_DOMAIN}" \
       && openssl x509 -in "$SS_DIR/fullchain.pem" -noout -checkend 2592000 >/dev/null 2>&1; then
      need=0
    fi
  fi
  if [ "$need" -eq 1 ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -keyout "$SS_DIR/privkey.pem" -out "$SS_DIR/fullchain.pem" \
      -subj "/CN=${DASH_DOMAIN}" \
      -addext "subjectAltName=DNS:${DASH_DOMAIN},DNS:${GW_DOMAIN}" >/dev/null 2>&1 \
      || die "產生自簽憑證失敗。" "openssl req 的輸出"
    chmod 600 "$SS_DIR/privkey.pem"
    say "  已產生自簽憑證（$SS_DIR，只供內網或測試使用）"
  else
    say "  自簽憑證已存在且涵蓋兩個網域，沿用"
  fi
  # 讓這台主機自己信任它，排程腳本（check-budgets.sh 等）用 AUTH_URL 呼叫時才不會 curl 60
  if ! cmp -s "$SS_DIR/fullchain.pem" "$SS_CA" 2>/dev/null; then
    cp "$SS_DIR/fullchain.pem" "$SS_CA"
    update-ca-certificates >>"$LOG_FILE" 2>&1 || warn "update-ca-certificates 失敗，排程腳本對自簽憑證可能出現 curl 60。"
  fi
}

setup_nginx() {
  step "設定 nginx 與 HTTPS（模式：${TLS_MODE}）"
  STEP_HINT="nginx -t 的輸出、/var/log/nginx/error.log"

  if [ "$TLS_MODE" = "skip" ]; then
    say "  --tls skip：不動 nginx。儀表板現在只在這台主機的 127.0.0.1:3300，閘道在 127.0.0.1:4400。"
    say "  自己設定 HTTPS 時，請照 INSTALL.md 第 6 節的 nginx 內容，並務必先跑 deploy/gen-master-key-guard.sh。"
    return 0
  fi

  local site_avail="/etc/nginx/sites-available/${SITE_NAME}"
  local site_enabled="/etc/nginx/sites-enabled/${SITE_NAME}"
  local tmp had_site=0 had_link=0 backup=""
  tmp=$(mktemp)

  if [ "$TLS_MODE" = "letsencrypt" ]; then
    # 已經申請成功過：設定檔含 ssl_certificate、網域一致、憑證在，就不要重寫（會把 certbot 改好的內容洗掉）
    if [ -f "$site_avail" ] && grep -q 'ssl_certificate' "$site_avail" \
       && grep -q "server_name ${DASH_DOMAIN};" "$site_avail" && grep -q "server_name ${GW_DOMAIN};" "$site_avail" \
       && [ -e "/etc/letsencrypt/live/${DASH_DOMAIN}/fullchain.pem" ]; then
      say "  Let's Encrypt 憑證與 nginx 設定都已就緒，跳過"
      rm -f "$tmp"
      install_guard_and_snippets
      nginx -t >>"$LOG_FILE" 2>&1 || die "nginx -t 沒過。" "nginx -t"
      return 0
    fi
    check_dns
  fi

  install_guard_and_snippets
  [ "$TLS_MODE" != "selfsigned" ] || setup_selfsigned_cert

  gen_site "$TLS_MODE" >"$tmp"
  [ -e "$site_avail" ] && had_site=1
  [ -L "$site_enabled" ] && had_link=1
  if [ "$had_site" -eq 1 ] && ! cmp -s "$site_avail" "$tmp"; then
    backup="${site_avail}.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  local result
  result=$(write_with_backup "$site_avail" "$tmp")
  rm -f "$tmp"
  [ "$result" = "same" ] && say "  站台設定沒有變動" || say "  已寫入 $site_avail${backup:+（舊檔備份成 $backup）}"
  ln -sfn "$site_avail" "$site_enabled"

  if ! nginx -t >>"$LOG_FILE" 2>&1; then
    # 還原
    if [ -n "$backup" ]; then
      cp -p "$backup" "$site_avail"
    elif [ "$had_site" -eq 0 ]; then
      rm -f "$site_avail"
    fi
    [ "$had_link" -eq 1 ] || rm -f "$site_enabled"
    nginx -t 2>&1 | tee -a "$LOG_FILE" || true
    die "nginx -t 沒有通過，已把站台設定還原成原狀，nginx 沒有重載。上面印的是它指出的檔名與行號。" "nginx -t（直接執行，看它指的檔名與行號）"
  fi
  svc_reload nginx
  say "  nginx -t 通過，已重載"

  if [ "$TLS_MODE" = "letsencrypt" ]; then
    say "  向 Let's Encrypt 申請憑證（$DASH_DOMAIN、$GW_DOMAIN）……"
    STEP_HINT="/var/log/letsencrypt/letsencrypt.log"
    if ! run_logged certbot --nginx --non-interactive --agree-tos -m "$LE_EMAIL" --redirect -d "$DASH_DOMAIN" -d "$GW_DOMAIN"; then
      die "certbot 申請憑證失敗。常見原因：DNS 還沒生效、主機的 80 埠被雲端防火牆（安全群組）擋住、短時間內申請太多次。" "/var/log/letsencrypt/letsencrypt.log"
    fi
    nginx -t >>"$LOG_FILE" 2>&1 || die "certbot 改完設定後 nginx -t 沒過。" "nginx -t"
    svc_reload nginx
    say "  憑證已安裝，80 自動轉 443"
  fi
}

# ────────────────────────────── 第 8 步：排程 ──────────────────────────────

cron_block() {
  cat <<EOF
$CRON_BEGIN
# 儀表板「新增／移除上游金鑰」的佇列：每分鐘套用一次
* * * * * python3 /opt/costscale/scripts/apply-upstream-key.py >> /var/log/costscale-upstream-key.log 2>&1
# 閘道看門狗：不健康時自動重啟
*/3 * * * * /opt/costscale/scripts/watchdog-litellm.sh
# 預算檢查：超過或接近每月預算時寫告警、寄信
5 * * * * /opt/costscale/scripts/check-budgets.sh >> /var/log/costscale-budgets.log 2>&1
# 匯率（台幣顯示用）與訂閱月費入帳。每小時跑，匯率每天只抓一次，同一天重跑不會重複入帳
20 * * * * /opt/costscale/scripts/run-fx-fetch.sh >> /var/log/costscale-fx.log 2>&1
$CRON_END
EOF
}

install_cron() {
  step "安裝必要排程（寫進 root 的 crontab，用標記行包起來）"
  STEP_HINT="crontab -l、/var/log/costscale-*.log"
  local cur new
  cur=$(mktemp); new=$(mktemp)
  crontab -l >"$cur" 2>/dev/null || true

  # 標記區塊之外若已有同樣的排程（手動照 INSTALL.md 第 7 節貼過），提醒但不動
  local outside
  outside=$(awk -v b="$CRON_BEGIN" -v e="$CRON_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip{print}' "$cur")
  if printf '%s\n' "$outside" | grep -v '^[[:space:]]*#' | grep -q '/opt/costscale/scripts/\(apply-upstream-key.py\|watchdog-litellm.sh\|check-budgets.sh\|run-fx-fetch.sh\)'; then
    warn "crontab 標記區塊以外已經有同樣的 costscale 排程（可能是手動貼過），會重複執行。請執行 crontab -e 刪掉標記區塊以外的重複行。"
  fi

  # 取代舊的標記區塊，其餘內容原樣保留
  : >"$new"
  [ -z "$outside" ] || printf '%s\n\n' "$outside" >>"$new"
  cron_block >>"$new"
  if cmp -s "$cur" "$new"; then
    say "  排程區塊已是最新，沒有變動"
  else
    crontab "$new" || die "crontab 寫入失敗。" "crontab -l"
    say "  排程區塊已寫入"
  fi
  rm -f "$cur" "$new"
  svc_start cron
}

# ────────────────────────────── 第 9 步：最終確認 ──────────────────────────────

CHECK_FAIL=0
check_ok()   { say "  [通過]   $1"; }
check_fail() { say "  [未通過] $1"; CHECK_FAIL=$((CHECK_FAIL + 1)); }
check() { # check <說明> <指令...>
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then check_ok "$desc"; else check_fail "$desc"; fi
}

env_required_ok() {
  local k bad=""
  for k in DB_PASSWORD LITELLM_MASTER_KEY AUTH_SECRET AUTH_URL GATEWAY_PUBLIC_URL AUTH_ALLOWED_EMAILS ALERT_CRON_TOKEN OTEL_INGEST_TOKEN BRIDGE_TOKEN; do
    if is_unset "$(env_get "$k")"; then bad="$bad $k"; fi
  done
  [ -z "$bad" ] || { say "    還沒填好的欄位：$bad"; return 1; }
}

final_summary() {
  step "完整確認與摘要"
  cd "$APP_DIR"
  STEP_HINT="$LOG_FILE"

  check "資料庫 healthy" is_healthy db
  check "閘道 healthy" is_healthy litellm
  check "儀表板 running" is_running dashboard
  check "閘道 /health/liveliness 回 I'm alive" bash -c "curl -s --max-time 10 http://127.0.0.1:4400/health/liveliness | grep -q \"I'm alive\""
  check "儀表板 /login（127.0.0.1:3300）回 200" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3300/login)\" = 200 ]"

  if [ "$TLS_MODE" != "skip" ]; then
    local k=""
    [ "$TLS_MODE" != "selfsigned" ] || k="-k"
    check "經 nginx：https://${DASH_DOMAIN}/login 回 200" bash -c "[ \"\$(curl -s $k -o /dev/null -w '%{http_code}' --max-time 15 --resolve ${DASH_DOMAIN}:443:127.0.0.1 https://${DASH_DOMAIN}/login)\" = 200 ]"
    check "經 nginx：https://${GW_DOMAIN}/health/liveliness 回 200" bash -c "[ \"\$(curl -s $k -o /dev/null -w '%{http_code}' --max-time 15 --resolve ${GW_DOMAIN}:443:127.0.0.1 https://${GW_DOMAIN}/health/liveliness)\" = 200 ]"
    check "閘道管理 API 不外露：https://${GW_DOMAIN}/key/list 回 404" bash -c "[ \"\$(curl -s $k -o /dev/null -w '%{http_code}' --max-time 15 --resolve ${GW_DOMAIN}:443:127.0.0.1 https://${GW_DOMAIN}/key/list)\" = 404 ]"
  else
    say "  [略過]   nginx 與 HTTPS（--tls skip）"
  fi

  check ".env 權限為 600" bash -c "[ \"\$(stat -c '%a' $APP_DIR/.env)\" = 600 ]"
  check "AUTH_DISABLED=0" bash -c "grep -qx 'AUTH_DISABLED=0' $APP_DIR/.env"
  if env_required_ok; then check_ok ".env 必要欄位都已填好（供應商金鑰與 Google 登入除外）"; else check_fail ".env 必要欄位都已填好"; fi
  check "排程區塊恰好一份" bash -c "[ \"\$(crontab -l 2>/dev/null | grep -cF '$CRON_BEGIN')\" = 1 ]"
  check "/root/vertex-sa.json 是檔案" test -f /root/vertex-sa.json
  check "spool/upstream-keys 存在且權限 700" bash -c "[ \"\$(stat -c '%a' $APP_DIR/spool/upstream-keys)\" = 700 ]"

  say ""
  local google_pending=0
  if is_unset "$(env_get AUTH_GOOGLE_ID)" || is_unset "$(env_get AUTH_GOOGLE_SECRET)"; then google_pending=1; fi
  local gem_pending=0
  is_unset "$(env_get GEMINI_FREE_KEY_1)" && gem_pending=1

  if [ "$CHECK_FAIL" -eq 0 ]; then
    say "安裝完成，所有確認項目都通過。"
  else
    say "有 ${CHECK_FAIL} 項確認未通過。看上面標示 [未通過] 的項目，修好後重新執行同一行指令："
    say "  $(rerun_cmd)"
  fi

  say ""
  say "儀表板網址：https://${DASH_DOMAIN}"
  say "閘道網址：  https://${GW_DOMAIN}/v1（OpenAI 相容的 base URL）"
  [ "$TLS_MODE" != "selfsigned" ] || say "（自簽憑證只供內網或測試，瀏覽器會提示不安全；要給正式使用，請改用 --tls letsencrypt。）"
  [ "$TLS_MODE" != "skip" ] || say "（--tls skip：尚未設定 HTTPS，網址要等你設好 nginx 才連得到。）"

  if [ "$google_pending" -eq 1 ]; then
    say ""
    say "還不能登入：Google OAuth 用戶端還沒設定。補上之後才能用儀表板："
    say "  1. 照 INSTALL.md 第 4 節建立 OAuth 用戶端，重新導向 URI 填 https://${DASH_DOMAIN}/api/auth/callback/google"
    say "  2. 用 nano ${APP_DIR}/.env 把 AUTH_GOOGLE_ID、AUTH_GOOGLE_SECRET 換成拿到的值（原本是 placeholder）"
    say "  3. 在 ${APP_DIR} 執行：${COMPOSE_STR} up -d"
    say "     （改完 .env 一定要用 up -d；restart 不會讀到新值）"
  fi
  if [ "$gem_pending" -eq 1 ]; then
    say ""
    say "還沒有任何 AI 供應商金鑰：到儀表板「金鑰管理 → 新增上游金鑰」加一把，或編輯 .env 的 GEMINI_FREE_KEY_1 後執行 ${COMPOSE_STR} up -d。"
  fi
  if [ "${#WARNINGS[@]}" -gt 0 ]; then
    say ""
    say "執行中的警告："
    local w
    for w in "${WARNINGS[@]}"; do say "  - $w"; done
  fi

  say ""
  say "下一步（INSTALL.md 第 8 節）："
  say "  1. 儀表板 →「應用程式」→「新增軟體」，取個名字，複製只顯示一次的虛擬金鑰（sk- 開頭）。"
  say "  2. 用那把金鑰打一次閘道，確認有回答："
  say "     curl -s https://${GW_DOMAIN}/v1/chat/completions -H \"Authorization: Bearer sk-你的虛擬金鑰\" -H \"Content-Type: application/json\" -d '{\"model\":\"gemini-flash-free\",\"messages\":[{\"role\":\"user\",\"content\":\"用一句話自我介紹\"}]}'"
  say "  3. 回儀表板「總覽」，幾秒內會看到這一筆呼叫與花費。"
  say "  沒有瀏覽器時，也可以在主機上用 ${APP_DIR}/scripts/issue-key.sh test-app \"說明文字\" 發金鑰。"
  say ""
  say "安裝紀錄：${LOG_FILE}（不含金鑰）"

  [ "$CHECK_FAIL" -eq 0 ] || exit 1
}

# ────────────────────────────── 主流程 ──────────────────────────────

main() {
  touch "$LOG_FILE" 2>/dev/null || true
  say ""
  say "===== AI CostScale 安裝 $(date '+%Y-%m-%d %H:%M:%S')（TLS：${TLS_MODE}，非互動：${NON_INTERACTIVE}）====="
  check_environment
  collect_answers
  install_tools
  build_env
  prepare_files
  start_stack
  setup_nginx
  install_cron
  final_summary
}

main

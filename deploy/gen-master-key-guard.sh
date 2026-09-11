#!/bin/bash
# 產生「master key 不得打生成端點」的 nginx map（2026-08-23）
#
# 為什麼要有這道閘：
#   閘道的管理 API 早就不對外（nginx 預設拒絕，實測 /key/generate、/key/list、
#   /model/info 從公開網址一律 404）。但生成端點是開的，而 master key 在
#   LiteLLM 眼裡是萬能鑰匙——它可以打任何模型，而且帳目上歸不到任何軟體。
#   2026-08-23 盤點：全期間 196 次、539,432 tokens 是 master key 直接打的，
#   在 /apps 上顯示為「未歸戶」。
#
#   要講清楚這道閘的價值：它主要是**歸戶紀律**，不是安全防線。
#   master key 真的外流的話，對方可以走 SSH 隧道打管理 API 自己發一把虛擬金鑰，
#   擋生成端點擋不住那條路。真正的安全控制是「管理 API 不對外」，那已經有了。
#
# 為什麼要另外產生檔案而不是寫死在站台設定裡：
#   nginx 的 map 只能放在 http 區塊，而站台設定是 server 區塊。
#   而且 map 裡要放 master key 的值——那是機密，必須 600、必須能一鍵重生。
#   金鑰輪替時只要改 .env 再跑一次這支，唯一真實來源仍然是 .env。
#
# 用法：
#   sudo /opt/costscale/deploy/gen-master-key-guard.sh
# 跑完會自己 nginx -t；通過才提示你 reload，不會自作主張重載。

set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/costscale/.env}"
OUT="${OUT:-/etc/nginx/conf.d/costscale-master-key-guard.conf}"

if [ ! -r "$ENV_FILE" ]; then
  echo "讀不到 $ENV_FILE" >&2
  exit 1
fi

MK="$(grep '^LITELLM_MASTER_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$MK" ]; then
  echo "$ENV_FILE 裡沒有 LITELLM_MASTER_KEY" >&2
  exit 1
fi

# 逐字逸出正規表示式的特殊字元。金鑰可能含 base64 的 + / =，不能直接塞進 regex。
ESC="$(printf '%s' "$MK" | sed -e 's/[][\\.^$*+?(){}|/-]/\\&/g')"

umask 077
cat > "$OUT" <<EOF
# 由 deploy/gen-master-key-guard.sh 產生，不要手改——金鑰輪替後重跑那支即可。
# 內含 LITELLM_MASTER_KEY 的值，權限必須是 600。
#
# \$costscale_is_master_key = 1 代表這次請求帶的是 master key。
# 站台設定在生成端點上看到 1 就回 403。
#
# 已知限制：這是字串比對，比對的是「Bearer + 空白 + 金鑰」。
# 手動塞入奇怪的空白或大小寫變形有可能繞過——但能做到那件事的人
# 本來就能走 SSH 隧道直接打管理 API，所以不影響這道閘的實際用途（歸戶紀律）。
map \$http_authorization \$costscale_is_master_key {
    default                          0;
    ~*^Bearer\\s+${ESC}\\s*\$        1;
    ~*^${ESC}\\s*\$                  1;
}
EOF
chmod 600 "$OUT"
echo "已寫入 $OUT（權限 $(stat -c '%a' "$OUT")）"

if nginx -t; then
  echo
  echo "nginx -t 通過。確認無誤後執行：systemctl reload nginx"
else
  echo "nginx -t 失敗，設定沒有生效（檔案已寫入但尚未 reload）" >&2
  exit 1
fi

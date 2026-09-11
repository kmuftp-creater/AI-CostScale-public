#!/usr/bin/env bash
# 讓 SSH 反向隧道能綁到 docker 橋接介面，供閘道容器連到家機的橋接服務。
#
# 為什麼需要：反向隧道預設只能綁 127.0.0.1，而 LiteLLM 跑在容器裡，
# 容器碰不到主機的 loopback。GatewayPorts clientspecified 允許客戶端
# 指定綁定位址，我們綁 10.87.213.1（costscale 網路的閘道），
# 那是內部位址，不對公網開放。
#
# 不要改成 GatewayPorts yes——那會讓隧道綁到 0.0.0.0，等於對全世界開放。
set -euo pipefail

CFG=/etc/ssh/sshd_config
BAK="$CFG.bak-$(date +%Y%m%d-%H%M%S)"

if sshd -T | grep -qi '^gatewayports clientspecified'; then
    echo "已經是 clientspecified，不需變更"
    exit 0
fi

cp "$CFG" "$BAK"
echo "已備份到 $BAK"

# 移除既有設定（可能被註解或設成 no），再加上正確的一行。
sed -i '/^[[:space:]]*#\?[[:space:]]*GatewayPorts/d' "$CFG"
printf '\n# 允許反向隧道綁到指定位址（供閘道容器連家機橋接服務用）。\n# 不要改成 yes——那會綁到 0.0.0.0 等於對公網開放。\nGatewayPorts clientspecified\n' >> "$CFG"

if ! sshd -t; then
    cp "$BAK" "$CFG"
    echo "語法檢查失敗，已回滾，未重新載入。" >&2
    exit 1
fi

# reload 而非 restart：既有連線不會被切斷（包含我們現在這條）。
systemctl reload ssh 2>/dev/null || systemctl reload sshd
sleep 1
echo "生效後的設定：$(sshd -T | grep -i gatewayports)"

# AI CostScale 安裝說明

照順序做完第 1 到第 8 節，閘道與儀表板就能用了。第 9 節以後都是選用：訂閱橋接、用量收集器、專案看板，要用再裝。

每一節最後都有一個「確認」步驟。**確認沒過就不要往下做**，後面的步驟都建立在前面的結果上。

---

## 0. 裝完長什麼樣子

```
          你的專案（網站、機器人、腳本）
                    │  帶「虛擬金鑰」
                    ▼
┌──────────── 雲端主機（VPS）────────────┐
│ nginx ── https://llm.example.com ──► 閘道（LiteLLM，127.0.0.1:4400）
│       └─ https://cost.example.com ─► 儀表板（Next.js，127.0.0.1:3300）
│                                      資料庫（PostgreSQL，127.0.0.1:5436）
└───────────────────┬────────────────────┘
                    │ SSH 反向隧道（選用，第 9 節）
                    ▼
        你家裡的 Windows 電腦：訂閱橋接
        （用你已登入的 Claude Code／Codex／Antigravity 訂閱）
```

- **閘道**替你保管所有供應商的真金鑰。專案只拿到閘道發的虛擬金鑰，每一筆呼叫都記帳。
- **儀表板**看花費、發金鑰、設每月上限。只有白名單裡的 Google 帳號能登入。
- **訂閱橋接**是選用的。沒裝的話 `sub-*` 這幾個模型打不通，其他一切照常。

---

## 1. 事前準備

| 項目 | 規格 |
|---|---|
| 一台 Linux 主機 | Ubuntu 22.04 以上，2 GB 記憶體以上，有 root 權限 |
| Docker | Docker Engine ＋ Compose 外掛 **v2.24.4 以上**（覆寫檔用到 `!override`，舊版不認得） |
| 兩個網域 | 例如 `cost.example.com`（儀表板）與 `llm.example.com`（閘道），DNS 都指向這台主機 |
| nginx ＋ certbot | 對外只開 443，HTTPS 憑證用 Let's Encrypt |
| 一個 Google 帳號 | 建 OAuth 用戶端，讓儀表板用 Google 登入 |
| 至少一把 AI 金鑰 | 例如 Google AI Studio 的免費金鑰，裝好之後測試用 |

確認 Docker 版本：

```bash
docker compose version
```

輸出的版本號要在 `v2.24.4` 以上。

---

## 2. 放程式碼

**一定要放在 `/opt/costscale`。** 排程腳本、nginx 範例與橋接的告警都寫死這個路徑。

```bash
sudo git clone https://github.com/kmuftp-creater/AI-CostScale-public.git /opt/costscale
```

```bash
cd /opt/costscale
```

---

## 3. 填 `.env`

```bash
cp .env.example .env
```

```bash
chmod 600 .env
```

用 `nano .env` 打開，**至少**要改這幾個：

| 欄位 | 填什麼 |
|---|---|
| `DB_PASSWORD` | 資料庫密碼，產生方式見下方 |
| `LITELLM_MASTER_KEY` | 閘道主金鑰，`sk-` 開頭加一段亂數 |
| `AUTH_SECRET` | 登入加密用，產生方式見下方 |
| `AUTH_URL` | 儀表板網址，例如 `https://cost.example.com`（結尾不要斜線） |
| `GATEWAY_PUBLIC_URL` | 閘道網址，例如 `https://llm.example.com` |
| `AUTH_ALLOWED_EMAILS` | 可以登入儀表板的 Google 帳號，逗號分隔 |
| `AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET` | 第 4 節拿到的兩個值 |
| `ALERT_CRON_TOKEN` | 排程呼叫儀表板用，亂數 |
| `OTEL_INGEST_TOKEN` | 用量收集器回報用，亂數 |
| `BRIDGE_TOKEN` | 閘道呼叫訂閱橋接用，亂數。不裝橋接也填一個 |
| 供應商金鑰 | 手上有哪一把就填哪一把，其他保留 `placeholder` |

每一個「亂數」都用這行產生一個新的，不要共用同一個：

```bash
openssl rand -hex 24
```

`LITELLM_MASTER_KEY` 前面自己補上 `sk-`。

> `AUTH_DISABLED` 必須是 `0`。設成 `1` 會完全跳過登入，任何人都看得到你的花費與金鑰清單。

---

## 4. 建立 Google 登入

1. 到 Google Cloud Console →「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型選「網頁應用程式」。
3. 「已授權的重新導向 URI」填：

   ```
   https://cost.example.com/api/auth/callback/google
   ```

   （換成你自己的儀表板網域）
4. 建立後把「用戶端 ID」填進 `.env` 的 `AUTH_GOOGLE_ID`，「用戶端密鑰」填進 `AUTH_GOOGLE_SECRET`。

第一次設定 OAuth 同意畫面時，發布狀態選「測試中」並把自己加進測試使用者即可，不需要送審。

---

## 5. 啟動

先建立「新增上游金鑰」功能用的佇列目錄。儀表板在容器裡的使用者編號是 1001，**目錄一定要給它寫入權**，否則儀表板的「新增上游金鑰」會失敗：

```bash
mkdir -p /opt/costscale/spool/upstream-keys
```

```bash
chown 1001 /opt/costscale/spool/upstream-keys && chmod 700 /opt/costscale/spool/upstream-keys
```

啟動全部服務（第一次要建置儀表板，約 3 到 5 分鐘）：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d --build
```

> **這台主機上的每一個 compose 指令都要帶這兩個 `-f` 和 `--profile full`。** 漏掉覆寫檔會用開發用的埠位建容器。

資料庫第一次啟動時會自動建好所有資料表（`db/init/` 底下的檔案依序執行）。

### 確認

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full ps
```

三個服務（db、litellm、dashboard）都要是 `Up`，db 與 litellm 要顯示 `(healthy)`。閘道第一次啟動約需 30 秒到 1 分鐘。

```bash
curl -s http://127.0.0.1:4400/health/liveliness
```

要回 `"I'm alive!"`。

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3300/login
```

要回 `200`。

---

## 6. nginx 與 HTTPS

閘道的管理 API（發金鑰、看設定）**絕對不能對外開放**。下面的設定只放行產生內容的端點與存活檢查，其他路徑一律 404。管理 API 只從主機本身（127.0.0.1:4400）打。

先產生「主金鑰不得直接呼叫模型」的檢查檔（它會讀 `.env` 的主金鑰，產生一個權限 600 的 nginx 設定）：

```bash
sudo bash /opt/costscale/deploy/gen-master-key-guard.sh
```

複製兩個共用片段：

```bash
sudo cp /opt/costscale/deploy/nginx-snippet-costscale-*.conf /etc/nginx/snippets/
```

建立 `/etc/nginx/sites-available/costscale`，內容如下（兩個網域換成你的）：

```nginx
# 儀表板
server {
    listen 80;
    server_name cost.example.com;

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
    listen 80;
    server_name llm.example.com;
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
```

啟用、檢查、重新載入，再申請憑證：

```bash
sudo ln -s /etc/nginx/sites-available/costscale /etc/nginx/sites-enabled/costscale
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot --nginx -d cost.example.com -d llm.example.com
```

### 確認

- 瀏覽器打開 `https://cost.example.com`，用白名單裡的 Google 帳號登入，看得到「總覽」頁。
- 從**你自己的電腦**（不是主機）執行：

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://llm.example.com/key/list
  ```

  要回 `404`。回 `401` 或 `200` 代表管理 API 露出去了，回頭檢查 nginx 設定。

---

## 7. 排程

用 root 執行 `crontab -e`，貼上下面這段。每一行做什麼寫在註解裡，用不到的可以刪掉。

```cron
# 儀表板「新增／移除上游金鑰」的佇列：每分鐘套用一次
* * * * * python3 /opt/costscale/scripts/apply-upstream-key.py >> /var/log/costscale-upstream-key.log 2>&1
# 閘道看門狗：不健康時自動重啟
*/3 * * * * /opt/costscale/scripts/watchdog-litellm.sh
# 預算檢查：超過或接近每月預算時寫告警、寄信
5 * * * * /opt/costscale/scripts/check-budgets.sh >> /var/log/costscale-budgets.log 2>&1
# 匯率（台幣顯示用）與訂閱月費入帳
20 5 * * * /opt/costscale/scripts/run-fx-fetch.sh >> /var/log/costscale-fx.log 2>&1
# 訂閱剩餘額度（有裝訂閱橋接才需要）
*/15 * * * * /opt/costscale/scripts/run-sub-usage-fetch.sh >> /var/log/costscale-sub-usage.log 2>&1
# 專案看板同步 GitHub（有用看板才需要）
*/30 * * * * /opt/costscale/scripts/run-board-sync.sh >> /var/log/costscale-board.log 2>&1
# Vertex 用量與 GCP 帳單（有用 Google Cloud 才需要）
17 * * * * /opt/costscale/scripts/run-gcp-fetch.sh >> /var/log/costscale-gcp.log 2>&1
40 6 * * * /opt/costscale/scripts/run-billing-fetch.sh >> /var/log/costscale-billing.log 2>&1
```

讓腳本可以執行：

```bash
chmod +x /opt/costscale/scripts/*.sh /opt/costscale/deploy/*.sh
```

### 確認

```bash
/opt/costscale/scripts/run-fx-fetch.sh
```

沒有錯誤訊息，儀表板上的台幣金額就會出現。

---

## 8. 發第一把虛擬金鑰，打一次看看

1. 儀表板 →「應用程式」→「新增軟體」，取個名字（例如 `test-app`），模型限制先不選。
2. 畫面會顯示一次金鑰（`sk-` 開頭），**只顯示這一次**，先複製起來。
3. 在任何一台電腦執行（金鑰與網域換成你的，模型換成你有填金鑰的那個）：

   ```bash
   curl -s https://llm.example.com/v1/chat/completions -H "Authorization: Bearer sk-你的虛擬金鑰" -H "Content-Type: application/json" -d '{"model":"gemini-flash-free","messages":[{"role":"user","content":"用一句話自我介紹"}]}'
   ```

4. 有回答就成功了。回到儀表板「總覽」，幾秒內會看到這一筆呼叫與花費。

主機上也可以用指令發金鑰（給沒有瀏覽器的專案 AI 用）：

```bash
/opt/costscale/scripts/issue-key.sh test-app2 "說明文字"
```

之後要讓專案接上閘道，把 `https://llm.example.com/v1` 當成 OpenAI 相容的 base URL、虛擬金鑰當 API key 即可。「應用程式」頁每一列都有可以直接複製的接入範例。

---

## 9. 訂閱橋接（選用）

讓專案透過閘道使用你**已經付費的訂閱**（Claude Code、Codex、Antigravity），不另外花 API 費用。橋接跑在你家裡那台 Windows 電腦上，透過 SSH 反向隧道接到雲端主機。

> **只給你自己用的專案用。** 把訂閱額度拿去服務付費客戶，等於轉賣訂閱，會違反各家的服務條款，帳號被停權時你自己的 CLI 也會一起不能用。付費產品請走 API 金鑰。

### 9.1 雲端主機上

允許反向隧道綁到 Docker 網路的位址（只綁內部位址，不對外開放）：

```bash
sudo bash /opt/costscale/deploy/enable-gatewayports.sh
```

如果主機有開 ufw 防火牆，讓容器連得到隧道的埠：

```bash
sudo ufw allow from 10.87.213.0/24 to 10.87.213.1 port 8788 proto tcp
```

> 這套軟體把 Docker 網段固定在 `10.87.213.0/24`（見 `docker-compose.yml` 最後一段），橋接靠它。這一段不在 Docker 自動分配的範圍內，一般不會撞到。萬一主機本身的網路也用這一段，`docker compose up` 會報 `Pool overlaps`，照 `docker-compose.yml` 裡的註解把幾個檔案一起改。

### 9.2 Windows 電腦上：前置條件

| 項目 | 怎麼確認 |
|---|---|
| Node.js 20 以上 | PowerShell 執行 `node -v` |
| OpenSSH 用戶端（Windows 10／11 內建） | 執行 `ssh -V` |
| Claude Code 已登入（要用 `sub-claude` 才需要） | 執行 `claude --version` |
| Codex CLI 已登入（要用 `sub-codex`、`sub-imagegen` 才需要） | 執行 `codex --version` |
| Antigravity 的 `agy`（要用 `sub-gemini`、`sub-agy-claude` 才需要） | 在 Antigravity 裡執行 CLI 安裝，會裝到 `%LOCALAPPDATA%\agy\bin\agy.exe` |

### 9.3 讓這台電腦免密碼登入雲端主機

橋接要在背景自己連線，所以要用 SSH 金鑰登入，不能問密碼。

```powershell
ssh-keygen -t ed25519
```

一路按 Enter（不要設密碼）。然後把公鑰加到主機上（`root@203.0.113.10` 換成你的主機）：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@203.0.113.10 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

確認不用密碼就能登入：

```powershell
ssh -o BatchMode=yes root@203.0.113.10 echo ok
```

要印出 `ok`。

### 9.4 設定環境變數

三個值存成「使用者環境變數」，只存在這台電腦的 Windows 設定裡，不會寫進任何檔案。

`BRIDGE_TOKEN` 要與雲端主機 `.env` 裡的 **`BRIDGE_TOKEN` 完全相同**：

```powershell
[Environment]::SetEnvironmentVariable('BRIDGE_TOKEN', '貼上主機 .env 裡的 BRIDGE_TOKEN', 'User')
```

雲端主機的 SSH 位址：

```powershell
[Environment]::SetEnvironmentVariable('COSTSCALE_VPS_SSH', 'root@203.0.113.10', 'User')
```

Claude Code 的長效權杖：先執行 `claude setup-token` 取得權杖，再執行下面這支腳本貼上（畫面不會顯示你貼的內容）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-claude-token.ps1
```

用 Antigravity 而 `agy` 不在 PATH 裡的話，另外設 `BRIDGE_AGY` 為 `agy.exe` 的完整路徑。

**設完環境變數之後，關掉所有 PowerShell 視窗再開一個新的**，新值才會生效。

### 9.5 安裝成登入時自動啟動

把整個 `bridge` 資料夾放在固定位置（之後不要搬），然後：

```powershell
powershell -ExecutionPolicy Bypass -File bridge\install-task.ps1
```

看到 `[通過] 橋接服務已回應 /health` 就是本機這一段通了。它會在每次登入時自動啟動，並持續看顧隧道，斷線自動重連。

### 9.6 確認

在**雲端主機**上執行：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.87.213.1:8788/health
```

要回 `200`。然後用第 8 節的虛擬金鑰打一次 `sub-claude`（把 `model` 換成 `sub-claude`），有回答就完成了。

家裡電腦關機時 `sub-*` 會打不通，這是正常的，閘道不會自動改打付費模型——要不要退回別的模型，由你的專案自己決定。電腦重新開機後若 `sub-*` 仍打不通，在主機上重啟閘道一次：

```bash
cd /opt/costscale && docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full restart litellm
```

更多細節（各家的權限限制、額度保留線、產圖）見 `bridge/README.md`。

---

## 10. 訂閱用量收集器（選用）

先分清楚兩種用量：

| 用量 | 怎麼被記錄 |
|---|---|
| 專案透過閘道打的 API（虛擬金鑰） | **閘道自己記帳**，裝好第 1～8 節就有，不需要這一節 |
| 你自己在電腦上用 Claude Code、Codex（訂閱） | 不經過閘道，要在那台電腦裝**用量收集器**才收得到 |

收集器把 token 數字回報到儀表板，「總覽」頁的「訂閱省下多少」才算得出來。不會送出任何對話內容。每台有在用 CLI 的電腦各裝一次，裝幾台都可以。

1. 把整個 **`collector`** 資料夾複製到那台 Windows 電腦（放桌面就可以）。
2. 雙擊 **`1-安裝.bat`**。
3. 照畫面貼上兩個值：儀表板網址（`.env` 的 `AUTH_URL`）與回報 token（`.env` 的 `OTEL_INGEST_TOKEN`）。
   它會先試著回報一次，網址或 token 不對會直接告訴你，不會裝一個送不出去的東西。
4. 它會自動偵測這台用過 Claude Code 還是 Codex，只裝收得到的。按 Enter 關閉視窗就完成了。

之後每 30 分鐘在背景回報一次，沒有視窗、不需要系統管理員。要裝很多台、不想每台都貼一次，
或想知道怎麼確認它在跑、怎麼移除，見 `collector/README.md`。

---

## 11. 專案看板（選用）

儀表板的「專案看板」讀各專案 repo 裡的 `doc/status.json` 顯示進度。

- 讓 AI 幫你產生 `status.json`：把 `claude-skill/update-project-status` 整個資料夾複製到 `%USERPROFILE%\.claude\skills\`，之後在任何專案裡對 Claude Code 說「更新進度」。
- 讓每台電腦自動推送進度、並能從看板一鍵開啟專案：見 `helper/README.md`。
- 讀 GitHub 上的 repo：`.env` 填 `GITHUB_TOKEN`（只需要讀取權限）。

---

## 12. 更新到新版

```bash
cd /opt/costscale && git pull
```

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d --build
```

**新版如果多了 `db/init/` 底下的 SQL 檔，要手動套用一次。** 資料庫只在第一次建立時自動執行那個資料夾，之後不會再跑。例如新增了 `28-xxx.sql`：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec -T db psql -U costscale -d costscale < db/init/28-xxx.sql
```

`git pull` 之前可以用 `git diff --stat HEAD origin/main -- db/init` 看有沒有新的 SQL 檔。

**`27-manual-subscription-charges.sql` 要跟程式一起更新，不能只做一邊**（2026-09-21）。
它把訂閱扣款的唯一性從「整張表」縮小成「只管自動入帳」，好讓人能在同一天補一筆升級差額。
`scripts/fetch-fx.py` 的寫入語法必須配合那個索引——只更新程式沒套 SQL，或只套 SQL 沒更新程式，
每天的訂閱月費凍結都會失敗（錯誤訊息是 `no unique or exclusion constraint matching`）。
套完用這個確認當天的入帳還跑得動：

```bash
cd /opt/costscale && bash scripts/run-fx-fetch.sh
```

---

## 13. 打不通的時候

| 現象 | 原因 | 怎麼辦 |
|---|---|---|
| 儀表板登入後回到登入頁 | 你的帳號不在 `AUTH_ALLOWED_EMAILS` | 加進去後重啟 dashboard |
| Google 登入顯示 `redirect_uri_mismatch` | OAuth 的重新導向 URI 與 `AUTH_URL` 不一致 | 第 4 節的網址要與 `AUTH_URL` 完全相同 |
| 專案收到 `401` | 虛擬金鑰錯了或已撤銷 | 到「應用程式」頁重新簽發 |
| 專案收到 `429`，訊息含 `budget_exceeded` | 那個軟體超過了它的每月上限 | 到「應用程式」頁提高或解除上限。**專案端不要自動重試這個錯誤** |
| `400 no healthy deployments` | 那個模型沒有可用的上游金鑰，或 `sub-*` 橋接沒連上 | 檢查 `.env` 的金鑰；橋接見第 9.6 節 |
| `sub-*` 回 `429`，訊息在講額度 | 橋接的額度保留線：該訂閱剩餘不到 20% | 等額度重設，或改走 API 模型 |
| 「新增上游金鑰」一直停在排隊中 | 第 7 節的 `apply-upstream-key.py` 排程沒裝，或 spool 目錄權限不對 | 補排程；重做第 5 節的 `chown` |
| `docker compose up` 報 `Pool overlaps` | 主機本身的網路也用 10.87.213.0/24 | 見第 9.1 節 |
| 儀表板金額全是 0 | 還沒有任何呼叫經過閘道 | 先做第 8 節 |

完整的操作說明在儀表板右上角的「使用說明」。

---

## 14. 在自己電腦上開發儀表板

見 `dashboard/README.md`。只提醒一件事：單獨執行 `npx tsc --noEmit` 做型別檢查之前，要先執行一次 `npx next typegen`，否則會出現一堆 `RouteContext` 找不到的錯誤。`npm run build` 會自己處理，不受影響。

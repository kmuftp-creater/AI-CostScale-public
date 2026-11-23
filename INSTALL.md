# AI CostScale 安裝說明

先看下一節「我該選哪一種安裝方式」。只想在自己電腦上看花費：用「在自己電腦上安裝」，只需要 Docker。要裝在雲端主機：想省事就用「快速安裝」，一支腳本做完第 1 到 7 節；要手動安裝，或腳本停住了要對照排錯，才照順序做第 1 到第 8 節。第 9 節以後都是選用：訂閱橋接、用量收集器、專案看板，要用再裝。

每一節最後都有一個「確認」步驟。**確認沒過就不要往下做**，後面的步驟都建立在前面的結果上。

---

## 我該選哪一種安裝方式

| | 在自己電腦上安裝 | 雲端主機安裝 |
|---|---|---|
| 適合誰 | AI 專案都在自己這台電腦上跑，想看花費，不熟伺服器 | 專案分散在多台電腦、雲端服務、機器人，或要給別人用 |
| 要準備什麼 | Docker（Windows、Mac 裝 Docker Desktop，Linux 裝 Docker Engine） | 一台 Ubuntu 主機、兩個網域 |
| 儀表板網址 | `http://localhost:3000`，只有這台電腦打得開 | `https://你的網域` |
| 登入 | 管理員帳號密碼 | 管理員帳號密碼，可另外開 Google 登入 |
| 誰連得到閘道 | 只有這台電腦上的程式 | 任何拿到虛擬金鑰的程式與服務 |
| 電腦關機時 | 閘道不通，也不記帳 | 照常運作 |
| 閘道看門狗、儀表板新增上游金鑰 | 沒有 | 有 |
| 安裝時間 | 約 10 分鐘（含下載與建置） | 約 10 分鐘，另加申請網域與 DNS 生效的時間 |
| 之後想換成另一種 | 重新安裝；本專案沒有提供搬資料的工具 | 同左 |

不確定的話，先選「自己電腦」：裝好之後 10 分鐘內就看得到儀表板，不滿意可以完整移除（見本節的「停止、啟動與完整移除」）。要讓別台電腦、雲端服務、別人的程式呼叫閘道，才需要雲端主機安裝（下一節「快速安裝」）。

---

## 0. 雲端主機安裝完長什麼樣子

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
- **儀表板**看花費、發金鑰、設每月上限。預設用管理員帳號密碼登入，不用設定 Google；也可以另外開啟 Google 登入（白名單制）。
- **訂閱橋接**是選用的。沒裝的話 `sub-*` 這幾個模型打不通，其他一切照常。

---

## 在自己電腦上安裝（不需要主機與網域）

### 適合誰

你的 AI 專案都在自己這台電腦上跑（網站、腳本、機器人、桌面工具），想知道每個專案花了多少錢。這一節只需要 Docker：不用租主機、不用網域、不用 nginx 與 HTTPS、不用 Google 帳號，不用裝 bash 或 python。

### 前置條件

1. **Docker。**
   - Windows、Mac：安裝 Docker Desktop，下載頁 <https://www.docker.com/products/docker-desktop/>。裝好後**先打開它**，等視窗左下角顯示引擎執行中（Engine running）再繼續。以後每次要用儀表板，Docker Desktop 都要開著。
   - Linux：安裝 Docker Engine 與 Compose 外掛，步驟見 <https://docs.docker.com/engine/install/>。
   - 確認：在終端機（Windows 開 PowerShell）執行 `docker compose version`，要顯示 `v2.24.4` 或更新的版本。
2. 取得程式碼用的工具：`git`，或是直接到 GitHub 頁面按「Code → Download ZIP」下載後解壓縮。
3. 約 5 GB 的磁碟空間（映像與資料庫），以及連得上外網的網路（下載映像、建置時下載字型）。
4. 想好一組管理員密碼（至少 10 個字元）。一把 Gemini 免費金鑰可以現在建立：<https://aistudio.google.com/apikey>，也可以之後再加。
5. 這台電腦的 3000、4000、5442 三個埠沒有被別的程式佔用。被佔用也沒關係，裝好之後改埠即可（見下方「常見問題」）。

### 三步安裝

指令在 Windows PowerShell、Mac 與 Linux 的終端機都相同，每一步都只有一行。

**步驟 1：取得程式碼。**程式碼放在哪個資料夾都可以，路徑含空白或中文也可以。

```
git clone https://github.com/kmuftp-creater/AI-CostScale-public.git costscale
```

```
cd costscale
```

用下載 zip 的話，解壓縮之後在這個資料夾裡開終端機（Windows：在資料夾空白處按住 Shift 按右鍵，選「在此處開啟 PowerShell 視窗」），以下指令都在這個資料夾裡執行。

**步驟 2：設定。**

```
docker compose -f docker-compose.setup.yml run --rm setup
```

第一次執行會先下載 `python:3.12-slim` 映像（約 50 MB）。接著依序問你三題：

| 問題 | 怎麼答 |
|---|---|
| 管理員帳號 | 直接按 Enter 用 `admin`。要英數開頭，其餘只收英數與 `.` `_` `-`，3 到 32 個字元 |
| 管理員密碼 | 輸入兩次，**輸入時畫面不會顯示任何字元**（這是正常的），至少 10 個字元，兩次不一樣會重問 |
| Gemini 免費金鑰 | 貼上金鑰後按 Enter（輸入時同樣不顯示），沒有就直接按 Enter 跳過 |

做完會看到「已建立 .env」與重點清單，最後印出下一步的指令。資料庫密碼、閘道主金鑰等亂數祕密由工具自動產生；`.env` 裡只存密碼的雜湊，不存密碼本身；密碼與金鑰都不會印在畫面上。專案資料夾裡會多出 `.env` 這個檔案，**裡面有祕密，不要傳給別人、不要上傳到網路**。

這個步驟也可以不問問題（寫腳本或不想互動時），見下方「設定工具的進階用法」。

**步驟 3：啟動。**

```
docker compose up -d --build
```

第一次要下載閘道映像並建置儀表板，約 3 到 10 分鐘，中間畫面會捲動很多行，請等它跑完。結束時最後幾行是 `Container ... Started`，指令退出碼為 0。

之後開瀏覽器到 `http://localhost:3000`，用步驟 2 設定的帳號密碼登入。

設定工具建立 `.env` 時，已經替你挑好一個不常撞的 Docker 網段（隨機的私有 `/24`，寫在 `.env` 的 `COSTSCALE_SUBNET` 與 `COSTSCALE_GATEWAY`），避開 Docker 與家用路由器常用的範圍。萬一啟動時還是報 `Pool overlaps`（網段撞到這台電腦上別的 Docker 網路），重新執行設定工具、選 `6) 換一個網段`，再依畫面提示執行 `docker compose down` 與 `docker compose up -d` 即可，不需要自己查哪個網路佔用了哪個網段。

### 怎麼確認成功

1. 執行 `docker compose ps`。要看到四個服務都在執行：`db`、`litellm`、`dashboard`、`scheduler`，其中 `db` 與 `litellm` 的狀態要顯示 `(healthy)`。閘道第一次啟動約需 30 秒到 1 分鐘，剛啟動時顯示 `(health: starting)` 是正常的。
2. 瀏覽器開 `http://localhost:3000`，會先導到登入頁；登入後看到總覽，最上方有「上手清單」。
3. 清單的第 1 步（放入 AI 供應商金鑰）在步驟 2 貼了金鑰的話已經打勾。第 4 步（確認排程有在跑）會在啟動後 1 到 3 分鐘內自動打勾：排程容器啟動後先安裝套件（約 30 秒），再抓第一次匯率。看排程容器的紀錄：

   ```
   docker compose logs scheduler
   ```

   要看到 `[匯率] 成功` 與（啟動約 2 分鐘後）`[預算] 成功` 各一行。
4. 第 2、3 步照第 8 節做：在「應用程式」新增軟體取得虛擬金鑰，再打一次呼叫。網址換成 `http://localhost:4000`：

   Windows PowerShell（整段貼上，會直接印出回答文字）：

   ```powershell
   $body = '{"model":"gemini-flash-free","messages":[{"role":"user","content":"用一句話自我介紹"}]}'
   $f = New-TemporaryFile
   Invoke-RestMethod -Uri "http://localhost:4000/v1/chat/completions" -Method Post -Headers @{ Authorization = "Bearer sk-你的虛擬金鑰" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -OutFile $f
   (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).choices[0].message.content
   Remove-Item $f
   ```

   為什麼比 `curl` 長：PowerShell 裡的 `curl` 是另一個指令（`Invoke-WebRequest` 的別名），bash 的 `-H` 寫法會報 `Cannot bind parameter 'Headers'`。內容改用 UTF-8 位元組送出，中文才不會變亂碼；回應先存成暫存檔再用 UTF-8 讀回，是因為 Windows PowerShell 5.1 會把沒有標示字元集的回應當成 Latin-1 解碼，中文回答會變成亂碼。

   macOS、Linux（Windows 的 Git Bash 也可以）：

   ```bash
   curl -s http://localhost:4000/v1/chat/completions -H "Authorization: Bearer sk-你的虛擬金鑰" -H "Content-Type: application/json" -d '{"model":"gemini-flash-free","messages":[{"role":"user","content":"Introduce yourself in one sentence, in Traditional Chinese."}]}'
   ```

   這一行的內容刻意用英文：Git Bash 把含中文的指令列轉給 `curl` 時編碼會壞掉，閘道會回 `400`（`Missing required parameter: messages`）。英文內容加上「用繁體中文回答」，回答照樣是中文。

   Gemini 免費額度的上游偶爾回 `503`（`high demand`），過幾秒再打一次即可。`gemini-flash-free` 設定檔裡有 5 個部署（對應 `GEMINI_FREE_KEY_1` 到 `5`）：閘道啟動時只載入「已經填了真金鑰」的部署，所以只放一把金鑰也不會輪到佔位字而回 `401`。之後補上第 2 把金鑰時（見下方「加 AI 金鑰」），閘道重建後會自動把第 2 個部署加進輪替。

   在 Docker 容器裡跑的專案，網址用 `http://host.docker.internal:4000`（Docker Desktop；Linux 要替那個容器加 `--add-host=host.docker.internal:host-gateway`）。

### 加 AI 金鑰

本機安裝模式的儀表板**不能**在網頁上新增金鑰：「金鑰管理」頁的「新增上游金鑰」那一塊會改顯示本機做法，按移除或改設定也會被擋下並說明原因（原因：那些操作要排進佇列，由雲端主機上的排程套用，本機模式沒有那支排程，送出的請求會永遠排隊）。正式做法是再跑一次設定工具：

```
docker compose -f docker-compose.setup.yml run --rm setup
```

選 `2) 新增 AI 金鑰`，選供應商、貼上金鑰（輸入時畫面不顯示）。可以選 Gemini 免費額度、Groq、OpenRouter、Gemini 付費金鑰。工具把金鑰填進第一個還是空的欄位（例如 `GEMINI_FREE_KEY_2`），欄位都滿了會告訴你要編輯 `.env` 的哪一行。然後執行這一行讓閘道讀到新金鑰（閘道會重建，約 30 秒內打不通）：

```
docker compose up -d
```

設定工具不會先向供應商驗證金鑰。要確認金鑰有效，到「金鑰管理」頁看新金鑰有沒有出現尾 4 碼，再照上面第 4 點打一次呼叫。

只放一把金鑰就能用；要放第 2 把，照上面做一次（選 `2) 新增 AI 金鑰`，再 `docker compose up -d`）。閘道每次啟動時，只載入「金鑰不是佔位字」的部署：Gemini 免費額度與 Groq 這種多把金鑰輪替的模型，填了幾把就輪替幾把，填滿 5 把（Groq 是 3 把）時所有部署都載入，行為與一般輪替完全相同。重建後閘道的紀錄（`docker compose logs litellm`）會有一行 `[cs-entry]`，說明哪幾個欄位還是佔位字、因此沒有載入。

### 移除一把金鑰

重新執行設定工具，選 `3) 移除 AI 金鑰`，選要移除的那一把。工具把那一欄改回 `placeholder`（範本的原樣），並更新尾碼表。然後執行：

```
docker compose up -d
```

閘道重建後不再使用那把金鑰，儀表板「金鑰管理」頁的尾碼也會跟著消失。要讓那把金鑰真正作廢，還要到供應商的後台（例如 Google AI Studio）把它停用或刪除，設定工具做不到這件事。

不問問題的做法（欄位名見 `.env`，例如 `GEMINI_FREE_KEY_2`）：

```powershell
$env:CS_ACTION = "remove-key"; $env:CS_REMOVE_KEY = "GEMINI_FREE_KEY_2"
docker compose -f docker-compose.setup.yml run --rm setup
Remove-Item Env:CS_ACTION, Env:CS_REMOVE_KEY
```

手動改 `.env`（把那一行等號後面改回 `placeholder`）也可以，但改完要再執行一次設定工具（選 `1`）才會更新尾碼表，不然儀表板還會顯示舊的尾碼。

### 怎麼改密碼

不需要 bash，一樣用設定工具：

```
docker compose -f docker-compose.setup.yml run --rm setup
```

選 `4) 更改管理員帳號或密碼`，照畫面輸入。然後執行這一行，只重建儀表板：

```
docker compose up -d dashboard
```

舊密碼的登入狀態在新設定生效後一併失效。

### 設定工具的進階用法

已經有 `.env` 時，設定工具**不會覆蓋**它：

- 互動執行會先顯示選單（補齊缺少的欄位、新增 AI 金鑰、移除 AI 金鑰、更改管理員帳號或密碼、更改埠號、換一個網段）。
- 非互動執行（沒有終端機，或加 `-T`）只做「補齊缺少的欄位」：缺的欄位用預設值補上，還是範本值的祕密換成新的亂數，`AUTH_DISABLED` 不是 `0` 就改回 `0`，已有的值一律不動。什麼都不用補時，`.env` 的內容完全不變。

不問問題、直接用環境變數提供答案（缺少必要的值會報錯結束）：

| 環境變數 | 說明 |
|---|---|
| `CS_ADMIN_USER` | 管理員帳號，省略時用 `admin` |
| `CS_ADMIN_PASSWORD` | 管理員密碼。第一次設定必填 |
| `CS_GEMINI_FREE_KEY`、`CS_GROQ_KEY`、`CS_OPENROUTER_KEY`、`CS_GEMINI_PAID_KEY` | 各家的 AI 金鑰，可省略 |
| `CS_DASH_PORT`、`CS_GATEWAY_PORT`、`CS_DB_PORT` | 三個埠，省略時用 3000、4000、5442 |
| `CS_REMOVE_KEY` | `remove-key` 要移除的金鑰欄位名，例如 `GEMINI_FREE_KEY_2` |
| `CS_SUBNET` | `subnet` 要換成的 Docker 網段，要是私有網段的 `/24`，例如 `10.97.45.0/24`；沒給就隨機挑一個 |
| `CS_ACTION` | `init`（預設）、`add-key`、`remove-key`、`password`、`ports`、`subnet`，對應選單的選項 |

PowerShell 範例（用完把密碼從環境變數移除；不要把密碼直接寫在指令列，會留在歷史紀錄）：

```powershell
$env:CS_ADMIN_PASSWORD = "你的密碼"
docker compose -f docker-compose.setup.yml run --rm setup
Remove-Item Env:CS_ADMIN_PASSWORD
```

Mac、Linux：

```bash
read -rs CS_ADMIN_PASSWORD && export CS_ADMIN_PASSWORD
docker compose -f docker-compose.setup.yml run --rm setup
unset CS_ADMIN_PASSWORD
```

其他環境變數（不含密碼的那幾個）在 PowerShell 與 bash 的寫法不同，下面以「把閘道埠改成 14000」為例。PowerShell：

```powershell
$env:CS_ACTION = "ports"; $env:CS_GATEWAY_PORT = "14000"
docker compose -f docker-compose.setup.yml run --rm setup
Remove-Item Env:CS_ACTION, Env:CS_GATEWAY_PORT
```

Mac、Linux 與 Git Bash：

```bash
CS_ACTION=ports CS_GATEWAY_PORT=14000 docker compose -f docker-compose.setup.yml run --rm setup
```

Windows 的 cmd（命令提示字元）：

```
set CS_ACTION=ports
set CS_GATEWAY_PORT=14000
docker compose -f docker-compose.setup.yml run --rm setup
```

在 Git Bash 這類沒有終端機（TTY）的環境直接執行 `run --rm setup`，工具會把自己當成非互動執行，問不了問題，只會說缺少環境變數。想邊問邊答，請改在 PowerShell 或終端機執行。

### 更新到新版

用 git 取得的：

```
git pull
```

```
docker compose up -d --build
```

用 zip 的：下載新版 zip 解壓縮到新的資料夾，把舊資料夾的 `.env` 與 `spool` 資料夾複製進去，再在新資料夾執行 `docker compose up -d --build`。資料庫放在 Docker 的資料卷 `costscale_dbdata`，與資料夾無關，換資料夾不會遺失資料。

新版如果多了 `db/init/` 底下的 SQL 檔，要手動套用一次（第 12 節有哪些檔案要套）。下面兩行不依賴 shell 的重導向，Windows 也能用，把 `28-xxx.sql` 換成實際檔名：

```
docker compose cp db/init/28-xxx.sql db:/tmp/update.sql
```

```
docker compose exec db psql -U costscale -d costscale -f /tmp/update.sql
```

### 停止、啟動與完整移除

暫時停止（資料保留，之後 `docker compose up -d` 就回來）：

```
docker compose stop
```

移除容器與網路，**資料庫的資料保留**，之後 `docker compose up -d` 可以接著用：

```
docker compose down
```

**完整移除，連資料庫的資料一起刪除。這會永久刪掉所有花費紀錄、軟體與虛擬金鑰，無法復原，執行前先確認真的不要了：**

```
docker compose down -v --rmi local
```

再把專案資料夾刪掉，`.env` 也會一起消失。只刪資料夾、沒有執行上面這行的話，Docker 裡的資料還在，之後重裝會接上舊資料，但新產生的 `.env` 資料庫密碼對不上，閘道與儀表板會連不上資料庫（見常見問題）。

電腦重新開機之後：這四個容器設定了 `restart: unless-stopped`，Docker 啟動時會把沒有手動停止過的容器帶起來（這一點沒有實測整機重新開機，只實測了 `docker compose down` 再 `up -d`）。要讓 Docker Desktop 隨登入自動啟動，到它的設定裡開啟 Start Docker Desktop when you sign in to your computer。

### 限制

本機安裝模式是「看自己電腦上的 AI 花費」用的精簡版，有這些限制：

- **只有這台電腦上的程式連得到閘道與儀表板。**埠一律只綁在 `127.0.0.1`。**不要把埠改成對外**（例如把 `127.0.0.1` 換成 `0.0.0.0`）：本機模式沒有 nginx 擋在前面，也沒有 HTTPS，直接對外等於把登入頁與閘道裸露在網路上。要給別台電腦、雲端服務使用，請改用雲端主機安裝。
- **電腦關機、或 Docker 沒開，閘道就不通，也不會記帳。**專案要自己處理閘道連不上的情況。
- **沒有閘道看門狗。**容器當掉時 Docker 會依 `restart: unless-stopped` 重啟，但「還活著卻不健康」的閘道不會被自動重啟；發現打不通時執行 `docker compose restart litellm`。
- **儀表板不能直接新增、移除上游金鑰，也不能改模型單價與模型對應。**這些操作要由主機端排程套用，要操作 Docker，本機模式不提供。加金鑰用上面的設定工具；改模型設定要編輯 `litellm-config.yaml` 後執行 `docker compose restart litellm`。「金鑰管理」頁的「可用模型」清單由主機排程每 6 小時抓一次，本機模式沒有這支排程，那一欄會一直顯示尚未抓取。
- **登入鎖定是全站共用一組。**本機沒有 nginx，儀表板不信任 `X-Forwarded-For`，所有來源算同一個。連續輸錯 5 次，整個登入鎖 15 分鐘（含你自己）。要立刻解除：`docker compose up -d --force-recreate dashboard`。
- **這些選用功能不在本機模式的範圍，沒有測試過：**訂閱橋接（第 9 節）、訂閱用量收集器（第 10 節）、專案看板（第 11 節）、Vertex AI、GCP 用量與帳單抓取。它們需要的主機路徑（`/root/vertex-sa.json`）、SSH 隧道、cron 排程在本機模式都沒有準備，儀表板上對應的區塊會顯示「沒有資料」。
- **排程只有兩支：**匯率與訂閱月費入帳、預算檢查，各每小時一次，由 `scheduler` 容器執行（紀錄用 `docker compose logs scheduler` 看）。電腦關機期間不執行，開機後補跑一次；電腦睡眠期間也不執行，醒來後立刻補跑一次（排程用「牆上時間」判斷到期，用假時鐘驗證過：睡 8 小時醒來每支只補跑一次。假設 Docker Desktop 會在電腦醒來後把虛擬機的時鐘校正，真的讓電腦睡眠再醒來這一點沒有實機測過）。預算超標的告警會顯示在儀表板橫幅；要收告警信，在 `.env` 填 `ALERT_EMAIL_TO` 與 `SMTP_*`，再執行 `docker compose up -d`。
- **網路網段由設定工具在建立 `.env` 時隨機挑一個私有 `/24`**（寫在 `COSTSCALE_SUBNET`，避開 `172.16` 到 `172.31`、`192.168.0`、`192.168.1`、`10.0.0`）。更早建立的 `.env` 沒有這兩個欄位，沿用預設的 `10.87.213.0/24`（雲端主機模式的訂閱橋接需要它）。撞到別的網路時，重新執行設定工具選 `6) 換一個網段`，見常見問題。
- **排程容器每次啟動要從 PyPI 安裝 `psycopg`（固定為 3.3.9 版）。**離線時安裝會失敗，每 15 秒重試一次，排程在連上網路之前不會執行。

### 常見問題

| 現象 | 原因 | 怎麼辦 |
|---|---|---|
| 執行任何 `docker` 指令都報連不上 Docker。Windows 實測的訊息開頭是 `failed to connect to the docker API at npipe:...; check if the path is correct and if the daemon is running`；Mac、Linux 沒有實測，訊息文字不同（例如 `Cannot connect to the Docker daemon`），意思相同 | Docker Desktop 沒開，或還在啟動 | 打開 Docker Desktop，等到顯示引擎執行中，再重新執行同一行指令 |
| 啟動時報 `Error response from daemon: failed to set up container networking: ... Bind for 127.0.0.1:4000 failed: port is already allocated`（實測：4000 被另一個 Docker 容器佔用時的原文；被 Docker 以外的程式佔用時，結尾的原因文字不同，但一樣有 `Bind for 127.0.0.1:埠號 failed`） | 訊息裡那個埠（這裡是 4000；儀表板是 3000、資料庫是 5442）已經被這台電腦上的另一個程式佔用。這時其他服務照常起來，只有那一個服務停在 `Created`（沒有啟動） | 執行設定工具，選 `5) 更改埠號`，把被佔用的那個改成沒人用的（例如閘道改 14000），再 `docker compose up -d`，那個服務就會起來。非互動做法：把環境變數 `CS_ACTION` 設成 `ports`、`CS_GATEWAY_PORT` 設成 `14000`（PowerShell、bash、cmd 的寫法見上方「設定工具的進階用法」）。設定工具會一併更新 `.env` 裡的 `AUTH_URL` 與 `GATEWAY_PUBLIC_URL` |
| 啟動時報 `failed to create network costscale_default: Error response from daemon: invalid pool request: Pool overlaps with other one on this address space` | 另一個 Docker 網路（例如先前裝過的 AI CostScale，即使它的容器已經停止）佔用了 `10.87.213.0/24` | 重新執行設定工具，選 `6) 換一個網段`（它會隨機挑一個新的私有網段），再依序執行 `docker compose down` 與 `docker compose up -d`（`down` 不加 `-v`，資料都保留）。不想互動的話：把環境變數 `CS_ACTION` 設成 `subnet`，執行同一支設定工具；要指定網段再多設 `CS_SUBNET`（例如 `10.97.45.0/24`）。不需要自己查哪個網路佔用了哪個網段 |
| 建置時出現 `font/google` 之類的錯誤 | 建置儀表板時要連 `fonts.googleapis.com` 下載字型，網路暫時不通 | 建置步驟已自動重試 3 次；仍失敗就等網路恢復，重新執行同一行 `docker compose up -d --build`，不會從頭來過 |
| 打開 `http://localhost:3000` 沒有回應 | 儀表板還在啟動，或 Docker 沒開 | 等 30 秒；執行 `docker compose ps` 與 `docker compose logs dashboard` 看狀態 |
| 登入頁寫「登入功能已停用：AUTH_SECRET 還沒設好」 | `.env` 的 `AUTH_SECRET` 是空值、範本預設值或短於 32 個字元 | 重新執行設定工具（選 `1`），它會補上新的亂數，再 `docker compose up -d dashboard` |
| 登入頁寫「還沒有設定任何登入方式」 | `.env` 沒有管理員帳號或雜湊 | 執行設定工具選 `4`，再 `docker compose up -d dashboard` |
| 每一頁最上方有紅框橫幅「登入檢查已關閉」 | `.env` 的 `AUTH_DISABLED` 是 `1`，任何連得到儀表板的人都不用密碼就能看花費、發金鑰 | 把 `AUTH_DISABLED` 改成 `0`，再 `docker compose up -d dashboard`；執行設定工具選 `1` 也會把它改回 `0` |
| 每一頁最上方有紅框橫幅「主金鑰是範本值」或「資料庫密碼是範本值」 | `.env` 的 `LITELLM_MASTER_KEY` 或 `DB_PASSWORD` 還是 `.env.example` 的公開預設值 | 見第 13 節的「把範本值換掉」 |
| 登入頁顯示「輸錯次數太多，請等 N 分鐘後再試」 | 連續輸錯 5 次，鎖 15 分鐘（本機模式全站共用） | 等它到期，或 `docker compose up -d --force-recreate dashboard` |
| 上手清單第 4 步一直沒打勾 | `scheduler` 容器沒在跑，或抓匯率失敗（網路不通） | `docker compose ps` 看 `scheduler` 是否在執行；`docker compose logs scheduler` 看失敗原因。排程失敗會每 5 分鐘重試 |
| 「新增上游金鑰」顯示本機安裝模式的說明 | 本機模式不提供這個功能 | 照該畫面與上方「加 AI 金鑰」的做法 |
| 日誌出現 `password authentication failed for user "costscale"` | 刪掉了 `.env`、卻沒有刪資料庫資料卷，新產生的資料庫密碼對不上舊資料 | 找回原本的 `.env` 放回資料夾；確定舊資料不要了，才執行 `docker compose down -v`（會刪除資料），再重做三步 |
| 另一份 AI CostScale 資料夾執行 `docker compose up` 把這份的容器換掉了 | 兩份資料夾的專案名稱都是 `costscale`，Docker 把它們當同一個專案 | 同一台電腦只留一份；一定要並存的話，每個 `docker compose` 指令都加 `-p 另一個名字` |

---

## 快速安裝（雲端主機，建議）

第 1 到 7 節的工作，已經寫成一支互動式腳本 `scripts/install.sh`。它會裝工具、問你幾個問題、產生 `.env`、啟動服務、設定 nginx 與 HTTPS、安裝必要排程。多數人用這一節就夠了，做完直接接第 8 節。

原本的第 1 到 7 節保留，用途是手動安裝，以及腳本停住時對照排錯。

### 前置條件

1. 一台 Ubuntu 22.04 或 24.04 的主機，2 GB 記憶體以上，用 root 登入。
2. 兩個網域，各建一筆 A 紀錄指到這台主機的 IP：一個給儀表板（例如 `cost.example.com`），一個給閘道（例如 `llm.example.com`）。DNS 沒生效時，腳本會停在申請憑證那一步並告訴你怎麼補，其他部分不受影響。網域經過 Cloudflare 代理（橘色雲朵），或主機在 NAT 後面時，解析到的 IP 本來就不是主機的對外 IP，要加 `--skip-dns-check`（見下方「選項」）。網域前面有 Cloudflare 或其他反向代理時，還要另外設定 nginx，讓它認得真正的來源 IP，否則所有人共用同一個輸錯鎖定，做法見第 6 節的「前面有 Cloudflare 或其他反向代理時」。
3. 想好一組管理員帳號與密碼（密碼至少 10 個字元）。腳本會問你，不需要任何 Google 設定。想用 Google 登入的話，再另外準備一組 Google OAuth 用戶端（做法見第 4 節，選用）。
4. 一把 Gemini 免費金鑰，到 <https://aistudio.google.com/apikey> 建立。可以先跳過。

### 三行指令

全新的 Ubuntu 沒有 git，先安裝它（已經有的話這一行可以略過）：

```bash
apt-get update && apt-get install -y git
```

把程式碼放到 `/opt/costscale`，這個路徑不能換：

```bash
git clone https://github.com/kmuftp-creater/AI-CostScale-public.git /opt/costscale
```

執行安裝腳本：

```bash
bash /opt/costscale/scripts/install.sh
```

首次安裝約 5 到 10 分鐘，大部分時間花在下載映像與建置儀表板。apt 與 docker 的大量輸出只寫進紀錄檔 `/var/log/costscale-install.log`，畫面只顯示每個動作的進度；任何一步失敗，會自動印出紀錄檔的最後 30 行與檔案路徑（已去掉 `.env` 裡的祕密值）。完成時會印出每一項確認的通過與否、儀表板網址與下一步。

如果你自己打開紀錄檔，會看到 `debconf: delaying package configuration`、`invoke-rc.d: policy-rc.d denied execution`、`WARNING: Running pip as the 'root' user` 這類訊息，都是安裝套件時的提醒，不是錯誤。真正的失敗以腳本畫面上「安裝在第 N 步停住了」為準。

### 腳本會問什麼

每一題都有一句說明，答案會寫進 `/opt/costscale/.env`。

| 問題 | 怎麼答 |
|---|---|
| 儀表板網域 | 例如 `cost.example.com`。貼整個網址也可以，腳本會自動去掉前面的 `https://` 與後面的斜線 |
| 閘道網域 | 例如 `llm.example.com`，要與儀表板不同；兩個填成一樣時會請你重填 |
| 登入方式 | `1` 帳號密碼（預設，直接按 Enter 就是它，建議）、`2` Google、`3` 兩種都要。**只有 `.env` 裡還沒有任何登入設定時才會問**；已經設好的重跑不會再問、也不會更動 |
| 管理員帳號 | 選 `1` 或 `3` 才問。要以英數開頭，其餘只收英數與 `.` `_` `-`，3 到 32 個字元，直接按 Enter 用 `admin` |
| 管理員密碼 | 選 `1` 或 `3` 才問。輸入兩次、畫面不顯示，至少 10 個字元，兩次不一樣會重問。`.env` 裡只存雜湊，不存明碼 |
| 可登入的 Google 帳號 | 選 `2` 或 `3` 才問。逗號分隔，只有這些帳號能用 Google 登入。只收英數與 `.` `_` `%` `+` `-`，加上 `@` 與網域，逗號前後的空白會自動去掉。帳號密碼登入不看這個清單 |
| Google OAuth 用戶端 ID 與密鑰 | 選 `2` 或 `3` 才問。第 4 節拿到的兩個值；可以按 Enter 跳過（結尾會提醒「還不能登入」）。**只有填了 ID 才會接著問密鑰**；ID 留空就整組跳過 |
| Gemini 免費金鑰 | 可以按 Enter 跳過 |
| Let's Encrypt 信箱 | 憑證快到期時用來通知你；繼續即代表同意 Let's Encrypt 使用條款。**只有 `--tls letsencrypt`（預設）且這台主機還沒有該網域的憑證時才會問**，`--tls selfsigned` 與 `--tls skip` 不會問 |

Google ID、密鑰與 Gemini 金鑰會原樣寫進 `.env`，所以不能含空白、引號（`'` 或 `"`）、`$`、反引號；含有這些字元時腳本會請你重填。管理員密碼不受這個限制（它只以雜湊存放），但不能含換行與控制字元，最長 256 個字元。

答案會存進 `/opt/costscale/.env` 這個設定檔，已經填過的項目重跑時會直接沿用，不再問。

資料庫密碼、閘道主金鑰、登入加密用的 `AUTH_SECRET` 等 6 個亂數，腳本自己產生，不會顯示在畫面上，也不會寫進紀錄檔。

### 選項

HTTPS 的做法用 `--tls` 選擇：

| 選項 | 做什麼 |
|---|---|
| `--tls letsencrypt` | 預設。先檢查兩個網域的 DNS 是否指到這台主機，再向 Let's Encrypt 申請正式憑證。申請期間 nginx 的 80 埠只回應憑證驗證路徑，其他路徑一律 404，儀表板與閘道不會以明文對外；申請失敗時也維持這個狀態，修好後原樣重跑即可 |
| `--tls selfsigned` | 產生自簽憑證，只供內網或測試，瀏覽器會顯示不安全。憑證是非 CA 憑證（`CA:FALSE`），**腳本會把它加入這台主機的系統信任庫**，讓主機上的排程腳本連得上自己的 HTTPS；因此不要用在正式環境，也不要把這張憑證與私鑰（`/etc/ssl/costscale`）帶到別台機器 |
| `--tls skip` | 不動 nginx，HTTPS 由你自己處理 |
| `--skip-dns-check` | 只對 `--tls letsencrypt` 有用：略過 DNS 比對。網域經過 Cloudflare 代理（橘色雲朵）或主機在 NAT 後面時使用。Let's Encrypt 仍要能從外網連到這台主機的 80 埠，申請不到憑證時仍會停下並說明 |

不想被問問題（例如從自動化腳本執行），加 `--non-interactive`，答案改由環境變數 `CS_DASH_DOMAIN`、`CS_GW_DOMAIN`、`CS_ADMIN_USER`、`CS_ADMIN_PASSWORD`、`CS_ALLOWED_EMAILS`、`CS_GOOGLE_ID`、`CS_GOOGLE_SECRET`、`CS_GEMINI_FREE_KEY`、`CS_LE_EMAIL` 提供。登入方式至少要給一種：有給 `CS_ADMIN_PASSWORD` 就設定帳號密碼登入（帳號用 `CS_ADMIN_USER`，省略時是 `admin`），有給 `CS_GOOGLE_ID` 與 `CS_GOOGLE_SECRET` 就設定 Google 登入。兩種都沒給、`.env` 裡也沒有，腳本會報錯結束，不會裝出一個誰都登不進去的系統。

密碼放在環境變數時要注意兩件事：不要把密碼直接打在命令列前面（會留在 shell 歷史），也不要在裝完之後讓它一直留在環境裡。做法是先用 `read -rs` 把密碼讀進變數（輸入時畫面不顯示，也不進歷史），裝完立刻 `unset`：

```bash
read -rs CS_ADMIN_PASSWORD && export CS_ADMIN_PASSWORD
```

```bash
unset CS_ADMIN_PASSWORD
```

完整說明：

```bash
bash /opt/costscale/scripts/install.sh --help
```

### 中途停住怎麼辦

腳本任何一步失敗，都會印出原因、該看哪個檔、紀錄檔的最後 30 行，以及「重新執行同一行指令」。**修好問題後原樣再跑一次即可**：做好的步驟會自動跳過，既有的 `.env` 不會被覆蓋，已產生的亂數不會改變。完整紀錄在 `/var/log/costscale-install.log`。

**唯一的例外是 `AUTH_DISABLED`**：腳本「不改 `.env` 已有的值」，只有這個欄位例外。每次執行時，只要它不是 `0`，腳本就改回 `0`，並在畫面上印出「偵測到 AUTH_DISABLED=1，已改回 0」與原因。原因是設成 `1` 代表儀表板不用登入，任何人連得到網址就能看花費與金鑰；這支腳本是裝正式環境用的，所以不留這個口子。只在本機或內網測試、確定要關掉登入時，請在腳本跑完後再手動把它改回 `1`，並執行下面的 `up -d`。

### 還沒設定任何登入方式的話

互動安裝時選了 Google 又把 ID 留空跳過，腳本結尾的確認項目「至少設定了一種登入方式」會是 `[未通過]`，並提醒「還不能登入儀表板」。這時登入頁會顯示「還沒有設定任何登入方式」，不會放行任何人。最快的補法是設定管理員帳號密碼，不需要 Google：

```bash
bash /opt/costscale/scripts/set-admin-password.sh
```

腳本最後會印出一行 `docker compose` 指令，在 `/opt/costscale` 執行它讓設定生效（`restart` 不會讀到新的 `.env`）。這一行最後面的 `dashboard` 是服務名稱，代表只重建儀表板：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d dashboard
```

要補的是 Google 登入的話：照第 4 節建立 OAuth 用戶端，用 `nano /opt/costscale/.env` 把 `AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET` 換成拿到的值，`AUTH_ALLOWED_EMAILS` 改成你的 Google 信箱，再執行上面那一行 `up -d dashboard`。

### 腳本做了哪些事

| 腳本步驟 | 對應手動章節 |
|---|---|
| 檢查環境：root、Ubuntu 22.04 以上、程式碼在 `/opt/costscale`、記憶體 | 第 1 節 |
| 問答 | 第 3、4 節 |
| 安裝 Docker、git、curl、python3、nginx、certbot、cron（畫面只顯示進度，完整輸出在紀錄檔） | 第 1.1、1.2 節 |
| 產生 `.env`（既有的不覆蓋，只補缺的） | 第 3 節 |
| 建立 `spool/upstream-keys` 與 `/root/vertex-sa.json` 空檔 | 第 5 節 |
| 啟動服務並等到就緒 | 第 5 節 |
| nginx 與 HTTPS（`--tls selfsigned` 時，另外把自簽憑證加入主機的系統信任庫） | 第 6 節 |
| 必要排程（寫在標記行 `# >>> costscale install` 與 `# <<< costscale install` 之間，重跑時取代同一區塊，不動你其他的排程） | 第 7 節 |
| 完整確認、印出摘要與下一步 | 各節的「確認」 |

腳本不會刪資料庫 volume、不會執行 `docker compose down -v`、不會碰防火牆與 SSH 設定。

做完快速安裝，直接跳到第 8 節發第一把金鑰。

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

兩個網域都要在你的 DNS 服務商那邊各建一筆 A 紀錄，指向主機的 IP。紀錄生效前，第 6 節申請憑證會失敗；生效時間短則幾分鐘，長則幾小時，依服務商而定。

### 1.1 安裝 Docker

下面是 Ubuntu 22.04 與 24.04 照 Docker 官方 apt 套件庫的標準步驟。已經裝好 Docker 的主機，直接跳到本節最後的版本確認。**不要用 Ubuntu 預設倉庫的 `docker.io`**，它的 Compose 外掛是另一個套件，版本也跟官方不同。以下指令都用 root 帳號或在前面加 `sudo` 執行，一行一行貼。

```bash
sudo apt update
```

```bash
sudo apt install -y ca-certificates curl
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

```bash
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
```

```bash
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```bash
sudo apt update
```

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

確認 Docker 版本：

```bash
docker --version
```

要看到 `Docker version` 開頭的一行，後面接版本號，例如 `Docker version 28.0.1, build ...`。

```bash
docker compose version
```

要看到 `Docker Compose version` 開頭的一行。版本號要在 2.24.4 以上，有沒有 `v` 前綴都可以（例如 `v2.40.3` 或 `2.40.3`），後面帶的發行版後綴不用管。

### 1.2 安裝其他工具

```bash
sudo apt install -y git curl python3 nginx certbot python3-certbot-nginx cron
```

`cron` 是第 7 節排程要用的。多數雲端主機已內建，這裡一起裝，已經有的話不會重複安裝。

逐項確認，每一行都要印出版本號，沒有 `command not found`：

```bash
git --version
```

要看到 `git version 2.` 開頭。

```bash
curl --version
```

第一行要看到 `curl 7.` 或 `curl 8.` 開頭。

```bash
python3 --version
```

要看到 `Python 3.` 開頭。

```bash
nginx -v
```

要看到 `nginx version: nginx/` 開頭。

```bash
certbot --version
```

要看到 `certbot` 加版本號，例如 `certbot 2.9.0`。

```bash
command -v crontab
```

要印出一個路徑，例如 `/usr/bin/crontab`。

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

用 `nano .env` 打開。用方向鍵移動、直接打字修改；改完按 `Ctrl+O` 再按 Enter 存檔，最後按 `Ctrl+X` 離開。**至少**要改這幾個，每一個都要改，漏掉的欄位不會有任何報錯（例如 `BRIDGE_TOKEN` 還留著 `change-me-bridge-token`），之後才會出問題：

| 欄位 | 填什麼 |
|---|---|
| `DB_PASSWORD` | 資料庫密碼，產生方式見下方 |
| `LITELLM_MASTER_KEY` | 閘道主金鑰，`sk-` 開頭加一段亂數 |
| `AUTH_SECRET` | 登入加密用，產生方式見下方。**不改的話儀表板會拒絕所有登入**：留著範本值（`change-me` 開頭）、空值、或短於 32 個字元，都視為沒設定，登入頁會顯示怎麼補 |
| `AUTH_URL` | 儀表板網址，例如 `https://cost.example.com`（結尾不要斜線） |
| `GATEWAY_PUBLIC_URL` | 閘道網址，例如 `https://llm.example.com` |
| `AUTH_ADMIN_USER`、`AUTH_ADMIN_PASSWORD_HASH` | 管理員帳號與密碼雜湊。**不要手填**，照本節最後的「管理員帳號密碼」用腳本設定。登入方式至少要有這一種或下面的 Google 登入 |
| `AUTH_ALLOWED_EMAILS` | 可以用 Google 登入的帳號，逗號分隔。只用帳號密碼登入的話維持空白（範本預設就是空的）。**有設 SMTP 寄告警信、又沒填 `ALERT_EMAIL_TO` 時，告警信會寄到這個欄位的信箱**，不要留別人的範例信箱 |
| `AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET` | 選用。第 4 節拿到的兩個值；不用 Google 登入就留空 |
| `ALERT_CRON_TOKEN` | 排程呼叫儀表板用，亂數。留範本值或空值時，用它驗證的 API 一律拒絕請求 |
| `OTEL_INGEST_TOKEN` | 用量收集器回報用，亂數。同上 |
| `BRIDGE_TOKEN` | 閘道呼叫訂閱橋接用，亂數。不裝橋接也填一個。橋接服務遇到範本值會拒絕啟動 |
| 供應商金鑰 | 手上有哪一把就填哪一把，其他保留 `placeholder` |

每一個「亂數」（包括 `AUTH_SECRET`）都用這行產生一個新的，不要共用同一個：

```bash
openssl rand -hex 24
```

`LITELLM_MASTER_KEY` 前面自己補上 `sk-`。`AUTH_SECRET` 至少要 32 個字元，這行產生的 48 個字元夠用（要更長可以用 `openssl rand -hex 32`）。

`BOARD_PUSH_TOKEN`、`HUB_API_TOKEN` 是選用的：留空代表停用對應功能；要用就填自己產生的亂數，不要填範本值。

> `AUTH_DISABLED` 必須是 `0`。設成 `1` 會完全跳過登入，任何人都看得到你的花費與金鑰清單。

### 管理員帳號密碼

帳號密碼登入是預設的登入方式，不需要設定 Google。`.env` 裡只存密碼的雜湊（scrypt，不是明碼），產生與寫入都交給下面這支腳本，不要手改這兩個欄位：

```bash
bash /opt/costscale/scripts/set-admin-password.sh
```

腳本會問帳號（Enter 沿用目前的，沒有就是 `admin`）與密碼（輸入兩次、畫面不顯示、至少 10 個字元），只取代 `.env` 裡的 `AUTH_ADMIN_USER` 與 `AUTH_ADMIN_PASSWORD_HASH` 兩行，其他行不動，權限維持 600。最後它會印出一行 `docker compose` 指令，要在 `/opt/costscale` 執行它，新設定才會生效（`restart` 不會讀到新的 `.env`）：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d dashboard
```

最後面的 `dashboard` 是服務名稱，代表**只重建儀表板**。這一點要注意：不帶服務名稱的 `up -d` 會把「設定有變的服務」全部重建，而閘道（`litellm`）是整份讀 `.env` 的，`.env` 任何一行變動它都會被重建，重建期間（約 30 秒）所有接在閘道上的軟體都打不通。改帳號密碼只影響儀表板，所以用上面這一行。

帳號規則：要以英數開頭，其餘只收英數與 `.` `_` `-`，3 到 32 個字元（`-rf`、`...` 這類全符號的帳號不收）。

**改密碼**：同一支腳本再跑一次。`up -d dashboard` 之後，舊密碼立刻登不進去，用舊密碼登入中的瀏覽器也會被登出。

**登出只清除這個瀏覽器的登入狀態**。登入憑證有效期限是 7 天，別的裝置上已登入的瀏覽器、或登出之前被人複製走的憑證，在到期之前仍然有效。要讓所有已登入的裝置立刻失效，改密碼即可：換掉密碼並 `up -d dashboard` 之後，舊密碼簽出的所有憑證全部作廢。懷疑憑證外流時，就這樣做。

**忘記密碼**：沒有「忘記密碼」的信件流程。你在這台主機上有 root 權限，就在主機上重跑同一支腳本設一個新的，再執行 `up -d dashboard`。登入頁本身不能重設密碼，這是刻意的，網路上的人沒有辦法重設。

**連續輸錯會鎖多久**：同一個來源 IP 在 15 分鐘內輸錯 5 次，這個 IP 會被鎖 15 分鐘，鎖定期間即使密碼正確也一律拒絕，登入頁會顯示還要等幾分鐘。換別的 IP 不受影響。另外，全站 15 分鐘內輸錯超過 30 次之後，每一次嘗試都會多等 2 秒，用來拖慢換 IP 狂試的人，也不會把你自己整個鎖在外面。帳號錯與密碼錯顯示同一句話。

鎖定的計數放在儀表板程式的記憶體裡，重啟儀表板容器（例如 `up -d` 重建）就歸零。同一個來源在鎖定前最多只會被驗證 5 次，同時送出很多請求也一樣。鎖定以 nginx 傳來的 `X-Forwarded-For` 為準，所以第 6 節的 nginx 設定一定要用 `$remote_addr` 覆寫它；前面還有 Cloudflare 或其他反向代理的話，要照第 6 節的「前面有 Cloudflare 或其他反向代理時」另外設定，否則所有人會被當成同一個 IP。

**儀表板的 3300 埠只能綁在 `127.0.0.1`**（本文件的 compose 設定就是這樣）。如果你把它改成對外開放，來源 IP 就可以被任意偽造：輸錯鎖定會失效（換個假 IP 就能繼續猜密碼），別人也能冒用你的 IP 把你鎖在外面。要對外一律走 nginx。

在自動化腳本裡不想被問問題：同一支 `set-admin-password.sh` 可以用環境變數 `CS_ADMIN_USER`、`CS_ADMIN_PASSWORD` 提供，有給密碼就不會問任何問題。**密碼放在環境變數時，不要直接打在命令列前面**（會留在 shell 歷史），先用 `read -rs` 讀進變數，用完立刻 `unset`：

```bash
read -rs CS_ADMIN_PASSWORD && export CS_ADMIN_PASSWORD
```

```bash
bash /opt/costscale/scripts/set-admin-password.sh
```

```bash
unset CS_ADMIN_PASSWORD
```

---

## 4. 建立 Google 登入（選用）

只用帳號密碼登入的話，這一節整節跳過。要加上 Google 登入才做：

1. 到 Google Cloud Console →「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型選「網頁應用程式」。
3. 「已授權的重新導向 URI」填：

   ```
   https://cost.example.com/api/auth/callback/google
   ```

   （換成你自己的儀表板網域。要與 `.env` 的 `AUTH_URL` 完全一致，結尾不要多一個斜線，否則登入時會出現 `redirect_uri_mismatch`）
4. 建立後把「用戶端 ID」填進 `.env` 的 `AUTH_GOOGLE_ID`，「用戶端密鑰」填進 `AUTH_GOOGLE_SECRET`，並把可以登入的 Google 信箱填進 `AUTH_ALLOWED_EMAILS`（逗號分隔）。ID 與密鑰都是真值才會啟用 Google 登入，登入頁才會出現「使用 Google 登入」按鈕。
5. 改完 `.env` 照第 13 節的「改完 `.env` 怎麼生效」重建儀表板。

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

閘道的 Vertex AI 服務帳戶金鑰固定掛載主機上的 `/root/vertex-sa.json`。**不用 Vertex 也要先建一個空檔**，否則 Docker 會在主機上建出一個同名的「資料夾」，之後放不進真的金鑰檔。要用 Vertex 時，直接把真的金鑰檔覆蓋到這個路徑：

```bash
touch /root/vertex-sa.json
```

啟動全部服務（第一次要下載映像並建置儀表板，約 3 到 5 分鐘，網路慢會更久，中間沒有進度提示，請等它跑完）：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d --build
```

建置時會連 `fonts.googleapis.com` 下載字型。建置失敗，且錯誤訊息含 `font/google` 時，原樣重跑同一行指令即可；建置步驟本身已經自動重試 3 次，仍失敗時請先確認主機連得上外網。

> **這台主機上的每一個 compose 指令都要帶這兩個 `-f` 和 `--profile full`。** 漏掉覆寫檔會用開發用的埠位建容器。之後看紀錄也一樣，例如：
>
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full logs --tail 50 dashboard
> ```

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

建立 `/etc/nginx/sites-available/costscale`，內容如下（兩個網域換成你的）。

檔案最上面的 `map` 與 `limit_req_zone` 兩段**只能寫在 server 區塊之外**（它們屬於 nginx 的 http 層；`sites-enabled` 裡的檔案是被 `nginx.conf` 放進 http 區塊的，所以寫在檔案最上面就是對的位置）。它們替登入相關路徑加上限速：只算 POST（送出登入），每個來源每秒 5 次、突發 10 次，超過回 `429`；看頁面、取 session 這類 GET 不受影響。登入相關路徑（`/login`、`/api/auth/`）的 body 上限壓到 16k，登入內容很小，超過由 nginx 直接回 `413`，不會送進儀表板；其他路徑維持 20m。

```nginx
# 登入相關路徑的限速：只算 POST，GET 不受影響
map $request_method $costscale_login_key {
    default "";
    POST    $binary_remote_addr;
}
limit_req_zone $costscale_login_key zone=costscale_login:10m rate=5r/s;

# 儀表板
server {
    listen 80;
    server_name cost.example.com;

    # 登入表單送出（Server Action 會 POST 到 /login）
    location = /login {
        limit_req zone=costscale_login burst=10 nodelay;
        limit_req_status 429;
        limit_req_log_level warn;
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # next-auth 的 API（帳密登入的 callback、登出、csrf、session）
    location /api/auth/ {
        limit_req zone=costscale_login burst=10 nodelay;
        limit_req_status 429;
        limit_req_log_level warn;
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 用 $remote_addr 覆寫，不要用 $proxy_add_x_forwarded_for：登入的輸錯鎖定以這個標頭
        # 最左邊的 IP 為單位，用戶端自己帶的值必須丟掉，否則可以偽造 IP 繞過鎖定。
        proxy_set_header X-Forwarded-For $remote_addr;
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

`nginx -t` 會印出有問題的檔名與行號；沒有看到 `syntax is ok` 與 `test is successful` 兩行就不要往下做，先照它指的檔案與行號修正。

申請憑證前，兩個網域的 A 紀錄要已經生效（第 1 節）：

```bash
sudo certbot --nginx -d cost.example.com -d llm.example.com
```

### 確認

- 瀏覽器打開 `https://cost.example.com`，用你設定的登入方式（管理員帳號密碼，或白名單裡的 Google 帳號）登入，看得到「總覽」頁。
- 從**你自己的電腦**（不是主機）執行：

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://llm.example.com/key/list
  ```

  要回 `404`。回 `401` 或 `200` 代表管理 API 露出去了，回頭檢查 nginx 設定。

  用 Windows PowerShell 的話，要把 `curl` 改成 `curl.exe`，並把 `-w '%{http_code}\n'` 改成 `-w "%{http_code}"`。`curl` 在 PowerShell 裡是另一個指令，語法不同。

### 前面有 Cloudflare 或其他反向代理時

網域經過 Cloudflare 代理（橘色雲朵），或儀表板前面還有別的反向代理、負載平衡器時，連到 nginx 的是代理的節點，不是真正的使用者。nginx 看到的 `$remote_addr` 就是代理節點的 IP。

**不設的後果**：登入的輸錯鎖定與限速都是以來源 IP 為單位，所有人會被當成同一個來源。任何人連續輸錯 5 次，同一個節點進來的所有人（包含你自己）都被鎖 15 分鐘，而且可以一直重複；登入路徑的限速也變成全部人共用同一份額度。

**做法**：讓 nginx 只信任代理自己的 IP 範圍，並從代理帶來的標頭取出真正的使用者 IP（nginx 的 `ngx_http_realip_module`，Ubuntu 的 nginx 已內建）。建立 `/etc/nginx/conf.d/costscale-realip.conf`（`conf.d` 裡的檔案屬於 http 層，位置是對的）：

```nginx
# 只信任代理自己的網段，一個網段一行。下面是「格式範例」，不是 Cloudflare 的網段，不能直接用。
# Cloudflare 的網段會更新，請到官方頁面取得最新的 IPv4 與 IPv6 兩份清單：https://www.cloudflare.com/ips/
set_real_ip_from 203.0.113.0/24;
set_real_ip_from 2001:db8::/32;
# Cloudflare 會把真正的使用者 IP 放在這個標頭
real_ip_header CF-Connecting-IP;
```

說明：

- `set_real_ip_from` 列的是「你信任的代理」，nginx 只有在請求來自這些網段時才採信標頭。**不要寫 `0.0.0.0/0`**，那等於信任所有人，使用者可以自己帶標頭偽造來源 IP，鎖定與限速全部失效。
- 不是 Cloudflare、而是自己的代理或負載平衡器：把 `set_real_ip_from` 換成它的 IP，`real_ip_header` 換成它帶使用者 IP 的標頭（常見是 `X-Forwarded-For`，用這個標頭時再加一行 `real_ip_recursive on;`）。
- 設好之後，上面第 6 節的 `proxy_set_header X-Forwarded-For $remote_addr;` 不用改：`$remote_addr` 已經是真正的使用者 IP，儀表板收到的就是它。
- 建議再到主機的防火牆或雲端的安全群組，把 80 與 443 只開給代理的網段，這樣別人繞過代理直連主機，也騙不了來源 IP。

檢查語法並重新載入：

```bash
nginx -t
```

```bash
systemctl reload nginx
```

怎麼確認有生效：用手機（不連 Wi-Fi）開登入頁、故意輸錯 5 次被鎖之後，再用別的網路（例如家裡的 Wi-Fi）開登入頁並輸入正確帳密，要能正常登入。不同使用者互不影響，就代表 nginx 認得到真正的來源 IP。

用安裝腳本裝的話，腳本**不會**自動做這件事（它不知道你的代理網段）；加了 `--skip-dns-check` 時，腳本結尾會多印一行提醒指向這一節。

---

## 7. 排程

用 root 執行 `crontab -e`。第一次執行會先問你要用哪個編輯器，選 `nano`（輸入它前面的編號再按 Enter）；選到 `vim` 的話，按 `Esc`，輸入 `:q!` 再按 Enter 可以離開重來。

先貼上「必要」這一段。每一行做什麼寫在註解裡：

```cron
# 儀表板「新增／移除上游金鑰」的佇列：每分鐘套用一次
* * * * * python3 /opt/costscale/scripts/apply-upstream-key.py >> /var/log/costscale-upstream-key.log 2>&1
# 閘道看門狗：不健康時自動重啟
*/3 * * * * /opt/costscale/scripts/watchdog-litellm.sh
# 預算檢查：超過或接近每月預算時寫告警、寄信
5 * * * * /opt/costscale/scripts/check-budgets.sh >> /var/log/costscale-budgets.log 2>&1
# 匯率（台幣顯示用）與訂閱月費入帳。每小時跑：扣款日當天才新增的訂閱，最晚一小時內入帳。
# 匯率每天只抓一次，同一天重跑不會重複入帳
20 * * * * /opt/costscale/scripts/run-fx-fetch.sh >> /var/log/costscale-fx.log 2>&1
```

下面 4 行是「選用」，**先完成註解寫的那一節的設定，再貼上**。沒設定就貼上的話，`run-gcp-fetch.sh` 與 `run-billing-fetch.sh` 每次都會失敗並寫進記錄檔：

```cron
# 訂閱剩餘額度。先完成第 9 節（訂閱橋接）
*/15 * * * * /opt/costscale/scripts/run-sub-usage-fetch.sh >> /var/log/costscale-sub-usage.log 2>&1
# 專案看板同步 GitHub。先完成第 11 節，並在 .env 填 GITHUB_TOKEN
*/30 * * * * /opt/costscale/scripts/run-board-sync.sh >> /var/log/costscale-board.log 2>&1
# Vertex 用量。先在 .env 填 GCP_PROJECT，並把真的服務帳戶金鑰放到 /root/vertex-sa.json（見第 5 節）
17 * * * * /opt/costscale/scripts/run-gcp-fetch.sh >> /var/log/costscale-gcp.log 2>&1
# GCP 帳單。先在 .env 填 BQ_JOB_PROJECT，並把真的服務帳戶金鑰放到 /root/vertex-sa.json（見第 5 節）
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

第一次執行要先下載 `python:3.12-slim` 映像再安裝套件，會等一到數分鐘，畫面看起來像卡住，請等它跑完。最後兩行應該是類似 `匯率 1 USD = 32.97 TWD（來源 open.er-api）` 與 `今天沒有到期的訂閱扣款`，儀表板上的台幣金額就會出現。中間出現 `WARNING: Running pip as the 'root' user` 是 pip 的提醒，可以忽略。

---

## 8. 發第一把虛擬金鑰，打一次看看

1. 儀表板 →「應用程式」→「新增軟體」，取個名字（例如 `test-app`），模型限制先不選。
2. 畫面會顯示一次金鑰（`sk-` 開頭），**只顯示這一次**，先複製起來。
3. 在任何一台電腦執行（金鑰與網域換成你的，模型換成你有填金鑰的那個）。儀表板總覽的上手清單第 3 步也有同樣兩段，網址與模型會自動帶好。

   macOS、Linux（Windows 的 Git Bash 也可以）。內容刻意用英文：Git Bash 轉送含中文的指令列時編碼會壞掉，閘道會回 `400`：

   ```bash
   curl -s https://llm.example.com/v1/chat/completions -H "Authorization: Bearer sk-你的虛擬金鑰" -H "Content-Type: application/json" -d '{"model":"gemini-flash-free","messages":[{"role":"user","content":"Introduce yourself in one sentence, in Traditional Chinese."}]}'
   ```

   Windows PowerShell（整段貼上，會直接印出回答文字；PowerShell 裡的 `curl` 是另一個指令，不能用上面那行）：

   ```powershell
   $body = '{"model":"gemini-flash-free","messages":[{"role":"user","content":"用一句話自我介紹"}]}'
   $f = New-TemporaryFile
   Invoke-RestMethod -Uri "https://llm.example.com/v1/chat/completions" -Method Post -Headers @{ Authorization = "Bearer sk-你的虛擬金鑰" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -OutFile $f
   (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).choices[0].message.content
   Remove-Item $f
   ```

4. 有回答就成功了。回到儀表板「總覽」，幾秒內會看到這一筆呼叫與花費。

總覽頁最上方的「上手清單」會依實際狀態替這四步打勾：放入供應商金鑰、新增第一個軟體、第一次成功呼叫、排程有在跑。四步全部完成後它自己消失；想再看一次，網址後面加 `/?onboarding=1`，或到「說明」頁點「回頭看上手清單」。

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

#### 舊版升上來一定要套的：`29` 到 `33`

這五支改的是**訂閱金額怎麼算**。不套的話程式不會出錯、畫面也不會有破綻，
只是金額一直是錯的——這是最難發現的那種壞法，所以單獨點名：

| 檔案 | 不套的後果 |
|---|---|
| `29-subscription-charge-plan.sql` | 改過方案之後，歷史扣款會顯示成**現在**的方案（名字說謊） |
| `30-subscription-tax.sql` | 沒有稅的概念。訂閱若有加值稅（台灣 5%），**每個月都少記一個稅** |
| `31-subscription-review-date.sql` | 沒有複查日提醒。臨時升級後忘了改回去，扣款日當天會凍成錯的金額 |
| `32-subscription-overseas.sql` | 以台幣計價但商家在海外的訂閱，**少算國外交易服務費**（常見 1.5%） |
| `33-actual-twd-definition.sql` | 只改欄位註解，不影響計算 |

套完之後有兩個欄位要自己填一次，程式猜不到：

- **訂閱的「稅率 %」**：填**未稅牌價**在月費欄、稅率另外填。把稅併進月費會讓
  畫面上的金額對不上供應商的官方價目。
- **訂閱的「海外交易」**：決定收不收國外交易服務費。**它看的是收單商家在不在海外，
  不是幣別**——以台幣計價的海外服務（例如 OpenAI 的台灣訂價）帳單上照樣有那一行。
  非台幣計價的會自動填好；台幣計價的預設是「還沒確認」，等你對一次帳單再填。

#### 2026-11-24 之後的版本：閘道只載入有真金鑰的部署、安全警告橫幅

- **閘道的進入點換成 `scripts/litellm-entry.py`**：閘道啟動時，把「金鑰還是佔位字、而且同一個模型名底下還有真金鑰」的部署從暫存設定檔拿掉（`litellm-config.yaml` 本身不動）。只填一把 Gemini 或 Groq 金鑰時，不會再因為隨機輪到佔位字而回 `401`，或連續失敗後整組冷卻回 `429`（`No deployments available`）。每個多把金鑰的欄位都填滿時，沒有任何部署被拿掉，行為與以前相同。更新後第一次 `up -d --build` 會把閘道重建一次（約 30 秒不通）。這個進入點在雲端主機與本機模式都生效；補上第 2 把金鑰的做法不變（`apply-upstream-key.py` 與設定工具都會重建閘道）。
- **儀表板每一頁最上方多了安全警告橫幅**：`AUTH_DISABLED=1`、`LITELLM_MASTER_KEY` 或資料庫密碼還是範本值時顯示，並在啟動紀錄留 `[security] 警告`。不阻擋啟動。處理方式見第 13 節的「把範本值換掉」。
- **本機模式的排程容器固定安裝 `psycopg` 3.3.9**，不再跟著 PyPI 最新版走。

#### 2026-11-23 之後的版本：帳號密碼登入

儀表板多了管理員帳號密碼登入，Google 登入改為選用。**原本用 Google 登入的人不用做任何事**，更新後照常能登入，有兩點行為改變：

- **登入憑證的有效期限從 30 天改成 7 天**（Google 與帳號密碼登入都一樣）。更新後，已登入的瀏覽器最多 7 天就要重新登入一次。
- **`AUTH_SECRET` 沒設好時，儀表板會拒絕所有登入**：留著範本值（`change-me` 開頭）、空值、或短於 32 個字元都算沒設好。用安裝腳本裝的主機不受影響（腳本一定產生亂數）；手動裝、漏改過這一欄的人，更新後登入頁會顯示「AUTH_SECRET 還沒設好」與補法。這是刻意的：範本值是公開的，用它就能偽造登入。`ALERT_CRON_TOKEN`、`OTEL_INGEST_TOKEN` 等 token 留範本值時，對應的 API 也會改成拒絕請求。

這一版的 `docker-compose.yml` 另外替每個服務加了 log 大小上限（單檔 10 MB、最多 5 份）。更新後第一次 `up -d --build` 會把三個服務各重建一次（閘道約 30 秒不通），之後就不會了。想加上帳號密碼登入的話，做兩件事：

1. 設定帳號密碼（做法見第 3 節最後的「管理員帳號密碼」），再依腳本最後印的那一行 `up -d dashboard` 讓它生效。帳號要以英數開頭，原本帳號是 `.`、`_` 或 `-` 開頭的要改掉。
2. 把 nginx 設定裡儀表板那一段的 `X-Forwarded-For` 改成覆寫，輸錯鎖定才認得到真正的來源 IP。用安裝腳本裝的主機，重跑一次 `bash /opt/costscale/scripts/install.sh`（帶原本的選項）就會自動改好並備份舊檔；手動裝的，用下面這一行改，再重新載入 nginx：

```bash
sed -i 's/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/proxy_set_header X-Forwarded-For \$remote_addr;/' /etc/nginx/sites-available/costscale
```

```bash
nginx -t && systemctl reload nginx
```

3. 登入路徑的限速與 body 上限（第 6 節 nginx 設定最上面的 `map`、`limit_req_zone`，以及 `/login`、`/api/auth/` 兩段 location）：用安裝腳本裝的主機，重跑一次 `bash /opt/costscale/scripts/install.sh`（帶原本的選項）就會套用並備份舊檔；手動裝的，照第 6 節的內容改 `/etc/nginx/sites-available/costscale`，再執行上面的 `nginx -t && systemctl reload nginx`。

#### 2026-11-22 之後的版本：匯率排程改每小時

以前裝的是每天跑一次（`20 5 * * *`），扣款日當天、排程跑過之後才新增的訂閱，
那一期永遠不會進「扣款歷史」。更新程式後，用 `crontab -e` 把 `run-fx-fetch.sh` 那一行
開頭的 `20 5 * * *` 改成 `20 * * * *`。新版腳本用台北時間判斷「今天」，
沒改排程也能照常運作，只是補不到當天晚新增的訂閱。

#### 2026-11-21 之後的版本：重新套一次 `34`

`34-credit-pools.sql` 結尾多了一句，替「贈金餘額」加上 `gcp_project` 欄位。
整支檔案可以重複執行，照上面的指令再套一次就好。**不套的話「GCP 帳單」頁的贈金餘額會變成空的、低餘額橫幅也不會出現**
（程式會讀這個欄位，欄位不存在時整個查詢失敗）。

套完之後，在資料庫把每個贈金帳號底下的 GCP 專案 ID 填進去（多個用逗號分隔），
模型對照表的「付費帳號」才會顯示帳號名稱，而不是專案 ID：

```
UPDATE costscale.credit_pools SET gcp_project = '你的專案 ID' WHERE id = 1;
```

### 升級閘道（LiteLLM）

`docker-compose.yml` 把閘道**釘在特定的映像 digest**，不是 `main-stable` 這種會動的標籤。
所以上面那兩個指令**不會**換掉閘道版本，升級是你主動做的事。

這樣設計的理由：閘道是對外服務的代理，而且它**每次啟動都會自動跑資料庫遷移**
（`prisma migrate deploy`，LiteLLM 自己有 70 幾張表）。升級會改表結構、**降版不保證相容**，
這種東西不該在沒人盯著的時候自己換。代價是安全更新不會自己來，要自己盯 LiteLLM 的發布。

升級步驟：

```bash
cd /opt/costscale && docker compose -f docker-compose.yml -f docker-compose.vps.yml exec -T db pg_dump -U costscale costscale | gzip > /root/costscale-db-$(date +%Y%m%d).sql.gz
```

```bash
docker pull ghcr.io/berriai/litellm:main-stable && docker image inspect ghcr.io/berriai/litellm:main-stable --format '{{index .RepoDigests 0}}'
```

把印出來的 `ghcr.io/berriai/litellm@sha256:…` 貼進 `docker-compose.yml` 的 `image:`，然後：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d litellm
```

**改 `image:` 那一行會讓容器重建**，閘道有數十秒不可用，挑離峰時段做。

起來之後**驗「改動有沒有生效」，不是只看服務還活著**：

```bash
curl -s -o /dev/null -w "%{http_code}
" http://127.0.0.1:4400/health/liveliness && curl -s http://127.0.0.1:4400/model/info -H "Authorization: Bearer $(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)" | python3 -c "import sys,json; d=json.load(sys.stdin); print('部署數', len(d['data']))"
```

再實際打一次（回得出東西才算數）：

```bash
curl -s http://127.0.0.1:4400/v1/chat/completions -H "Authorization: Bearer $(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)" -H 'Content-Type: application/json' -d '{"model":"gemini-flash-free","messages":[{"role":"user","content":"回一個字：好"}],"max_tokens":60}'
```

不對勁就把 `image:` 換回舊的 digest 再 `up -d litellm`；如果新版已經改過資料表結構，
還要用上面備份的檔案還原資料庫——**這就是第一步要先備份的原因**。

**`27-manual-subscription-charges.sql` 要跟程式一起更新，不能只做一邊**（2026-09-21）。
它把訂閱扣款的唯一性從「整張表」縮小成「只管自動入帳」，好讓人能在同一天補一筆升級差額。
`scripts/fetch-fx.py` 的寫入語法必須配合那個索引——只更新程式沒套 SQL，或只套 SQL 沒更新程式，
每天的訂閱月費凍結都會失敗（錯誤訊息是 `no unique or exclusion constraint matching`）。
套完用這個確認當天的入帳還跑得動：

```bash
cd /opt/costscale && bash scripts/run-fx-fetch.sh
```

**2026-11 版：訂閱模型選單、每日失效檢查**。沒有新的 SQL 檔，但要做三件事：

1. `litellm-config.yaml` 是你自己的檔案，`git pull` 不會改它。把新版範本裡
   「訂閱模型選單」那一段（`sub-claude-fable` 開始的 16 個部署）複製到你的設定檔，
   再重啟閘道：`docker restart costscale-litellm-1`。
2. 重啟家用主機上的橋接，讓它讀到新的 `bridge/server.js` 與 `bridge/model-check.js`。
   失效通知要靠使用者環境變數 `COSTSCALE_VPS_SSH`（第 9 節已設定過就不用再設）。
3. 到「應用程式」頁按一次「重新同步白名單」，已授權訂閱的軟體才會拿到新的模型名稱。

**「重新同步白名單」的行為改了**：以前會把閘道上全部非訂閱模型開給每個軟體，
現在保留各軟體目前勾選的模型，只拿掉已不存在的名字。新增的 API 模型要到該軟體的「模型」逐一勾選。

---

## 13. 打不通的時候

| 現象 | 原因 | 怎麼辦 |
|---|---|---|
| 登入頁寫「還沒有設定任何登入方式」 | `.env` 裡帳號密碼與 Google 兩種都沒設定，或帳號格式、雜湊格式不對（儀表板的紀錄會有一行 `[auth]` 警告，不含雜湊內容） | 在主機上執行 `bash /opt/costscale/scripts/set-admin-password.sh`，再照下方「改完 `.env` 怎麼生效」重建儀表板 |
| 帳號密碼登入顯示「帳號或密碼不正確」 | 帳號或密碼打錯（兩種錯誤顯示同一句，刻意不讓人猜帳號） | 確認大小寫；忘記密碼就在主機上重跑 `scripts/set-admin-password.sh`，再 `up -d` |
| 登入頁寫「登入功能已停用：AUTH_SECRET 還沒設好」 | `.env` 的 `AUTH_SECRET` 是空值、範本預設值（`change-me` 開頭）、或短於 32 個字元，儀表板刻意拒絕所有登入（儀表板的紀錄會有一行 `[auth] 警告`，不含值） | 用 `openssl rand -hex 32` 產生新的，填進 `.env` 的 `AUTH_SECRET`，再執行 `docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d dashboard`（登入頁上有一步一步的說明） |
| 登入頁顯示「輸錯次數太多，請等 N 分鐘後再試」 | 同一個 IP 15 分鐘內輸錯 5 次，鎖 15 分鐘，鎖定期間密碼正確也不行 | 等它到期；要馬上解除就重建儀表板容器（在 `up -d` 指令後面加 `--force-recreate dashboard`；鎖定計數放在記憶體，重啟歸零）。所有人都被鎖在同一個 IP 的話，檢查 nginx 的 `X-Forwarded-For` 有沒有照第 6 節覆寫；前面有 Cloudflare 或其他反向代理的話，照第 6 節的「前面有 Cloudflare 或其他反向代理時」設定 |
| 登入時瀏覽器顯示 `429 Too Many Requests` | nginx 對登入路徑的限速：同一個來源每秒超過 5 次 POST（突發可到 10 次） | 等幾秒再試。正常使用不會碰到；一直碰到的話，檢查是不是所有人被當成同一個來源（見上一列） |
| 改了密碼，舊密碼還登得進去 | 改完 `.env` 沒有 `up -d dashboard`（`restart` 不會讀新值） | 照下方「改完 `.env` 怎麼生效」重建儀表板 |
| 用 Google 登入後回到登入頁 | 你的帳號不在 `AUTH_ALLOWED_EMAILS`（帳號密碼登入不受這個清單影響） | 加進 `.env` 後，照下方「改完 `.env` 怎麼生效」重建儀表板 |
| Google 登入顯示 `redirect_uri_mismatch` | OAuth 的重新導向 URI 與 `AUTH_URL` 不一致 | 第 4 節的網址要與 `AUTH_URL` 完全相同 |
| 專案收到 `401` | 虛擬金鑰錯了或已撤銷 | 到「應用程式」頁重新簽發 |
| 專案收到 `429`，訊息含 `budget_exceeded` | 那個軟體超過了它的每月上限 | 到「應用程式」頁提高或解除上限。**專案端不要自動重試這個錯誤** |
| `400 no healthy deployments` | 那個模型沒有可用的上游金鑰，或 `sub-*` 橋接沒連上 | 檢查 `.env` 的金鑰；橋接見第 9.6 節 |
| `sub-*` 回 `429`，訊息在講額度 | 橋接的額度保留線：該訂閱剩餘不到 20% | 等額度重設，或改走 API 模型 |
| 「新增上游金鑰」一直停在排隊中 | 第 7 節的 `apply-upstream-key.py` 排程沒裝，或 spool 目錄權限不對（本機安裝模式沒有這支排程，儀表板會直接說明本機做法，不會排隊） | 補排程；重做第 5 節的 `chown` |
| `docker compose up` 報 `Pool overlaps` | 主機本身的網路也用 10.87.213.0/24 | 見第 9.1 節 |
| 儀表板金額全是 0 | 還沒有任何呼叫經過閘道 | 先做第 8 節 |

### 把範本值換掉

儀表板每一頁最上方出現紅框橫幅時（以及啟動紀錄裡有 `[security] 警告`），表示下面三項有一項需要處理。三項都不會阻擋啟動，只是提醒。

| 橫幅 | 意思 | 怎麼辦 |
|---|---|---|
| 登入檢查已關閉 | `AUTH_DISABLED=1` | 把 `.env` 的 `AUTH_DISABLED` 改成 `0`，重建儀表板（見下一節）。這個開關只該用在測試 |
| 主金鑰是範本值 | `LITELLM_MASTER_KEY` 還是 `sk-change-me` 這類公開預設值：知道預設值的人連得到閘道，就能用管理介面發金鑰、查看全部紀錄 | 雲端主機：執行 `bash /opt/costscale/scripts/install.sh`，它發現範本值會換成新的亂數並重建服務。本機：執行設定工具選 `1`，再 `docker compose up -d`。閘道會重建，約 30 秒內打不通 |
| 資料庫密碼是範本值 | `DB_PASSWORD` 還是公開預設值（資料庫只綁在 `127.0.0.1`，外部連不到，但這台主機上的任何程式都能用預設密碼登入） | 資料庫建好之後，只改 `.env` 會讓閘道與儀表板連不上資料庫，要先在資料庫內改密碼：先產生新密碼（例如 `openssl rand -hex 24`），執行 `docker compose exec db psql -U costscale -d costscale -c "ALTER USER costscale PASSWORD '新密碼'"`，再把 `.env` 的 `DB_PASSWORD` 換成同一個新密碼，最後重建全部服務（雲端主機疊上 `-f docker-compose.vps.yml --profile full`）。新密碼只用英數，不要含 `'` 與 `$` |

### 改完 `.env` 怎麼生效

改了 `.env` 之後，**`docker compose restart` 不會讀到新的值**，容器會沿用舊設定。要用 `up -d` 重建：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d
```

這一行會重建「設定有變的服務」，沒變的不動。**注意閘道（`litellm`）是整份讀 `.env` 的，`.env` 任何一行變動它都會被一起重建**，重建期間（約 30 秒）所有接在閘道上的軟體都打不通。只改了儀表板相關的欄位（帳號密碼、`AUTH_*`）時，在指令最後面加服務名稱，只重建儀表板：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d dashboard
```

跑完重新做第 5 節的「確認」。

完整的操作說明在儀表板右上角的「使用說明」。

---

## 14. 在自己電腦上開發儀表板

見 `dashboard/README.md`。只提醒一件事：單獨執行 `npx tsc --noEmit` 做型別檢查之前，要先執行一次 `npx next typegen`，否則會出現一堆 `RouteContext` 找不到的錯誤。`npm run build` 會自己處理，不受影響。

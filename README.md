<p align="center"><img src="docs/banner.png" alt="AI CostScale：自架的 AI 閘道與儀表板"></p>

# AI CostScale

**自架的 AI 用量與成本管理中心。** 把散在各個專案裡的 AI 金鑰收進一台閘道，每個專案只拿閘道發的「虛擬金鑰」。從此每個專案燒了多少 token、花了多少錢，都看得到，也管得住。

- 開源、自架，資料留在你自己的主機上
- 閘道用 [LiteLLM](https://github.com/BerriAI/litellm)，儀表板用 Next.js，資料庫用 PostgreSQL，一個 `docker compose` 全部拉起來
- 介面與說明全部是繁體中文

## 它解決什麼問題

同時跑好幾個 AI 專案之後，通常會遇到這幾件事：

- 月底帳單來了，分不出是哪個專案花掉的
- 一把金鑰貼在五個專案裡，要換金鑰得一個一個改
- 某個專案寫錯迴圈，一個晚上燒掉一個月的預算
- 已經付了 Claude、ChatGPT 的月費訂閱，自己的小工具卻還在另外付 API 費用

## 功能

| 功能 | 說明 |
|---|---|
| 虛擬金鑰 | 每個專案一把，可以限制它能用哪些模型；外洩了只要重新簽發那一把 |
| 每月硬上限 | 以台幣或美金設定，超過就由閘道直接拒絕，不會轉發給供應商 |
| 花費總覽 | 依專案、模型、日期拆開看，美金與台幣並列 |
| 營運大屏 | 全螢幕的即時數據畫面：流量拓撲、近 24 小時呼叫、免費額度、異常事件 |
| 免費額度追蹤 | 多把免費金鑰輪替，每天用了多少、剩多少一目了然 |
| 上游金鑰管理 | 在網頁上新增、移除供應商金鑰，送出前先驗證，失敗自動回滾 |
| 預算告警 | 接近或超過預算時寄信，同時顯示在儀表板上 |
| 訂閱橋接（選用） | 讓自己的專案透過閘道使用你已付費的 Claude Code、Codex、Antigravity 訂閱 |
| 訂閱省下多少 | 統計訂閱實際用掉的 token，換算成官方 API 價格，看月費值不值得 |
| 專案看板（選用） | 彙整各專案 repo 裡的進度檔，一頁看完所有專案走到哪裡 |

## 架構

```
你的專案 ──虛擬金鑰──► 閘道（LiteLLM）──真金鑰──► Google／Groq／OpenRouter／…
                          │
                          ├─ 每一筆呼叫記帳 ──► PostgreSQL ◄── 儀表板（Next.js）
                          │
                          └─ SSH 反向隧道（選用）──► 家用電腦上的訂閱橋接
```

閘道本身不產生任何內容，它只做三件事：驗虛擬金鑰、換成真金鑰、記一筆帳。

## 需要什麼

- 一台 Linux 主機（2 GB 記憶體以上），裝好 Docker 與 Compose 外掛 v2.24.4 以上
- 兩個網域（儀表板一個、閘道一個）
- 一個 Google 帳號（儀表板用 Google 登入）
- 用訂閱橋接的話，再加一台 Windows 電腦

## 安裝

照 **[INSTALL.md](INSTALL.md)** 一節一節做，每一節都有確認步驟。

第 1～8 節做完，閘道與儀表板就能用了。以下是選用元件，要用哪個再裝哪個：

| 想要的功能 | 裝哪裡 |
|---|---|
| 讓自己的專案用你已付費的 Claude Code／Codex 訂閱 | INSTALL 第 9 節（訂閱橋接） |
| 統計自己用掉的訂閱 token，算「省下多少」 | INSTALL 第 10 節（把 `collector/` 複製到那台電腦雙擊安裝） |
| **專案看板**：一頁看完所有專案走到哪 | INSTALL 第 11 節＋ `helper/README.md`（看板讀各專案 repo 裡的 `doc/status.json`，要先裝小幫手把它推上來） |

用 Claude Code 的話，可以讓它帶你裝：把 `skills/costscale-install` 資料夾複製到 `~/.claude/skills/`，然後對 Claude Code 說「幫我安裝 AI CostScale」。

## 目錄

```
docker-compose.yml        閘道＋資料庫＋儀表板
docker-compose.vps.yml    正式機覆寫檔（埠位、憑證掛載）
litellm-config.yaml       閘道的模型與供應商設定
.env.example              所有設定項目與說明
dashboard/                儀表板（Next.js）
db/init/                  資料表，第一次啟動時自動建立
scripts/                  主機上的排程腳本、發金鑰
collector/                訂閱用量收集器：複製到任何一台 Windows 電腦，雙擊安裝
deploy/                   nginx 設定片段與主機設定腳本
bridge/                   訂閱橋接（Windows）
helper/                   專案看板的本機小幫手（Windows）
claude-skill/             讓 AI 產生專案進度檔的 Claude Code skill
skills/costscale-install/ 帶你安裝這套軟體的 Claude Code skill
```

## 關於訂閱橋接

訂閱橋接**只適合你自己用的專案**。把個人訂閱的額度拿去服務付費客戶，等於轉賣訂閱，會違反各家的服務條款。付費產品請使用 API 金鑰。

## 授權

> `dashboard/public/private/` 裡的文字貼紙圖是網友自製、非官方的第三方圖檔，不在 MIT 授權範圍內，詳見該目錄的 `THIRD-PARTY-NOTICE.md`。

[MIT](LICENSE)

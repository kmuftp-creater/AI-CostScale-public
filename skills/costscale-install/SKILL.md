---
name: costscale-install
description: 帶使用者一步一步安裝自架的 AI CostScale（LiteLLM 閘道＋儀表板＋選用的訂閱橋接）。當使用者說「安裝 AI CostScale」「幫我架 CostScale」「設定訂閱橋接」「CostScale 裝好了但打不通」時使用。
---

# 安裝 AI CostScale

這個 skill 帶使用者照 repo 根目錄的 `INSTALL.md` 完成安裝。**`INSTALL.md` 是唯一的步驟來源**，先完整讀一次再開始，不要憑記憶或自行發明步驟。

## 開始之前先問清楚

一次問完，拿到答案再動手：

1. 雲端主機的 SSH 位址（例：`root@203.0.113.10`），以及你（Claude Code）現在是在那台主機上，還是在使用者的電腦上透過 SSH 操作。
2. 儀表板與閘道要用的兩個網域，DNS 是否已經指向那台主機。
3. 可以登入儀表板的 Google 帳號。
4. 要不要裝訂閱橋接（第 9 節）、用量收集器（第 10 節）、專案看板（第 11 節）。預設只裝第 1 到第 8 節。

## 執行原則

- **一節一節做，每一節的「確認」步驟沒過就停下來。** 把實際的指令輸出給使用者看，說明是哪裡不對、打算怎麼修，再繼續。不要跳過確認去做下一節。
- **機密不出現在對話裡。** `.env` 裡的密碼與 token 用 `openssl rand -hex 24` 直接在主機上產生並寫進檔案，不要把值印出來、不要寫進指令歷史看得到的地方。需要使用者提供的機密（Google OAuth 密鑰、供應商金鑰），請使用者自己用 `nano /opt/costscale/.env` 貼上。
- **路徑固定是 `/opt/costscale`。** 排程腳本寫死了這個路徑。
- **每個 compose 指令都帶** `-f docker-compose.yml -f docker-compose.vps.yml --profile full`。
- **`AUTH_DISABLED` 必須是 `0`。** 不要為了方便測試改成 `1`。
- **不要把閘道的管理 API 對外開放。** nginx 照 `INSTALL.md` 第 6 節的白名單寫，最後一定要從主機以外的地方確認 `https://<閘道網域>/key/list` 回 `404`。
- 動到 `/etc/ssh/sshd_config`、nginx、防火牆之前，先告訴使用者要改什麼、為什麼，得到同意再做。`deploy/enable-gatewayports.sh` 會自己備份並在語法錯誤時回滾，照用即可。

## 各節的重點

| 節 | 容易出錯的地方 |
|---|---|
| 1 | `docker compose version` 要 v2.24.4 以上，否則覆寫檔的 `!override` 會報錯 |
| 3 | `AUTH_URL` 結尾不要斜線；每個 token 各自產生，不要共用 |
| 4 | OAuth 重新導向 URI 是 `<AUTH_URL>/api/auth/callback/google`，要完全一致 |
| 5 | `spool/upstream-keys` 要 `chown 1001`，否則「新增上游金鑰」會失敗 |
| 7 | `apply-upstream-key.py` 的每分鐘排程一定要裝，儀表板的金鑰管理靠它 |
| 9 | 橋接的 `BRIDGE_TOKEN` 兩邊要一模一樣；SSH 必須免密碼（`ssh -o BatchMode=yes <主機> echo ok` 要印 `ok`）；設完 Windows 環境變數要開新的 PowerShell 視窗 |
| 12 | 更新版本時 `db/init/` 的新 SQL 檔不會自動執行，要手動套用 |

## 訂閱橋接的服務條款提醒

裝第 9 節之前，向使用者確認：訂閱橋接只給使用者**自己用的專案**。把個人訂閱的額度拿去服務付費客戶，等於轉賣訂閱，違反各家服務條款。付費產品請走 API 金鑰。

## 裝完之後

用 `INSTALL.md` 第 8 節發一把測試用的虛擬金鑰，實際打一次模型，確認儀表板「總覽」看得到那一筆呼叫。**沒有這一步不算裝好。** 最後告訴使用者：

- 儀表板網址、閘道網址
- 裝了哪幾節、跳過哪幾節
- 哪些排程已裝
- 測試金鑰要不要撤銷（儀表板「應用程式」頁）

出問題時先查 `INSTALL.md` 第 13 節的對照表。

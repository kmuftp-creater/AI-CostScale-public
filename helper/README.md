# 看板本機小幫手（每台電腦裝一次）

兩件事：
1. 讓看板的「開啟」按鈕能在「這台電腦」打開專案資料夾與工具（`apphub://` 協定）。
2. 定時把這台電腦各專案的 `doc/status.json` 推上進度看板（背景、無視窗）。

## 新電腦安裝

1. 把**整個 `helper` 資料夾**複製到這台電腦任一固定位置（之後不要移動）。
2. 把專案根目錄（放各專案資料夾的那一層）**拖到 `setup-pc.bat` 上**。它會依序問兩件事：
   - 儀表板網址：伺服器 `.env` 裡的 `AUTH_URL`，例如 `https://cost.example.com`
   - 推送金鑰：伺服器 `.env` 裡的 `BOARD_PUSH_TOKEN`

   然後寫好設定、註冊 4 小時一次的靜默同步。
3. 雙擊 **`board-sync-all.bat`** 立刻同步一次，看到 `[OK]` 就成功了。
4. 要讓看板的「開啟」按鈕能在這台電腦打開專案，再雙擊 **`install.bat`**（註冊 `apphub://` 協定）。

不需要系統管理員。

## 設定檔（都在 %USERPROFILE%）

| 檔案 | 內容 |
|---|---|
| `.apphub-push.json` | 推送目標。新格式支援多目標（`targets` 陣列），舊的單一 `url`/`token` 也還能用 |
| `.apphub-sync.json` | 專案根目錄與 `gitAutoPush` |
| `.apphub-sync-state.json` | 各專案上次推送的雜湊（自動維護，刪掉＝全部重推一次） |

多目標範例見 `push-config.example.json`。任一目標失敗時該專案下輪會重試。

## 應用程式對照表 apps.json（每台電腦各自設定）

看板只記應用程式「名稱」（例如 Antigravity、Claude、VS Code），各電腦安裝路徑不同，
由本機 `apps.json` 把名稱對應到執行檔。第一次點「開啟」會自動偵測常見工具產生；
沒偵測到的照 `apps.json.example` 手動補。名稱要與看板「設定 → 開啟應用程式清單」一致。
只會啟動 `apps.json` 裡登記過的程式，不會執行看板傳來的任意指令。

## 移除

`uninstall-auto-sync.bat`（移除排程）＋ `uninstall.bat`（移除協定）。

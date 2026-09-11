---
name: update-project-status
description: 在當前專案的 doc/status.json 產生或更新進度狀態，供「App 進度追蹤」看板讀取。當使用者說「更新進度」「產生 status」「收尾」「同步進度看板」「update status」時觸發。
---

# 更新專案進度狀態

在當前專案 repo 的 `doc/status.json` 產生或更新一份結構化進度檔，供跨電腦的「App 進度追蹤」看板讀取。

## 執行步驟

1. 確認當前所在的 repo 根目錄；`status.json` 一律寫到 `doc/status.json`（資料夾不存在就建立）。
2. 蒐集進度資訊，依序從下列來源判斷，不要憑空捏造：
   - 既有的 `doc/status.json`（若存在，當作基準更新）。
   - `doc/` 內的進度筆記、`README.md`、最近的 git log。
   - 若資訊不足以判斷某欄位，明確留空或沿用舊值，不要腦補。
3. 依下列規則決定 `status`：
   - 只建了資料夾、僅有想法、尚未開工：`planned`
   - 正在開發：`in-progress`
   - 已完工：`done`（此值通常由使用者明確指示才設定；不確定時維持 `in-progress`）
4. 自動記錄所在電腦與本機路徑（供看板「開啟」按鈕使用）：
   - `host`：這台電腦的名稱。Windows 取 `%COMPUTERNAME%`（或執行 `hostname`）。
   - `path`：專案資料夾的絕對路徑（目前 repo 根目錄，例如 `D:\專案\your-repo`）。
   - 兩者用程式取得，不要用猜的；取不到再詢問使用者。
5. 寫出符合規格的 JSON（欄位見下方），`updatedAt` 設為今天日期 `YYYY-MM-DD`。
5. 寫檔後，回報 Status / Root Cause（若有問題）/ Suggested Fix，並列出本次變更的欄位差異。
6. 詢問使用者是否要 `git add doc/status.json && git commit && git push`，由使用者確認後再執行（不可逆動作前先確認）。

## status.json 欄位

```json
{
  "name": "<repo 名稱，例如 your-repo>",
  "title": "<顯示標題>",
  "status": "planned | in-progress | done",
  "category": "<軟體分類，例如 ERP、計時器、AI 工具>",
  "cycles": [{ "start": "<起始 YYYY-MM-DD>", "end": "<結束 YYYY-MM-DD，進行中留空>", "note": "<這段做了什麼>" }],
  "summary": "<簡易說明：這個軟體是什麼>",
  "progress": "<進度說明：已完成與待完成都寫在這，可多行>",
  "notes": "<手寫備註：保留既有，不要覆蓋>",
  "host": "<這台電腦名稱，取自 %COMPUTERNAME%>",
  "path": "<專案資料夾絕對路徑，例如 D:\\專案\\your-repo>",
  "apps": ["<開啟用的應用程式名稱，例如 Antigravity、Claude；可多個>"],
  "links": [{ "label": "<AI Studio／線上版／Canvas>", "url": "<https://...>" }],
  "tags": ["關鍵字"],
  "updatedAt": "YYYY-MM-DD",
  "completedAt": null
}
```

## 約束

- 先讀既有 `status.json` 當基準。`notes`（手寫備註）一律原樣保留，絕對不要覆蓋或刪除。
- `progress` 用單一欄位，已完成與待完成都寫在這（可分段、多行），不要再拆 `completed`／`todo` 陣列。預設「附加更新」，除非使用者要求完整重寫。
- `cycles` 開發週期：
  - 起始日可由名稱日期前綴、資料夾建檔日或首次 commit 推得。
  - 結束日取「最後一次實際開發（程式碼 commit）的日期」，用 `git log` 取得，忽略只動 `doc/` 的 commit；不要用「今天」。
  - 若上一段已結束、之後又有新開發，新增一段 `cycles`，舊段保留（不要改動）。
- `links`：若專案是 Google AI Studio／Canvas 製作，或 README、部署設定有線上網址，填入對應連結（AI Studio app 連結、線上部署頁等）。純雲端工具型專案可不填 `path`／`apps`，改用 `links`。
- `host` 若無法判斷，詢問使用者目前在哪台電腦，不要猜。
- 保持繁體中文，欄位內容精煉，不堆砌形容詞。
- `progress` 上限 500 字：只寫「現在做到哪、下一步是什麼」的摘要。完整開發紀錄屬於 `doc/backup-*.md`，不屬於看板卡片（2026-08-22 補充：先前普遍把收工總結整段灌進來，把看板卡撐爆）。
- `category` 從受控清單選，不自創：AI 工具、行銷工具、網站、教學、工具、基礎建設、其他。對不上就填「其他」。
- `summary` 一句話（100 字內），它是卡片上的單行摘要。

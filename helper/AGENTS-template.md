# 專案協作規則（給 AI 開發助手）

本檔同時供 Claude Code 與 Antigravity 自動讀取。請嚴格遵守。

## 更新「App 進度追蹤」看板

當使用者說「更新看板進度」「更新進度並推送」「同步進度到看板」或類似指令時，
請依以下固定步驟執行，不要自行改成 git push 或更新其他進度檔（例如 BACKLOG.md）：

1. 更新本專案的 `doc/status.json`（看板唯一讀取的資料檔）。
   - 依現況修改 `status`（planned｜in-progress｜done）、`progress`（已完成／待完成）、`updatedAt`、必要時 `cycles`、`links`。
   - 不要覆寫 `notes` 欄位（那是使用者手寫）。
   - `doc/status.json` 不存在時，依 `doc/status-schema.md` 或既有同類專案格式建立。

2. 送上看板，二選一（依本專案是否在 GitHub）：
   - 本專案有 GitHub 遠端：對 `doc/status.json` 做 commit 並 `git push`。看板會直接讀到，不需其他動作。
   - 本專案沒有 GitHub 遠端：執行
     `powershell -ExecutionPolicy Bypass -File <看板小幫手資料夾>\push-status.ps1 "<本專案資料夾絕對路徑>"`

3. 完成後回報：更新了哪些欄位、用哪一種方式送上看板、是否成功。

## 不要做的事

- 不要把「推送」解讀成只做 git push 而不更新 `doc/status.json`。
- 不要更新 BACKLOG.md／README 就當成「已更新看板」。看板不讀那些檔。
- 不要為了找資料反覆全庫搜尋；status.json 已存在時直接就地更新即可。

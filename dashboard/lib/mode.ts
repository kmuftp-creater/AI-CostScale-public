/**
 * 安裝模式。COSTSCALE_MODE=local 代表「裝在自己電腦上」（由 docker-compose.setup.yml 的設定工具寫進 .env），
 * 沒設或其他值代表雲端主機（VPS）安裝。
 *
 * 兩種模式的差別只有一處會影響畫面：本機模式沒有主機端的 apply-upstream-key.py 排程
 * （它要操作 Docker，儀表板不掛 docker socket，所以本機模式不提供），
 * 「新增／移除上游金鑰」這類要排進佇列的功能永遠不會有人處理，不能讓使用者送出。
 *
 * 這個檔案只依賴環境變數，不引用其他檔案，方便用 node 直接跑測試。
 */
export function isLocalMode(env: Record<string, string | undefined> = process.env): boolean {
  return (env.COSTSCALE_MODE ?? "").trim().toLowerCase() === "local";
}

/** 本機模式下，要排進佇列的上游金鑰操作的白話說明。API 回這一句，畫面也顯示同一句。 */
export const LOCAL_KEY_NOTICE =
  "本機安裝模式不能在這個畫面新增、移除或修改上游金鑰：這些操作要排進佇列，由雲端主機上的排程套用，本機模式沒有那支排程，送出後會永遠停在排隊中。";

/** 本機模式移除一把金鑰的正式做法。 */
export const LOCAL_REMOVE_KEY_STEPS = [
  "打開終端機（Windows 用 PowerShell），切到放這個專案的資料夾。",
  "執行：docker compose -f docker-compose.setup.yml run --rm setup",
  "在選單選「移除 AI 金鑰」，選要移除的那一把。",
  "執行：docker compose up -d",
  "要讓那把金鑰真正作廢，還要到供應商的後台（例如 Google AI Studio）把它停用或刪除。",
];

/** 本機模式加金鑰的正式做法，分成步驟給畫面逐行顯示。 */
export const LOCAL_KEY_STEPS = [
  "打開終端機（Windows 用 PowerShell），切到放這個專案的資料夾。",
  "執行：docker compose -f docker-compose.setup.yml run --rm setup",
  "在選單選「新增 AI 金鑰」，選供應商、貼上金鑰（輸入時畫面不會顯示）。",
  "執行：docker compose up -d",
  "回到這個畫面重新整理，這一頁會出現新的金鑰尾碼，總覽的上手清單第 1 步會打勾。",
];

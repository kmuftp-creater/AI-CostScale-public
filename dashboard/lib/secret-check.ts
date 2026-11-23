/**
 * 「祕密欄位是不是真的設過」的判斷，全站只有這一份。
 *
 * .env.example 的範本值（change-me-authjs-secret、change-me-cron-token……）是公開的，
 * 誰都知道。欄位留著範本值、空值或太短，等於沒有祕密：拿它簽 session、拿它當 Bearer token
 * 都會被別人複製。所以這幾種情況一律視為「未設定」，由呼叫端拒絕服務。
 *
 * 這個檔案不引用任何其他檔案，只用可被型別剝除的語法，方便用 node 直接跑測試
 * （dashboard/scripts/test-secret-check.mjs）。
 */

/** AUTH_SECRET 至少要幾個字元（openssl rand -hex 32 會產生 64 個）。 */
export const MIN_AUTH_SECRET_LENGTH = 32;

export type SecretProblem = "empty" | "template" | "short";

/**
 * 回傳這個值有什麼問題；沒問題回 null。
 * - empty：空字串、只有空白、undefined
 * - template：placeholder、以 change-me 或 sk-change-me 開頭（.env.example 的範本值，不分大小寫）
 * - short：去掉前後空白後短於 minLength（minLength 為 0 時不檢查）
 */
export function secretProblem(value: string | undefined | null, minLength = 0): SecretProblem | null {
  const s = (value ?? "").trim();
  if (s === "") return "empty";
  const lower = s.toLowerCase();
  if (lower === "placeholder" || lower.startsWith("change-me") || lower.startsWith("sk-change-me")) return "template";
  if (minLength > 0 && s.length < minLength) return "short";
  return null;
}

/** 共用 token（ALERT_CRON_TOKEN、OTEL_INGEST_TOKEN、BOARD_PUSH_TOKEN、HUB_API_TOKEN）是否等同「未設定」。 */
export function tokenUnset(value: string | undefined | null): boolean {
  return secretProblem(value) !== null;
}

/** AUTH_SECRET 的問題；null 代表可以用。 */
export function authSecretProblem(env: Record<string, string | undefined> = process.env): SecretProblem | null {
  return secretProblem(env.AUTH_SECRET, MIN_AUTH_SECRET_LENGTH);
}

/** 給登入頁與 log 用的白話原因。 */
export function secretProblemText(p: SecretProblem): string {
  if (p === "empty") return "是空的";
  if (p === "template") return "還是範本裡的預設值";
  return `太短（至少要 ${MIN_AUTH_SECRET_LENGTH} 個字元）`;
}

/**
 * 從 DATABASE_URL（postgresql://使用者:密碼@主機:埠/資料庫）取出資料庫密碼，回傳它的問題；沒問題或讀不出來回 null。
 * 儀表板容器拿不到 DB_PASSWORD 本身，只拿得到組好的 DATABASE_URL，所以從這裡判斷「資料庫密碼是不是範本值」。
 */
export function dbPasswordProblem(databaseUrl: string | undefined | null): SecretProblem | null {
  const url = (databaseUrl ?? "").trim();
  if (url === "") return null;
  try {
    const pw = decodeURIComponent(new URL(url).password);
    return secretProblem(pw);
  } catch {
    return null;
  }
}

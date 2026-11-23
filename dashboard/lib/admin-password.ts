/**
 * 管理員帳號密碼登入：設定解析與驗證。
 *
 * 設定來源是 .env 的兩個欄位，兩個都有值才啟用帳密登入：
 *   AUTH_ADMIN_USER          帳號，英數開頭，其餘英數與 . _ -，3 到 32 字元
 *   AUTH_ADMIN_PASSWORD_HASH scrypt:<N>:<r>:<p>:<salt hex>:<hash hex>
 *
 * 雜湊格式刻意不含 $：docker compose 會把 .env 值裡的 $ 當變數替換。
 * 雜湊由 scripts/set-admin-password.sh（python3 hashlib.scrypt）產生，這裡只負責驗證。
 *
 * 這個檔案只依賴 node:crypto，不引用專案其他檔案，方便用 node 直接跑跨語言測試
 * （dashboard/scripts/test-admin-password.mjs）。只用「可被型別剝除」的語法。
 */
import { scrypt, timingSafeEqual, createHash } from "node:crypto";

export const ADMIN_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

/** 輸入長度上限。超過的一律視為帳密錯誤，不進 scrypt。 */
export const MAX_USER_INPUT = 64;
export const MAX_PASSWORD_INPUT = 1024;

/**
 * 輸入是否在長度上限內（且兩者都是字串、密碼非空）。auth.ts 在進驗證之前先用它擋：
 * 超過的一律當成一般的登入失敗（照樣計入失敗次數），不進 scrypt。
 */
export function inputWithinLimits(user: unknown, password: unknown): boolean {
  return (
    typeof user === "string" &&
    typeof password === "string" &&
    user.length <= MAX_USER_INPUT &&
    password.length > 0 &&
    password.length <= MAX_PASSWORD_INPUT
  );
}

const KEY_LEN = 32;
const HEX = /^[0-9a-f]+$/;

export type ParsedHash = {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

export type AdminConfig = {
  user: string;
  parsed: ParsedHash;
  /** 目前雜湊的指紋。寫進 JWT，密碼一換舊 session 就失效。 */
  fingerprint: string;
};

/** 解析雜湊字串。格式不對或參數超出範圍回 null，不丟例外。 */
export function parseHash(value: string | undefined | null): ParsedHash | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nS, rS, pS, saltHex, hashHex] = parts;
  if (!/^[0-9]{1,7}$/.test(nS) || !/^[0-9]{1,3}$/.test(rS) || !/^[0-9]{1,3}$/.test(pS)) return null;
  const n = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  // N 必須是 2 的次方，範圍 2^14 到 2^16：低於 2^14 太弱，高於 2^16 會讓每次嘗試吃掉過多記憶體
  if (!Number.isInteger(Math.log2(n)) || n < 16384 || n > 65536) return null;
  if (r < 1 || r > 8) return null;
  if (p < 1 || p > 4) return null;
  if (saltHex.length < 32 || saltHex.length > 128 || saltHex.length % 2 !== 0 || !HEX.test(saltHex)) return null;
  if (hashHex.length !== KEY_LEN * 2 || !HEX.test(hashHex)) return null;
  return { n, r, p, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      KEY_LEN,
      { N: n, r, p, maxmem: 128 * n * r * 2 + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[auth] ${msg}`);
}

/**
 * 讀 .env 的設定。兩個欄位都沒填：回 null（沒有啟用，不警告）。
 * 只填一個、帳號格式不對、雜湊格式不對：回 null 並在 log 印一行警告（不印雜湊內容）。
 */
export function getAdminConfig(env: Record<string, string | undefined> = process.env): AdminConfig | null {
  const user = (env.AUTH_ADMIN_USER ?? "").trim();
  const rawHash = (env.AUTH_ADMIN_PASSWORD_HASH ?? "").trim();
  if (!user && !rawHash) return null;
  if (!user || !rawHash) {
    warnOnce("half", "AUTH_ADMIN_USER 與 AUTH_ADMIN_PASSWORD_HASH 只填了一個，帳密登入停用。兩個都要有值。");
    return null;
  }
  if (!ADMIN_USER_PATTERN.test(user)) {
    warnOnce("user", "AUTH_ADMIN_USER 格式不對（英數開頭，其餘英數與 . _ -，3 到 32 字元），帳密登入停用。");
    return null;
  }
  const parsed = parseHash(rawHash);
  if (!parsed) {
    warnOnce("hash", "AUTH_ADMIN_PASSWORD_HASH 格式不對或參數超出範圍，帳密登入停用。請重跑 scripts/set-admin-password.sh。");
    return null;
  }
  const fingerprint = createHash("sha256").update(`${user}\n${rawHash}`).digest("hex").slice(0, 24);
  return { user, parsed, fingerprint };
}

// 帳號不存在時也要做同樣一次 scrypt，不讓回應時間洩漏帳號是否正確。
// 用固定的假 salt；結果永遠不會被當成通過。
const DUMMY_SALT = Buffer.alloc(16, 0x5a);

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * 驗證帳號與密碼。不論帳號對不對，都恰好做一次 scrypt；帳號與雜湊都用 timingSafeEqual 比較。
 * 輸入不是字串或超過長度上限一律回 false（仍會做一次 scrypt，時間一致）。
 */
export async function verifyAdminLogin(cfg: AdminConfig, user: unknown, password: unknown): Promise<boolean> {
  const okType = typeof user === "string" && typeof password === "string";
  const u = okType ? (user as string) : "";
  const pw = okType ? (password as string) : "";
  const inputOk = okType && inputWithinLimits(u, pw);

  const userOk = inputOk && timingSafeEqual(sha256(u), sha256(cfg.user));
  const { n, r, p } = cfg.parsed;
  const salt = userOk ? cfg.parsed.salt : DUMMY_SALT;
  const got = await derive(inputOk ? pw : "x", salt, n, r, p);
  const hashOk = timingSafeEqual(got, cfg.parsed.hash);
  return inputOk && userOk && hashOk;
}

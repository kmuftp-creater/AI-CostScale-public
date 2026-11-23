import { randomBytes } from "node:crypto";
import NextAuth, { CredentialsSignin } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { getAdminConfig, inputWithinLimits, verifyAdminLogin } from "@/lib/admin-password";
import { googleEnabled } from "@/lib/auth-config";
import { authSecretProblem, secretProblemText } from "@/lib/secret-check";
import {
  clientIp,
  confirmFailure,
  globalDelayMs,
  lockedMinutes,
  recordSuccess,
  reserveAttempt,
} from "@/lib/login-throttle";

function allowedEmails(): string[] {
  return (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** 帳號或密碼錯。帳號錯與密碼錯回同一個代碼，登入頁顯示同一句話。 */
class InvalidLogin extends CredentialsSignin {
  code = "invalid";
}

/** 這個來源 IP 被暫時鎖定。代碼帶剩餘分鐘數，登入頁據此顯示要等多久。 */
class LockedLogin extends CredentialsSignin {
  constructor(minutes: number) {
    super();
    this.code = `locked_${minutes}`;
  }
}

/** log 只留單行：把可能帶換行或控制字元的內容洗成安全的短字串。 */
function oneLine(v: unknown): string {
  return String(v ?? "")
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 64);
}

function logLogin(ip: string, result: string): void {
  // 固定一行：時間、來源、原因類別。不記輸入的帳號與密碼，不印堆疊。
  console.warn(`[auth] ${new Date().toISOString()} login ip=${oneLine(ip)} result=${oneLine(result)}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// AUTH_SECRET 是空值、.env.example 的範本值或短於 32 個字元時，等同沒有設定：
// 不接受任何 session、不讓任何人登入。範本值是公開的，用它簽出來的 token 誰都做得出來。
const SECRET_PROBLEM = authSecretProblem();
const SECRET_BAD = SECRET_PROBLEM !== null;
if (SECRET_PROBLEM !== null && process.env.AUTH_DISABLED !== "1" && process.env.NEXT_PHASE !== "phase-production-build") {
  const g = globalThis as unknown as { __csSecretWarned?: boolean };
  if (!g.__csSecretWarned) {
    g.__csSecretWarned = true;
    console.warn(
      `[auth] 警告：AUTH_SECRET ${secretProblemText(SECRET_PROBLEM)}，儀表板已停用所有登入，也不接受任何 session。請把 .env 的 AUTH_SECRET 換成新的亂數並重建儀表板（登入頁有步驟）。`,
    );
  }
}
// 密鑰有問題時，給 next-auth 一把每次啟動重新產生、沒人知道的密鑰，
// 確保它不會退回用環境變數裡那個公開的（或空的）值去簽發或驗證 token。
const SECRET_OVERRIDE = SECRET_BAD ? randomBytes(32).toString("hex") : undefined;

const providers = [];
if (!SECRET_BAD) {
  if (googleEnabled()) providers.push(Google);
  if (getAdminConfig()) {
    providers.push(
      Credentials({
        credentials: {
          username: { label: "帳號", type: "text" },
          password: { label: "密碼", type: "password" },
        },
        async authorize(credentials, request) {
          const ip = clientIp(request.headers);
          const cfg = getAdminConfig();
          if (!cfg) {
            logLogin(ip, "not_configured");
            throw new InvalidLogin();
          }
          const delay = globalDelayMs();
          if (delay > 0) await sleep(delay);

          // 先佔一次嘗試額度（同步、不可分割）：同一來源在鎖定前最多進行 5 次驗證。
          const locked = reserveAttempt(ip);
          if (locked > 0) {
            logLogin(ip, "locked");
            throw new LockedLogin(locked);
          }

          const username = credentials?.username;
          const password = credentials?.password;
          let ok = false;
          let reason = "bad_credentials";
          if (!inputWithinLimits(username, password)) {
            // 帳號超過 64、密碼超過 1024 個字元，或型別不對：當成一般登入失敗，不進 scrypt。
            reason = "bad_input";
          } else {
            try {
              ok = await verifyAdminLogin(cfg, username, password);
            } catch {
              reason = "verify_error";
            }
          }
          if (!ok) {
            confirmFailure();
            logLogin(ip, reason);
            const nowLocked = lockedMinutes(ip);
            if (nowLocked > 0) throw new LockedLogin(nowLocked);
            throw new InvalidLogin();
          }
          recordSuccess(ip); // 退回佔掉的額度
          logLogin(ip, "ok");
          // 帳密登入沒有信箱，session.user.name 就是帳號。
          return { id: `admin:${cfg.user}`, name: cfg.user };
        },
      }),
    );
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers,
  secret: SECRET_OVERRIDE,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  // 失敗登入只留 auth 自己那一行（logLogin）；其餘錯誤也只印單行，不印堆疊。
  logger: {
    error(error) {
      const type = oneLine((error as { type?: string }).type ?? error.name);
      if (type === "CredentialsSignin") return;
      console.error(`[auth] ${new Date().toISOString()} error type=${type}`);
    },
    warn(code) {
      console.warn(`[auth] ${new Date().toISOString()} warn code=${oneLine(code)}`);
    },
    debug() {},
  },
  callbacks: {
    async signIn({ user, account }) {
      if (SECRET_BAD) return false;
      // 帳密登入已在 authorize 驗證過，不看信箱白名單。
      if (account?.provider === "credentials") return true;
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const allow = allowedEmails();
      // 白名單為空時，出於安全考量一律拒絕（不能因為忘了設變數就對所有人開放）。
      if (allow.length === 0) return false;
      return allow.includes(email);
    },
    async jwt({ token, user, account }) {
      if (SECRET_BAD) return null;
      if (account?.provider === "credentials" && user) {
        // 記下登入時的雜湊指紋：改密碼或停用帳密登入後，舊的帳密 session 會失效。
        token.pwv = getAdminConfig()?.fingerprint ?? null;
        token.method = "credentials";
        return token;
      }
      if (token.method === "credentials") {
        const cfg = getAdminConfig();
        if (!cfg || token.pwv !== cfg.fingerprint) return null;
      }
      return token;
    },
    async session({ session }) {
      return session;
    },
  },
});

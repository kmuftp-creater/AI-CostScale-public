import NextAuth, { CredentialsSignin } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { getAdminConfig, verifyAdminLogin } from "@/lib/admin-password";
import { googleEnabled } from "@/lib/auth-config";
import {
  clientIp,
  globalDelayMs,
  lockedMinutes,
  recordFailure,
  recordSuccess,
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

function logLogin(ip: string, result: string): void {
  // 只記時間、IP、結果類別。不記輸入的帳號與密碼。
  console.warn(`[auth] ${new Date().toISOString()} login ip=${ip} result=${result}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const providers = [];
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

        const locked = lockedMinutes(ip);
        if (locked > 0) {
          logLogin(ip, "locked");
          throw new LockedLogin(locked);
        }

        const ok = await verifyAdminLogin(cfg, credentials?.username, credentials?.password);
        if (!ok) {
          recordFailure(ip);
          logLogin(ip, "bad_credentials");
          const nowLocked = lockedMinutes(ip);
          if (nowLocked > 0) throw new LockedLogin(nowLocked);
          throw new InvalidLogin();
        }
        recordSuccess(ip);
        logLogin(ip, "ok");
        // 帳密登入沒有信箱，session.user.name 就是帳號。
        return { id: `admin:${cfg.user}`, name: cfg.user };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ user, account }) {
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

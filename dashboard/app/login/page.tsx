import Image from "next/image";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { loginMethods } from "@/lib/auth-config";

export const metadata = {
  title: "登入 · AI CostScale",
};

// 登入頁要依 .env 即時判斷有哪些登入方式，不能在建置時就定死。
export const dynamic = "force-dynamic";

/** 登入後要回去的路徑：只收站內路徑，擋掉 //evil.com 與 /\evil.com 這類寫法。 */
function safeRedirect(from: string | undefined): string {
  if (!from || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/\\") || from === "/login") {
    return "/";
  }
  return from;
}

/** 錯誤代碼轉成白話訊息。只認白名單內的代碼，網址上其他內容一律不顯示。 */
function errorMessage(error?: string, code?: string): string | null {
  if (!error) return null;
  if (error === "AccessDenied") return "登入失敗：這個 Google 帳號不在允許名單內，或授權被拒絕。";
  if (error === "CredentialsSignin") {
    const m = /^locked_(\d{1,3})$/.exec(code ?? "");
    if (m) return `輸錯次數太多，這個網路位置暫時不能登入。請等 ${m[1]} 分鐘後再試。`;
    return "帳號或密碼不正確。";
  }
  return "登入失敗，請再試一次。";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string; from?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = safeRedirect(params.from);
  const { password, google } = loginMethods();
  const message = errorMessage(params.error, params.code);

  async function passwordLogin(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        redirectTo,
      });
    } catch (e) {
      // 登入成功時 signIn 會丟出導向用的例外，必須原樣往外丟；只攔登入失敗。
      if (e instanceof AuthError) {
        const code = (e as { code?: string }).code ?? "";
        const q = new URLSearchParams({ error: "CredentialsSignin", code });
        if (redirectTo !== "/") q.set("from", redirectTo);
        redirect(`/login?${q.toString()}`);
      }
      throw e;
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Image
          className="login-art"
          src="/login-illustration.png"
          alt="AI CostScale：小機器人在挖 token 硬幣"
          width={160}
          height={160}
          priority
        />
        <div className="login-title">AI CostScale</div>
        <div className="login-sub">AI 用量與成本管理中心</div>

        {password ? (
          <form className="login-form" action={passwordLogin}>
            <label className="login-field">
              <span>帳號</span>
              <input
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                required
              />
            </label>
            <label className="login-field">
              <span>密碼</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                required
              />
            </label>
            <button className="btn-login" type="submit">
              登入
            </button>
          </form>
        ) : null}

        {password && google ? <div className="login-or">或</div> : null}

        {google ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo });
            }}
          >
            <button className="btn-google" type="submit">
              <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.4 17.7 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.2 0 11.4-2 15.4-5.5l-7.5-5.8c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.7-3.9-13.6-9.3l-7.8 6.1C6.5 42.6 14.6 48 24 48z"
                />
              </svg>
              使用 Google 登入
            </button>
          </form>
        ) : null}

        {google && !password ? <div className="login-note">僅限允許名單內的 Google 帳號</div> : null}

        {!password && !google ? (
          <div className="login-empty" role="alert">
            <strong>還沒有設定任何登入方式</strong>
            <p>目前沒有人能登入這個儀表板，這是刻意的，系統不會在沒有設定時放行任何人。</p>
            <p>在安裝這個系統的主機上執行下面這一行，依畫面提示設定管理員帳號與密碼：</p>
            <code>bash /opt/costscale/scripts/set-admin-password.sh</code>
            <p>腳本最後會印出一行 docker compose 指令，照著執行讓設定生效，再重新整理這個頁面。</p>
            <p>想改用 Google 登入的話，做法見 INSTALL.md 第 4 節。</p>
          </div>
        ) : null}

        {message ? (
          <div className="login-error" role="alert">
            {message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

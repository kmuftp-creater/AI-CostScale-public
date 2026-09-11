import Image from "next/image";
import { signIn } from "@/auth";

export const metadata = {
  title: "登入 · AI CostScale",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = params.from && params.from !== "/login" ? params.from : "/";

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
        <div className="login-note">僅限白名單帳號存取</div>
        {params.error ? (
          <div className="login-error">登入失敗：帳號不在白名單內，或授權被拒絕。</div>
        ) : null}
      </div>
    </div>
  );
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { authSecretProblem } from "@/lib/secret-check";
import { noteAuthDisabledPass } from "@/lib/security-env";

/**
 * Next.js 16 把 middleware.js 重新命名為 proxy.js（行為相同，只是換了檔名與
 * 匯出函式名），這裡沿用官方新慣例。功能對應原始需求裡的 middleware.ts：
 * AUTH_DISABLED=1 時直接放行；否則沒有 session 一律導去 /login。
 *
 * API 路由（/api/**）不在這裡擋，各自的 route handler 用 lib/auth-guard.ts
 * 的 requireSession() 自行檢查，這樣 OTLP 等非瀏覽器呼叫方也能拿到明確的
 * JSON 錯誤而不是被導向 HTML 登入頁。
 */
export async function proxy(request: NextRequest) {
  if (process.env.AUTH_DISABLED === "1") {
    // 放行時留一行警告（有節流）；每一頁最上方另有醒目橫幅（components/SecurityBanner.tsx）。
    noteAuthDisabledPass();
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (pathname === "/login") {
    return NextResponse.next();
  }

  // AUTH_SECRET 沒設好（空值、範本值、太短）：不看任何 session，一律當成沒登入。
  // auth.ts 本身也已停用所有登入並換掉簽章密鑰，這裡是第二道，不依賴 next-auth 的行為。
  const session = authSecretProblem() !== null ? null : await auth();
  if (!session?.user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // 靜態資源（Logo、圖示）與 API 一律不經過登入守衛，
    // 否則未登入時登入頁自己的 Logo 也會被導去 /login。登入頁用到的圖都要列在這裡。
    "/((?!api|_next/static|_next/image|favicon.ico|logo.png|icon.png|apple-icon.png|login-illustration.png).*)",
  ],
};

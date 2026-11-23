import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { authSecretProblem } from "@/lib/secret-check";
import { noteAuthDisabledPass } from "@/lib/security-env";

/**
 * API 路由的共用 session 檢查。AUTH_DISABLED=1 時（本機開發捷徑）直接放行。
 * 回傳 null 代表通過檢查；回傳 NextResponse 代表呼叫方應立即 return 它。
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (process.env.AUTH_DISABLED === "1") {
    noteAuthDisabledPass(); // 放行時留一行警告（有節流）
    return null;
  }
  // AUTH_SECRET 沒設好（空值、範本值、太短）：不看任何 session，一律 401。
  const session = authSecretProblem() !== null ? null : await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "未登入或 session 已過期" }, { status: 401 });
  }
  return null;
}

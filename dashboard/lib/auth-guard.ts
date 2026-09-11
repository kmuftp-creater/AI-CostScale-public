import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * API 路由的共用 session 檢查。AUTH_DISABLED=1 時（本機開發捷徑）直接放行。
 * 回傳 null 代表通過檢查；回傳 NextResponse 代表呼叫方應立即 return 它。
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (process.env.AUTH_DISABLED === "1") {
    return null;
  }
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "未登入或 session 已過期" }, { status: 401 });
  }
  return null;
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { syncBoardGithub } from "@/lib/board-write";

export const dynamic = "force-dynamic";

/**
 * POST /api/board/sync —— 立刻重抓 GitHub 側資料。
 *
 * 兩種呼叫者：介面的「重新整理」按鈕（走 session），
 * 以及 VPS 的排程（走 ALERT_CRON_TOKEN，與既有告警排程同一把）。
 * 同一支實作服務兩者，不像先前介面按不到 python 腳本。
 */
export async function POST(request: NextRequest) {
  const cronToken = process.env.ALERT_CRON_TOKEN;
  const auth = request.headers.get("authorization") || "";
  const viaCron = Boolean(cronToken) && auth === `Bearer ${cronToken}`;

  if (!viaCron) {
    const guard = await requireSession();
    if (guard) return guard;
  }

  try {
    const r = await syncBoardGithub();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    // 同步失敗不該讓畫面空白：回錯誤訊息，前端顯示但保留現有資料。
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "同步失敗" },
      { status: 500 }
    );
  }
}

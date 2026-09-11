import { NextRequest, NextResponse } from "next/server";
import { sendMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/bridge —— 橋接隧道的告警出口。
 *
 * 為什麼需要這支：橋接跑在家用主機，SSH 反向隧道斷掉時閘道的 sub-* 全部不可用，
 * 但先前沒有任何通知——2026-08-23 就這樣斷了 83 分鐘，是 User 看到黑窗閃才發現。
 * supervisor 連續健檢失敗跨過門檻時打這裡，恢復時再打一次。
 *
 * 驗證用 ALERT_CRON_TOKEN（與既有告警排程同一把）。沒設定就回 503——
 * 預設關比預設開安全，與 /api/board/push、/api/hub/spend 同一原則。
 *
 * 寄信本身沿用 lib/mail 的設定（SMTP_* 與 ALERT_EMAIL_TO），
 * 所以本機那端不必存任何 SMTP 帳密。
 */

/** 固定時間比對，不因前綴相同而提早返回。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  const expected = process.env.ALERT_CRON_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      { error: "伺服器未設定 ALERT_CRON_TOKEN，端點停用中" },
      { status: 503 }
    );
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(token, expected)) {
    return NextResponse.json({ error: "驗證失敗" }, { status: 401 });
  }

  let body: { subject?: unknown; body?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!subject) return NextResponse.json({ error: "缺少 subject" }, { status: 400 });

  // 主旨長度設上限：這支只給橋接用，過長多半是呼叫端出錯，不要原樣送進信件標頭。
  const r = await sendMail(subject.slice(0, 200), text.slice(0, 4000) || subject);
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { addManualCharge } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 人工補一筆訂閱扣款（2026-09-21）。
 *
 * User 的情境：「升級是補差額，我有可能是這個月想從 5X 升級成 10X」。
 * 排程只會在 billing_day 凍結固定月費，升級當下補的差額沒有地方記。
 *
 * body：{ subId, chargedOn: "YYYY-MM-DD", fee, currency, note? }
 *
 * 兩件刻意的事：
 *
 * 1. **不做 upsert。** 補兩次就是兩筆，由操作者負責。自動去猜「這筆是不是重複」
 *    會吃掉合法的第二筆（同一個月確實可能補兩次差額）。
 * 2. **不接受未來日期。** 這張表記的是「已經發生的扣款」，未來的那筆該由排程
 *    在當天凍結當天的匯率。允許先填會讓帳面出現一筆用今天匯率算的未來扣款。
 */
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const subId = Number(body.subId);
  if (!Number.isInteger(subId) || subId <= 0) {
    return NextResponse.json({ error: "subId 不合法" }, { status: 400 });
  }

  const chargedOn = String(body.chargedOn ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chargedOn)) {
    return NextResponse.json({ error: "扣款日要是 YYYY-MM-DD" }, { status: 400 });
  }
  const when = new Date(`${chargedOn}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) {
    return NextResponse.json({ error: "扣款日不是有效日期" }, { status: 400 });
  }
  // 用台北時間的今天當上界：伺服器是 UTC，直接比會讓台北的今天早上被當成未來。
  const todayTaipei = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (chargedOn > todayTaipei) {
    return NextResponse.json(
      { error: `扣款日不能是未來（今天是 ${todayTaipei}）。未來的月費會由排程在當天凍結。` },
      { status: 400 }
    );
  }

  const fee = Number(body.fee);
  if (!Number.isFinite(fee) || fee <= 0) {
    return NextResponse.json({ error: "金額要大於 0" }, { status: 400 });
  }

  const currency = String(body.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return NextResponse.json({ error: "幣別要是三個字母（例如 USD、TWD）" }, { status: 400 });
  }

  const rawNote = body.note == null ? "" : String(body.note).trim();
  const note = rawNote ? rawNote.slice(0, 200) : null;

  try {
    const charge = await addManualCharge({ subId, chargedOn, fee, currency, note });
    return NextResponse.json({ charge });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 外鍵不存在是「訂閱被刪了」，那是 404 不是 500，訊息要講得出所以然。
    if (msg.includes("subscription_charges_sub_id_fkey")) {
      return NextResponse.json({ error: "找不到這個訂閱" }, { status: 404 });
    }
    console.warn("[api] addManualCharge failed:", msg);
    return NextResponse.json({ error: `寫入失敗：${msg}` }, { status: 500 });
  }
}

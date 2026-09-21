import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { setChargeActual, deleteManualCharge } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 填入某一筆扣款的實際入帳金額（2026-08-25，D-2）。
 *
 * 只接受 actualTwd 一個欄位。凍結的那五欄（fee、currency、fx_rate、
 * fx_source、markup_pct）**沒有任何路徑可以從介面改**——
 * 那是刻意的：對帳是拿實際去比對當初凍結的預期，
 * 一旦讓對帳反過來改寫預期，就沒有東西可以比了。
 *
 * 傳 null 表示取消對帳，填錯時要退得回去。
 */
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  if (!("actualTwd" in body)) {
    return NextResponse.json({ error: "缺少 actualTwd" }, { status: 400 });
  }

  let actual: number | null = null;
  const raw = body.actualTwd;
  if (raw !== null && raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      // 0 或負數一定是填錯：沒扣款的話這一列根本不會存在。
      return NextResponse.json({ error: "實際入帳金額必須大於 0" }, { status: 400 });
    }
    actual = Math.round(n * 100) / 100;
  }

  const updated = await setChargeActual(numericId, actual);
  if (!updated) {
    return NextResponse.json({ error: "更新失敗（找不到這筆扣款）" }, { status: 400 });
  }
  return NextResponse.json({ charge: updated });
}

/**
 * 刪掉一筆人工補的扣款（2026-09-21）。
 *
 * **只能刪 `source='manual'`。** 排程凍結的那些是「已經發生的事」的紀錄，
 * 刪掉等於竄改帳；要調整實際金額請用 PATCH 的「實際入帳」做對帳。
 *
 * 刻意不做就地編輯：財務紀錄改錯了沒有痕跡。填錯就刪掉重補，時間序上看得出發生過什麼。
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  try {
    const row = await deleteManualCharge(numericId);
    if (!row) {
      return NextResponse.json(
        {
          error:
            "找不到這筆人工扣款，或它是排程凍結的紀錄。" +
            "排程那些不能刪——那是已經發生的事，要調整金額請填「實際入帳」做對帳。",
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, deleted: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[api] deleteManualCharge failed:", msg);
    return NextResponse.json({ error: `刪除失敗：${msg}` }, { status: 500 });
  }
}

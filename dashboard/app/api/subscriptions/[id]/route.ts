import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { patchSubscription, deleteSubscription } from "@/lib/db";

export const dynamic = "force-dynamic";

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

  const patch: Parameters<typeof patchSubscription>[1] = {};
  if (typeof body.service === "string") patch.service = body.service.trim();
  if (typeof body.plan === "string") patch.plan = body.plan.trim() || null;
  if (body.fee !== undefined) {
    const fee = Number(body.fee);
    if (!Number.isFinite(fee) || fee < 0) {
      return NextResponse.json({ error: "費用必須是 0 以上的數字" }, { status: 400 });
    }
    patch.fee = fee;
  }
  if (body.taxPct !== undefined) {
    const taxPct = Number(body.taxPct === "" ? 0 : body.taxPct);
    if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct >= 100) {
      return NextResponse.json({ error: "稅率必須是 0 到 99.999 之間的數字" }, { status: 400 });
    }
    patch.taxPct = taxPct;
  }
  if (typeof body.billingCycle === "string") {
    if (!["monthly", "yearly"].includes(body.billingCycle)) {
      return NextResponse.json({ error: "計費週期必須是 monthly 或 yearly" }, { status: 400 });
    }
    patch.billingCycle = body.billingCycle as "monthly" | "yearly";
    // 週期一改，扣款月份必須跟著改，否則會違反資料表的一致性約束。
    if (body.billingCycle === "monthly") {
      patch.billingMonth = null;
    } else if (body.billingMonth === undefined) {
      patch.billingMonth = 1;
    }
  }
  if (body.billingMonth !== undefined && body.billingMonth !== null) {
    const month = Number(body.billingMonth);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: "扣款月份必須是 1 到 12 的整數" }, { status: 400 });
    }
    patch.billingMonth = month;
  }
  if (typeof body.currency === "string") patch.currency = body.currency.trim().toUpperCase();
  if (body.billingDay !== undefined) {
    const day = Number(body.billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return NextResponse.json({ error: "扣款日必須是 1 到 28 的整數" }, { status: 400 });
    }
    patch.billingDay = day;
  }
  if (typeof body.status === "string") {
    if (!["active", "cancelled"].includes(body.status)) {
      return NextResponse.json({ error: "status 只能是 active 或 cancelled" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (typeof body.note === "string") patch.note = body.note.trim() || null;
  if (body.overseas !== undefined) {
    // null 是合法值（還沒確認），所以不能用 typeof === "boolean" 擋。
    if (body.overseas !== null && typeof body.overseas !== "boolean") {
      return NextResponse.json(
        { error: "overseas 只能是 true、false 或 null" },
        { status: 400 }
      );
    }
    patch.overseas = body.overseas;
  }
  if (typeof body.reviewAt === "string") {
    const reviewAt = body.reviewAt.trim();
    if (reviewAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) {
      return NextResponse.json({ error: "複查日要是 YYYY-MM-DD" }, { status: 400 });
    }
    // 空字串代表清掉，所以這裡送的是 null 而不是略過。
    patch.reviewAt = reviewAt || null;
  }

  const updated = await patchSubscription(numericId, patch);
  if (!updated) {
    return NextResponse.json({ error: "更新失敗（找不到資料或欄位為空）" }, { status: 400 });
  }
  return NextResponse.json({ subscription: updated });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }
  const ok = await deleteSubscription(numericId);
  if (!ok) return NextResponse.json({ error: "刪除失敗" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

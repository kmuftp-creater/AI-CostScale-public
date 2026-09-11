import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { patchBudget, deleteBudget } from "@/lib/db";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard) return guard;

  const id = parseId((await ctx.params).id);
  if (id == null) return NextResponse.json({ error: "id 不合法" }, { status: 400 });

  let body: {
    label?: string | null;
    monthlyLimit?: number | string;
    warnPct?: number | string;
    criticalPct?: number | string;
    includeGcp?: boolean;
    enabled?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof patchBudget>[1] = {};
  if (body.label !== undefined) patch.label = body.label?.trim() || null;
  if (body.monthlyLimit !== undefined) {
    const limit = Number(body.monthlyLimit);
    if (!Number.isFinite(limit) || limit <= 0) {
      return NextResponse.json({ error: "月上限必須大於 0" }, { status: 400 });
    }
    patch.monthlyLimit = limit;
  }
  for (const [key, label] of [["warnPct", "警示門檻"], ["criticalPct", "嚴重門檻"]] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1 || v > 100) {
      return NextResponse.json({ error: `${label}必須是 1 到 100 的整數` }, { status: 400 });
    }
    patch[key] = v;
  }
  if (body.includeGcp !== undefined) patch.includeGcp = Boolean(body.includeGcp);
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "沒有任何要更新的欄位" }, { status: 400 });
  }

  const updated = await patchBudget(id, patch);
  if (!updated) return NextResponse.json({ error: "更新失敗或該預算不存在" }, { status: 400 });
  return NextResponse.json({ budget: updated });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard) return guard;

  const id = parseId((await ctx.params).id);
  if (id == null) return NextResponse.json({ error: "id 不合法" }, { status: 400 });

  const ok = await deleteBudget(id);
  if (!ok) return NextResponse.json({ error: "刪除失敗" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

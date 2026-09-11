import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { patchQuotaPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** 允許明確清成 null（代表「未設定」），所以 null 與 undefined 要分開處理。 */
function parseLimit(raw: unknown, label: string): number | null | { error: string } {
  if (raw === null || raw === "") return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) return { error: `${label}必須是大於 0 的整數，或留空代表未設定` };
  return v;
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if (guard) return guard;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof patchQuotaPool>[1] = {};

  if (body.keyCount !== undefined) {
    const v = Number(body.keyCount);
    if (!Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: "金鑰把數必須是 1 以上的整數" }, { status: 400 });
    }
    patch.keyCount = v;
  }
  for (const [key, label] of [["limitRpd", "每日請求上限"], ["limitTpd", "每日 token 上限"]] as const) {
    if (body[key] === undefined) continue;
    const parsed = parseLimit(body[key], label);
    if (parsed !== null && typeof parsed === "object") {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    patch[key] = parsed;
  }
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (typeof body.note === "string") patch.note = body.note.trim() || null;

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "沒有任何要更新的欄位" }, { status: 400 });
  }

  const updated = await patchQuotaPool(id, patch);
  if (!updated) return NextResponse.json({ error: "更新失敗或該金鑰池不存在" }, { status: 400 });
  return NextResponse.json({ pool: updated });
}

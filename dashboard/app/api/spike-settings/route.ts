import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { evaluateSpikes, updateSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  return NextResponse.json(await evaluateSpikes());
}

/** 改門檻。兩個都要是正數：倍數 ≤ 1 等於「比平常多一點就報」，會天天響，響久了就沒人看。 */
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: { multiplier?: unknown; minUsd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  if (body.multiplier !== undefined) {
    const m = Number(String(body.multiplier).trim());
    if (!Number.isFinite(m) || m <= 1 || m > 100) {
      return NextResponse.json({ error: "倍數要大於 1、不超過 100" }, { status: 400 });
    }
    if (!(await updateSetting("spike_multiplier", String(m)))) {
      return NextResponse.json({ error: "寫入失敗" }, { status: 500 });
    }
  }
  if (body.minUsd !== undefined) {
    const v = Number(String(body.minUsd).replace(/[,\s$US]/g, ""));
    if (!Number.isFinite(v) || v <= 0) {
      return NextResponse.json({ error: "最低金額要大於 0" }, { status: 400 });
    }
    if (!(await updateSetting("spike_min_usd", String(v)))) {
      return NextResponse.json({ error: "寫入失敗" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}

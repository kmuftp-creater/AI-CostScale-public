import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import {
  evaluateCreditPools,
  calibrateCreditPool,
  setCreditPoolWarn,
  addCreditGrant,
} from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  return NextResponse.json({ pools: await evaluateCreditPools() });
}

/** 金額欄位：接受「1,739.16」這種從控制台直接複製來的寫法。 */
function money(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[,\s$NT]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: { id?: number; action?: string; balance?: unknown; warn?: unknown; amount?: unknown; date?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  if (body.action === "calibrate") {
    const balance = money(body.balance);
    if (balance === null || balance < 0) {
      return NextResponse.json({ error: "餘額要是 0 以上的數字" }, { status: 400 });
    }
    const ok = await calibrateCreditPool(id, balance);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "寫入失敗" }, { status: 500 });
  }

  if (body.action === "warn") {
    const warn = money(body.warn);
    if (warn === null || warn < 0) {
      return NextResponse.json({ error: "警示線要是 0 以上的數字" }, { status: 400 });
    }
    const ok = await setCreditPoolWarn(id, warn);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "寫入失敗" }, { status: 500 });
  }

  if (body.action === "grant") {
    const amount = money(body.amount);
    const date = String(body.date ?? "").trim();
    if (amount === null || amount <= 0) {
      return NextResponse.json({ error: "金額要大於 0" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "日期格式是 YYYY-MM-DD" }, { status: 400 });
    }
    const ok = await addCreditGrant(id, date, amount, body.note?.trim() || undefined);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "寫入失敗" }, { status: 500 });
  }

  return NextResponse.json({ error: "action 只能是 calibrate、warn、grant" }, { status: 400 });
}

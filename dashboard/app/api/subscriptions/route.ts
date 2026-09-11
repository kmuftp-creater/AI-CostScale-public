import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listSubscriptions, createSubscription } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  return NextResponse.json({ subscriptions: await listSubscriptions() });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: {
    service?: string;
    plan?: string;
    fee?: number | string;
    currency?: string;
    billingCycle?: string;
    billingDay?: number | string;
    billingMonth?: number | string;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const service = (body.service ?? "").trim();
  const fee = Number(body.fee);
  const day = Number(body.billingDay);
  const currency = (body.currency ?? "USD").trim().toUpperCase();
  const cycle = (body.billingCycle ?? "monthly").trim();

  if (!service) return NextResponse.json({ error: "服務名稱為必填" }, { status: 400 });
  if (cycle !== "monthly" && cycle !== "yearly") {
    return NextResponse.json({ error: "計費週期必須是 monthly 或 yearly" }, { status: 400 });
  }
  if (!Number.isFinite(fee) || fee < 0) {
    return NextResponse.json(
      { error: cycle === "yearly" ? "年費必須是 0 以上的數字" : "月費必須是 0 以上的數字" },
      { status: 400 }
    );
  }
  // 上限 28：29 到 31 號在某些月份不存在，會讓「下次扣款日」算錯。
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    return NextResponse.json({ error: "扣款日必須是 1 到 28 的整數" }, { status: 400 });
  }

  let month: number | null = null;
  if (cycle === "yearly") {
    month = Number(body.billingMonth ?? 1);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: "年繳的扣款月份必須是 1 到 12 的整數" }, { status: 400 });
    }
  }

  const created = await createSubscription({
    service,
    plan: body.plan?.trim() || null,
    fee,
    currency,
    billingCycle: cycle,
    billingDay: day,
    billingMonth: month,
    note: body.note?.trim() || null,
  });
  if (!created) {
    return NextResponse.json({ error: "寫入失敗（資料庫無法連線）" }, { status: 500 });
  }
  return NextResponse.json({ subscription: created });
}

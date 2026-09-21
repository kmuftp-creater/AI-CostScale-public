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
    taxPct?: number | string;
    currency?: string;
    billingCycle?: string;
    billingDay?: number | string;
    billingMonth?: number | string;
    reviewAt?: string;
    overseas?: boolean | null;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const service = (body.service ?? "").trim();
  const fee = Number(body.fee);
  // 稅率是加在未稅牌價上的（db/init/30）。沒送＝0，維持舊行為。
  const taxPct = body.taxPct === undefined || body.taxPct === "" ? 0 : Number(body.taxPct);
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
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct >= 100) {
    return NextResponse.json({ error: "稅率必須是 0 到 99.999 之間的數字" }, { status: 400 });
  }
  // 上限 28：29 到 31 號在某些月份不存在，會讓「下次扣款日」算錯。
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    return NextResponse.json({ error: "扣款日必須是 1 到 28 的整數" }, { status: 400 });
  }

  // 複查日：空字串＝不設。格式錯就擋下來，別讓 Postgres 丟一個看不懂的型別錯。
  const reviewAt = (body.reviewAt ?? "").trim();
  if (reviewAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) {
    return NextResponse.json({ error: "複查日要是 YYYY-MM-DD" }, { status: 400 });
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
    taxPct,
    currency,
    billingCycle: cycle,
    billingDay: day,
    billingMonth: month,
    // 三態：true／false／null（還沒確認）。沒送就交給 db 層依幣別推定。
    overseas: body.overseas === undefined ? undefined : body.overseas,
    reviewAt: reviewAt || null,
    note: body.note?.trim() || null,
  });
  if (!created) {
    return NextResponse.json({ error: "寫入失敗（資料庫無法連線）" }, { status: 500 });
  }
  return NextResponse.json({ subscription: created });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listBudgets, createBudget, evaluateBudgets } from "@/lib/db";
import { monthRange } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  // ?evaluate=1 時附上本期花費與判定結果，供橫幅與告警腳本使用。
  if (request.nextUrl.searchParams.get("evaluate") === "1") {
    const range = monthRange(0);
    return NextResponse.json({
      budgets: await evaluateBudgets(new Date(range.from), new Date(range.to)),
    });
  }
  return NextResponse.json({ budgets: await listBudgets() });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: {
    scope?: string;
    appId?: number | string | null;
    label?: string;
    monthlyLimit?: number | string;
    warnPct?: number | string;
    criticalPct?: number | string;
    includeGcp?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const scope = (body.scope ?? "").trim();
  if (scope !== "global" && scope !== "app") {
    return NextResponse.json({ error: "scope 必須是 global 或 app" }, { status: 400 });
  }

  const limit = Number(body.monthlyLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return NextResponse.json({ error: "月上限必須大於 0" }, { status: 400 });
  }

  const warnPct = Number(body.warnPct ?? 80);
  const criticalPct = Number(body.criticalPct ?? 95);
  for (const [name, v] of [["警示門檻", warnPct], ["嚴重門檻", criticalPct]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 100) {
      return NextResponse.json({ error: `${name}必須是 1 到 100 的整數` }, { status: 400 });
    }
  }
  if (criticalPct <= warnPct) {
    return NextResponse.json(
      { error: "嚴重門檻必須大於警示門檻，否則兩段會互相蓋掉" },
      { status: 400 }
    );
  }

  let appId: number | null = null;
  if (scope === "app") {
    appId = Number(body.appId);
    if (!Number.isInteger(appId) || appId <= 0) {
      return NextResponse.json({ error: "軟體範圍的預算必須指定 appId" }, { status: 400 });
    }
  }

  const created = await createBudget({
    scope,
    appId,
    label: body.label?.trim() || null,
    monthlyLimit: limit,
    warnPct,
    criticalPct,
    includeGcp: body.includeGcp ?? true,
  });
  if (!created) {
    // 唯一索引擋下重複設定時也會走到這裡，訊息要能指出真正原因。
    return NextResponse.json(
      { error: "寫入失敗。可能原因：全域預算已存在、該軟體已有預算、或資料庫無法連線" },
      { status: 400 }
    );
  }
  return NextResponse.json({ budget: created });
}

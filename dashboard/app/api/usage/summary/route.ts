import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getUsageSummary } from "@/lib/db";
import { monthRange } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  const { searchParams } = request.nextUrl;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const range = fromParam && toParam ? { from: fromParam, to: toParam } : monthRange(0);
  const summary = await getUsageSummary(new Date(range.from), new Date(range.to));

  return NextResponse.json({ from: range.from, to: range.to, summary });
}

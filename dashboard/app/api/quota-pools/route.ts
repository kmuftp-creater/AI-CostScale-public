import { listQuotaPoolsLive } from "@/lib/keys";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listQuotaPools } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  return NextResponse.json({ pools: await listQuotaPoolsLive() });
}

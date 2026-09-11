import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getSettings, updateSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;

  const settings = await getSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: { key?: string; value?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  if (!body.key || body.value === undefined) {
    return NextResponse.json({ error: "key 與 value 為必填" }, { status: 400 });
  }

  const ok = await updateSetting(body.key, body.value);
  if (!ok) {
    return NextResponse.json({ error: "寫入失敗（資料庫無法連線）" }, { status: 500 });
  }

  const settings = await getSettings();
  return NextResponse.json({ settings });
}

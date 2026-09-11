import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getAppById, patchApp } from "@/lib/db";
import { deleteVirtualKey, LiteLlmError } from "@/lib/litellm";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/apps/[id]">) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const appId = Number(id);
  if (!Number.isFinite(appId)) {
    return NextResponse.json({ error: "id 必須是數字" }, { status: 400 });
  }

  let body: { name?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  if (body.status && body.status !== "active" && body.status !== "archived") {
    return NextResponse.json({ error: "status 只能是 active 或 archived" }, { status: 400 });
  }

  // 封存時撤銷 LiteLLM 虛擬金鑰。LiteLLM 不可用時仍要容忍：回 503 提示使用者，
  // 不讓資料庫先改了狀態但金鑰其實還活著造成資訊不一致。
  if (body.status === "archived") {
    const existing = await getAppById(appId);
    if (existing?.vkey_id) {
      try {
        await deleteVirtualKey([existing.vkey_id]);
      } catch (err) {
        if (err instanceof LiteLlmError) {
          return NextResponse.json({ error: `撤銷虛擬金鑰失敗，未封存：${err.message}` }, { status: 503 });
        }
        return NextResponse.json({ error: "撤銷虛擬金鑰時發生未預期錯誤，未封存" }, { status: 503 });
      }
    }
  }

  const app = await patchApp(appId, { name: body.name, status: body.status });
  if (!app) {
    return NextResponse.json({ error: "更新失敗（找不到軟體或資料庫無法連線）" }, { status: 404 });
  }

  return NextResponse.json({ app });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getAppForLimit, setAppHardLimitUsd } from "@/lib/db";
import { applyHardLimit } from "@/lib/hard-limit";
import { LiteLlmError } from "@/lib/litellm";

export const dynamic = "force-dynamic";

/**
 * 設定或解除某個軟體的每月硬上限（2026-09-10）。
 *
 * body：`{ "usd": 5 }` 設上限（美元）、`{ "usd": null }` 解除。
 *
 * **只收美元。** 閘道記帳與比對都用美元，台幣是畫面上按當下匯率換算的參考值——
 * 如果這裡收台幣再換算，匯率一動，存進去的上限就不是使用者當初看到的那個數字了。
 * 畫面負責把使用者輸入的台幣換成美元，並把兩個數字都顯示給他確認。
 *
 * 順序是**先改閘道、再改資料庫**：閘道失敗就什麼都不動、回 503；
 * 閘道成功而資料庫失敗時，上限其實已經生效，只是換鑰時不會跟過去——要講出來。
 */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/apps/[id]/hard-limit">) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const appId = Number(id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  let body: { usd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  let usd: number | null;
  if (body.usd === null) {
    usd = null;
  } else {
    const n = Number(body.usd);
    if (!Number.isFinite(n) || n < 0.01 || n > 100_000) {
      return NextResponse.json(
        { error: "上限要是 US$0.01 到 US$100,000 之間的數字。要取消上限請按「解除上限」。" },
        { status: 400 }
      );
    }
    usd = Math.round(n * 10_000) / 10_000;
  }

  const app = await getAppForLimit(appId);
  if (!app) return NextResponse.json({ error: "找不到這個軟體" }, { status: 404 });
  if (app.status !== "active") {
    return NextResponse.json({ error: "這個軟體已封存，金鑰已撤銷，沒有東西可以設上限" }, { status: 400 });
  }
  if (!app.vkey_id) {
    return NextResponse.json({ error: "這個軟體沒有虛擬金鑰" }, { status: 400 });
  }

  let applied;
  try {
    applied = await applyHardLimit({
      vkey: app.vkey_id,
      retiredVkeys: app.retired_vkey_ids,
      usd,
      previousUsd: app.hard_limit_usd,
    });
  } catch (err) {
    const msg = err instanceof LiteLlmError || err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `閘道沒有套用成功：${msg}` }, { status: 503 });
  }

  const saved = await setAppHardLimitUsd(appId, usd);
  return NextResponse.json({
    ok: true,
    usd,
    periodStart: applied.periodStart?.toISOString() ?? null,
    resetAt: applied.resetAt?.toISOString() ?? null,
    seededSpendUsd: applied.seededSpendUsd,
    warning: saved
      ? null
      : "閘道已經套用這個上限，但資料庫沒記到。之後重新簽發這個軟體的金鑰時，上限不會跟到新金鑰上——請再按一次儲存。",
  });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getAppForLimit, getKeyModelSettings, VERTEX_PASSTHROUGH_PATTERN } from "@/lib/db";
import { resolveAllowedBase } from "@/lib/acl";
import { setKeyModelsAndAliases, LiteLlmError, DEFAULT_ALIAS } from "@/lib/litellm";

export const dynamic = "force-dynamic";

/**
 * 設定某個軟體「可以用哪些模型」與「預設模型」（2026-09-21）。
 *
 * body：
 *   { "allowed": ["gemini-fast", "groq-fast"] | null, "defaultModel": "gemini-smart" | null }
 *   allowed = null   → 回到預設：閘道上所有非訂閱模型都放行
 *   defaultModel     → 寫成這把金鑰專屬的別名 `default`，專案送 `default` 就打到它
 *
 * 三件不能省的事：
 *
 * 1. **訂閱通道要原樣留著。** `sub-*` 是逐一授權過的（「訂閱橋接」面板那一關），
 *    這裡重算白名單時若沒把它們帶上，等於默默撤銷授權，那個專案下次打訂閱模型就 403。
 * 2. **Vertex 直通樣式要留著。** 有些軟體開了 `vertex_ai/*`，那是刻意的。
 * 3. **別名本身要列進 models。** LiteLLM 的權限檢查跑在別名解析之前，
 *    只設 aliases 會被自己的白名單擋掉（2026-09-21 實測 403）。
 *
 * 順序是先改閘道、再回報。這裡不寫資料庫：模型設定的真相就在閘道那把金鑰上，
 * 存第二份只會有兩邊不一致的風險（同「重新同步白名單」的設計）。
 */

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/apps/[id]/models">) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const appId = Number(id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  let body: { allowed?: unknown; defaultModel?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const allowedIn =
    body.allowed === null || body.allowed === undefined
      ? null
      : Array.isArray(body.allowed)
        ? body.allowed.map((m) => String(m))
        : undefined;
  if (allowedIn === undefined) {
    return NextResponse.json({ error: "allowed 要是模型名稱陣列，或 null（代表全部放行）" }, { status: 400 });
  }
  const defaultModel =
    body.defaultModel === null || body.defaultModel === undefined ? null : String(body.defaultModel);

  const app = await getAppForLimit(appId);
  if (!app) return NextResponse.json({ error: "找不到這個軟體" }, { status: 404 });
  if (!app.vkey_id) {
    return NextResponse.json({ error: "這個軟體還沒有虛擬金鑰，先簽發一把再設定模型" }, { status: 400 });
  }

  // 閘道現在有哪些非訂閱模型：這是可選範圍，也是驗證輸入的依據
  const base = await resolveAllowedBase({ vertexPassthrough: false });
  const gatewayModels = base.models;

  const nonSub = allowedIn ?? gatewayModels;
  const unknown = nonSub.filter((m) => !gatewayModels.includes(m));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `這些名字不是閘道上的部署名：${unknown.join("、")}。可選的有：${gatewayModels.join("、")}` },
      { status: 400 }
    );
  }
  if (nonSub.length === 0) {
    return NextResponse.json(
      { error: "至少要留一個模型。全部取消勾選等於讓這個軟體打不到任何東西。" },
      { status: 400 }
    );
  }
  if (defaultModel && !nonSub.includes(defaultModel)) {
    return NextResponse.json(
      { error: `預設模型 ${defaultModel} 不在這個軟體的可用清單裡，請先勾選它。` },
      { status: 400 }
    );
  }

  // 原本就有的訂閱通道與 Vertex 直通樣式要原樣帶過去，不能被這次的重算洗掉
  const cur = (await getKeyModelSettings([app.vkey_id]))[app.vkey_id];
  const keep = (cur?.models ?? []).filter(
    (m) => m.startsWith("sub-") || m === VERTEX_PASSTHROUGH_PATTERN
  );

  const models = [...new Set([...nonSub, ...keep, ...(defaultModel ? [DEFAULT_ALIAS] : [])])];
  const aliases: Record<string, string> = defaultModel ? { [DEFAULT_ALIAS]: defaultModel } : {};

  try {
    await setKeyModelsAndAliases({ key: app.vkey_id, models, aliases });
  } catch (err) {
    const detail = err instanceof LiteLlmError ? err.message : String(err);
    return NextResponse.json({ error: `閘道沒有接受這次設定：${detail}` }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    allowed: nonSub,
    defaultModel,
    keptSubModels: keep,
    aliasName: DEFAULT_ALIAS,
    usedFallback: base.usedFallback,
    fallbackReason: base.reason,
  });
}

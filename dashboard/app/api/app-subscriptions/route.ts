import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import {
  listAppSubscriptions,
  setAppSubscriptions,
  patchAppMeta,
  markAclSynced,
  NON_SUB_MODEL_PATTERNS,
} from "@/lib/db";
import { setKeyAllowedModels } from "@/lib/litellm";
import { resolveAllowedBase } from "@/lib/acl";

export const dynamic = "force-dynamic";

// sub-agy-claude（2026-08-29）：Antigravity 訂閱附的 Claude 額度，
// 與 sub-claude（Claude Code 訂閱）是兩個不同的池。
const VALID_SUBS = new Set([
  "sub-claude",
  "sub-codex",
  "sub-gemini",
  "sub-imagegen",
  "sub-agy-claude",
]);

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  return NextResponse.json({ apps: await listAppSubscriptions() });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: {
    appId?: number | string;
    subs?: unknown;
    note?: string | null;
    reviewAt?: string | null;
    boardProjectName?: string | null;
    billingClientIds?: string | string[] | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const appId = Number(body.appId);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "appId 不合法" }, { status: 400 });
  }

  if (
    body.note !== undefined ||
    body.reviewAt !== undefined ||
    body.boardProjectName !== undefined ||
    body.billingClientIds !== undefined
  ) {
    const reviewAt =
      body.reviewAt === undefined
        ? undefined
        : body.reviewAt === null || body.reviewAt === ""
          ? null
          : String(body.reviewAt);
    if (reviewAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) {
      return NextResponse.json({ error: "複查日格式須為 YYYY-MM-DD" }, { status: 400 });
    }
    // 空字串一律存成 NULL：「填了空白」與「沒填」在下游是同一件事，
    // 留著空字串會讓 billing_client_id 去比對到不存在的標籤。
    const blankToNull = (v: string | null | undefined) =>
      v === undefined ? undefined : String(v ?? "").trim() || null;
    await patchAppMeta(appId, {
      note: blankToNull(body.note),
      reviewAt,
      boardProjectName: blankToNull(body.boardProjectName),
      // 介面用逗號分隔輸入（一個軟體可能有多個歷史帳單標籤）。
      // 空字串一律變成空陣列而不是 [""]，否則會去比對一個不存在的標籤。
      billingClientIds:
        body.billingClientIds === undefined
          ? undefined
          : (Array.isArray(body.billingClientIds)
              ? body.billingClientIds
              : String(body.billingClientIds ?? "").split(",")
            )
              .map((v) => v.trim())
              .filter(Boolean),
    });
  }

  // subs 沒帶就只是改備註／複查日，不動允許清單，也不必重新同步閘道。
  if (body.subs === undefined) {
    return NextResponse.json({ apps: await listAppSubscriptions() });
  }

  if (!Array.isArray(body.subs)) {
    return NextResponse.json({ error: "subs 必須是陣列" }, { status: 400 });
  }
  const subs = [...new Set(body.subs.map(String))];
  const bad = subs.filter((s) => !VALID_SUBS.has(s));
  if (bad.length) {
    return NextResponse.json(
      { error: `不認得的訂閱模型：${bad.join("、")}` },
      { status: 400 }
    );
  }

  if (!(await setAppSubscriptions(appId, subs))) {
    return NextResponse.json({ error: "寫入失敗" }, { status: 500 });
  }

  // 寫進資料庫只是「意圖」，真正擋人的是閘道的金鑰白名單。
  // 推送失敗要明確回報——「設定看起來對但實際沒生效」是最危險的狀態。
  const apps = await listAppSubscriptions();
  const app = apps.find((a) => a.id === appId);
  if (!app?.vkey_id) {
    await markAclSynced(appId, "這個軟體沒有虛擬金鑰，無法推送到閘道");
    return NextResponse.json({
      apps: await listAppSubscriptions(),
      warning: "設定已儲存，但該軟體沒有虛擬金鑰，閘道端未生效",
    });
  }

  try {
    // 白名單的基底改由閘道實際部署名決定（2026-08-26），
    // 三個呼叫點共用 resolveAllowedBase，避免各自算出不同的清單。
    const base = await resolveAllowedBase({ vertexPassthrough: app.vertex_passthrough });
    await setKeyAllowedModels({
      key: app.vkey_id,
      nonSubPatterns: base.models,
      subModels: subs,
    });
    await markAclSynced(appId, base.usedFallback ? `已推送，但用的是退路清單：${base.reason}` : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markAclSynced(appId, msg);
    return NextResponse.json(
      { apps: await listAppSubscriptions(), warning: `設定已儲存，但推送到閘道失敗：${msg}` },
      { status: 200 }
    );
  }

  return NextResponse.json({ apps: await listAppSubscriptions() });
}

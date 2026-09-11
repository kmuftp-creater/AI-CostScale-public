import { NextRequest, NextResponse } from "next/server";
import { upsertCliSessions, type CliSessionInput } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 訂閱制 CLI 的逐 session 用量回報（2026-08-23，D-2）。
 *
 * 為什麼不是走 /api/otel：Codex 的 OTLP 匯出裡沒有 token（實測，見 /telemetry 頁），
 * 只能由家用主機的排程讀 ~/.codex/sessions 的 rollout 檔再送上來。
 * 那些數字是「累計值」，語意與 OTLP 的增量相反，所以另開端點與另一張表。
 *
 * 認證沿用 OTEL_INGEST_TOKEN——與遙測同性質、同信任邊界，
 * 不要為了一個端點再發一把 token 讓家用主機多存一份秘密。
 * 未設定時回 503 停用，不要因為「還沒設定」就變成公開的寫入端點。
 */

const MAX_SESSIONS = 500;

function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.OTEL_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "伺服器未設定 OTEL_INGEST_TOKEN，CLI 用量回報停用中" },
      { status: 503 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expected) return NextResponse.json({ error: "token 不正確" }, { status: 401 });
  return null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function optStr(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** ISO 時間字串；不合法就回 null，讓呼叫端決定要不要整筆丟掉。 */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function POST(request: NextRequest) {
  const guard = authorize(request);
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const source = optStr(body.source, 40);
  if (!source) return NextResponse.json({ error: "缺少 source" }, { status: 400 });
  const host = optStr(body.host, 100);

  const raw = Array.isArray(body.sessions) ? body.sessions : null;
  if (!raw) return NextResponse.json({ error: "sessions 必須是陣列" }, { status: 400 });
  if (raw.length > MAX_SESSIONS) {
    return NextResponse.json(
      { error: `一次最多 ${MAX_SESSIONS} 筆，收到 ${raw.length} 筆` },
      { status: 400 }
    );
  }

  const sessions: CliSessionInput[] = [];
  const skipped: string[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const sessionId = optStr(o.sessionId, 100);
    const startedAt = isoOrNull(o.startedAt);
    const lastEventAt = isoOrNull(o.lastEventAt);
    // 三個必要欄位缺一就跳過這一筆，但不要讓整批失敗——
    // 家用主機那邊一次送幾十個 session，一個壞掉的檔不該拖垮其餘。
    if (!sessionId || !startedAt || !lastEventAt) {
      skipped.push(sessionId ?? "(無 sessionId)");
      continue;
    }
    sessions.push({
      sessionId,
      model: optStr(o.model, 80),
      startedAt,
      lastEventAt,
      inputTokens: num(o.inputTokens),
      cachedInputTokens: num(o.cachedInputTokens),
      cacheWriteTokens: num(o.cacheWriteTokens),
      // 寫入總數裡屬於 1 小時快取的部分（2026-09-10）。夾在總數以內：
      // 子集合比總數大只可能是送錯，按總數截斷比讓 5 分鐘那一段變成負的好。
      cacheWrite1hTokens: Math.min(num(o.cacheWrite1hTokens), num(o.cacheWriteTokens)),
      outputTokens: num(o.outputTokens),
      reasoningTokens: num(o.reasoningTokens),
      totalTokens: num(o.totalTokens),
      originator: optStr(o.originator, 80),
      threadSource: optStr(o.threadSource, 40),
      quotaUsedPct: optNum(o.quotaUsedPct),
      quotaWindowMinutes: optNum(o.quotaWindowMinutes),
      quotaResetsAt: isoOrNull(o.quotaResetsAt),
      planType: optStr(o.planType, 40),
    });
  }

  const { written, error } = await upsertCliSessions(source, host, sessions);
  if (error) {
    return NextResponse.json({ error: `寫入失敗：${error}` }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    received: raw.length,
    written,
    skipped: skipped.length,
    skippedIds: skipped.slice(0, 10),
  });
}

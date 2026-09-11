import { NextRequest, NextResponse } from "next/server";
import { insertOtelUsage } from "@/lib/db";

export const dynamic = "force-dynamic";

// OTLP HTTP/JSON 的 resourceMetrics 結構，只取用得到的欄位，其餘一律進 raw_attrs。
type OtlpAttr = { key: string; value?: { stringValue?: string; intValue?: string; doubleValue?: number } };
type OtlpDataPoint = { attributes?: OtlpAttr[]; asInt?: string | number; asDouble?: number };
type OtlpMetric = { name?: string; sum?: { dataPoints?: OtlpDataPoint[] }; gauge?: { dataPoints?: OtlpDataPoint[] } };
type OtlpScopeMetric = { metrics?: OtlpMetric[] };
type OtlpResourceMetric = {
  resource?: { attributes?: OtlpAttr[] };
  scopeMetrics?: OtlpScopeMetric[];
};
type OtlpPayload = { resourceMetrics?: OtlpResourceMetric[] };

function attrString(attrs: OtlpAttr[] | undefined, key: string): string | undefined {
  return attrs?.find((a) => a.key === key)?.value?.stringValue;
}

function dataPointValue(dp: OtlpDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt) || 0;
  if (dp.asDouble !== undefined) return Number(dp.asDouble) || 0;
  return 0;
}

function normalizeSource(raw: string | undefined): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("claude")) return "claude-code";
  if (s.includes("codex")) return "codex-cli";
  if (s.includes("gemini")) return "gemini-cli";
  return raw || "unknown";
}

function bucketFor(typeAttr: string | undefined): "input" | "output" | "cache_read" | "cache_write" | "reasoning" | null {
  const t = (typeAttr || "").toLowerCase();
  // Claude Code 送的是 cacheCreation，不是 cacheWrite。
  // 初版只比對 "write"，於是快取建立的 token 兩個分支都不中，被無聲丟棄——
  // 症狀是 cache_read 有 8000 萬、cache_write 卻是 0，而讀不可能沒有寫
  // （2026-08-20 實測抓到）。各家 CLI 的用字不同，這裡一次涵蓋。
  if (t.includes("cache")) {
    if (t.includes("read") || t.includes("hit")) return "cache_read";
    if (t.includes("write") || t.includes("creat")) return "cache_write";
    // 只寫 cache 沒說讀寫時，當成讀——那是常態，寫入才是特例。
    return "cache_read";
  }
  if (t.includes("reason") || t.includes("think")) return "reasoning";
  if (t.includes("output") || t.includes("completion")) return "output";
  if (t.includes("input") || t.includes("prompt")) return "input";
  return null;
}

/**
 * OTLP 接收端的驗證。
 *
 * 這支端點對外開放且會寫資料庫，沒有 Google 登入可用（CLI 沒有 session）。
 * 初版完全不驗證，任何人知道網址就能灌資料進 otel_usage（2026-08-20 實測確認）。
 *
 * 與 /api/budgets/check 一致：未設定 token 時回 503 停用，
 * 不要因為「還沒設定」就變成公開端點。
 */
function authorizeIngest(request: NextRequest): NextResponse | null {
  const expected = process.env.OTEL_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "伺服器未設定 OTEL_INGEST_TOKEN，遙測接收停用中" },
      { status: 503 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expected) {
    return NextResponse.json({ error: "token 不正確" }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const guard = authorizeIngest(request);
  if (guard) return guard;

  let body: OtlpPayload | null = null;
  let rawText = "";
  try {
    rawText = await request.text();
    body = rawText ? (JSON.parse(rawText) as OtlpPayload) : null;
  } catch {
    // 不是合法 JSON：整包當 raw_attrs 存一筆，來源標 unknown。
    const ok = await insertOtelUsage({
      source: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      rawAttrs: { parseError: "invalid json", raw: rawText.slice(0, 5000) },
    });
    return NextResponse.json({ received: true, parsed: false }, { status: ok ? 200 : 500 });
  }

  const resourceMetrics = body?.resourceMetrics ?? [];

  if (resourceMetrics.length === 0) {
    const ok = await insertOtelUsage({
      source: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      rawAttrs: body ?? {},
    });
    return NextResponse.json({ received: true, parsed: false }, { status: ok ? 200 : 500 });
  }

  let anySucceeded = false;
  let allAttempted = 0;

  for (const rm of resourceMetrics) {
    const source = normalizeSource(attrString(rm.resource?.attributes, "service.name"));
    let model: string | undefined;
    const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
    let matchedAny = false;

    for (const scope of rm.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        for (const dp of dataPoints) {
          if (!model) model = attrString(dp.attributes, "model") ?? attrString(dp.attributes, "gen_ai.request.model");
          const typeAttr = attrString(dp.attributes, "type") ?? attrString(dp.attributes, "token_type");
          const bucket = bucketFor(typeAttr) ?? bucketFor(metric.name);
          if (bucket) {
            totals[bucket] += dataPointValue(dp);
            matchedAny = true;
          }
        }
      }
    }

    allAttempted += 1;
    const ok = await insertOtelUsage({
      source,
      model: model ?? null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheRead: totals.cache_read,
      cacheWrite: totals.cache_write,
      reasoning: totals.reasoning,
      rawAttrs: matchedAny ? undefined : rm,
    });
    if (ok) anySucceeded = true;
  }

  if (!anySucceeded && allAttempted > 0) {
    return NextResponse.json({ received: true, parsed: true, stored: false }, { status: 500 });
  }

  return NextResponse.json({ received: true, parsed: true, stored: true });
}

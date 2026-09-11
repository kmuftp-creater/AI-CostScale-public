import {
  getPool,
  listApps,
  listQuotaPools,
  getFxRate,
  getSubscriptionSavings,
  listRecentAlerts,
} from "@/lib/db";
import { getKeyInventory, applyActualKeyCounts } from "@/lib/keys";
import { resolveRange } from "@/lib/range";

/**
 * 營運大屏的資料（2026-09-12）。
 *
 * 一次查齊，交給 app/bigscreen 的 client 元件畫。每一段各自 try/catch：
 * 大屏是掛在牆上看的，**任何一塊讀不到都不能讓整頁掛掉**，
 * 但讀不到要寫進 problems 顯示在畫面上，不能靜靜空著。
 *
 * 時間邊界：
 *   - 「本月」照全站慣例（lib/range.ts）。2026-09-12 起是**台北月份**，
 *     跟總覽頁、每月硬上限（閘道 timezone: Asia/Taipei）對得起來。
 *   - 「每日」「今日每小時」用**台北時間**分桶：那兩張圖是給人看時段的。
 *   - LiteLLM 的 startTime 是不帶時區的 timestamp、內容是 UTC；
 *     傳 ISO 字串進去時 Postgres 會忽略結尾的 Z，照 UTC 牆上時間比對，跟既有查詢一致。
 */

const DAY_MS = 86_400_000;
const TPE_MS = 8 * 3_600_000;

/**
 * 軟體的顏色：6 色，2026-09-11 用 dataviz 驗證器在 #06173f 底上跑過
 * （亮度帶、彩度、色弱相鄰分辨、一般視覺分辨、對比全部 PASS）。
 * **依建立順序固定分配，不照排名**——排名每天在變，顏色跟著變的話同一個軟體會換色。
 * ops-manual 是我們自己的測試金鑰，固定灰色；第 7 個之後也歸灰色。
 */
const APP_PALETTE = ["#179eb7", "#de6506", "#05a869", "#4b88fd", "#e15093", "#af8809"];
const GRAY = "#56699a";
const UNATTRIBUTED = "未歸戶";
const FAILED = "未完成（失敗）";
const OTHER = "其他";

export type BigScreenData = {
  generatedAt: string;
  gateway: { ok: boolean; detail: string };
  fx: { rate: number; day: string | null; stale: boolean };
  month: { spendUsd: number; calls: number; tokens: number; failed: number };
  daily: { day: string; usd: number; calls: number }[];
  /** 近 24 小時的最後一個小時（台北，例如 09/12 01:00）。 */
  hourlyThrough: string;
  hourly: { label: string; tip: string; calls: number }[];
  apps: { name: string; color: string; calls: number; spendUsd: number; tokens: number; idle: boolean }[];
  models: { name: string; calls: number; spendUsd: number; kind: "model" | "fail" | "other" }[];
  pools: { name: string; used: number; failed: number; limit: number | null; keys: number; auto: boolean }[];
  savings: { rows: { provider: string; apiTwd: number; feeTwd: number; noData: string | null; tokens: number }[]; apiTwd: number; feeTwd: number };
  events: { at: string; level: "info" | "warn" | "crit" | "good"; text: string }[];
  problems: string[];
};

function taipeiDayStartUtc(now: Date): Date {
  return new Date(Math.floor((now.getTime() + TPE_MS) / DAY_MS) * DAY_MS - TPE_MS);
}

async function gatewayHealth(): Promise<{ ok: boolean; detail: string }> {
  const base = process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${base}/health/liveliness`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const body = await res.text();
    // 只看狀態碼不夠：佔著那個埠的若是別的服務，一樣回 200（L-212，2026-09-10 實際踩過）。
    if (res.ok && body.toLowerCase().includes("alive")) return { ok: true, detail: "正常" };
    return { ok: false, detail: `回應不對（HTTP ${res.status}）` };
  } catch (e) {
    return { ok: false, detail: `連不到：${e instanceof Error ? e.message.slice(0, 40) : String(e)}` };
  }
}

/** 失敗原因翻成人話。錯誤訊息裡夾帶的金鑰片段一律遮掉，不上大屏。 */
function describeFailure(code: string | null, cls: string | null, msg: string | null): { level: "warn" | "crit"; text: string } {
  const m = (msg ?? "").replace(/(sk-|AIza|AQ\.)[A-Za-z0-9_*.\-]+/g, "〔金鑰〕");
  if (/budget has been exceeded/i.test(m) || /budget/i.test(cls ?? "")) return { level: "crit", text: "超過每月上限，閘道拒絕（429）" };
  if (/Claude 訂閱額度/.test(m)) return { level: "warn", text: "Claude 訂閱額度到頂或低於保留量，橋接擋下" };
  if (/Malformed API Key/i.test(m)) return { level: "crit", text: "金鑰格式錯誤（少了 Bearer 前綴）" };
  if (/Virtual Key expected/i.test(m)) return { level: "crit", text: "拿上游金鑰直接打閘道，應改用虛擬金鑰（401）" };
  if (code === "429") return { level: "warn", text: /gemini/i.test(m) ? "Gemini 上游限流（429）" : "上游限流（429）" };
  if (code === "401") return { level: "crit", text: "驗證失敗（401）" };
  if (code && Number(code) >= 500) return { level: "warn", text: `上游錯誤（${code}）` };
  return { level: "warn", text: m.slice(0, 40) || "失敗（沒有錯誤訊息）" };
}

export async function getBigScreenData(): Promise<BigScreenData> {
  const problems: string[] = [];
  const now = new Date();
  const thisMonth = resolveRange({});
  const monthStart = new Date(thisMonth.from);
  const monthEnd = new Date(thisMonth.to);
  const todayStart = taipeiDayStartUtc(now);
  const dailyStart = new Date(todayStart.getTime() - 29 * DAY_MS);
  const client = getPool();

  const [gateway, fxRate, apps, poolsRaw, inventory, alerts] = await Promise.all([
    gatewayHealth(),
    getFxRate(),
    listApps(),
    listQuotaPools(),
    getKeyInventory().catch(() => null),
    listRecentAlerts(5).catch(() => []),
  ]);

  // api_key → 軟體名。舊金鑰（換過鑰的）也要對得回去，否則那些花費會跑進「未歸戶」。
  const keyToApp = new Map<string, string>();
  for (const a of apps) {
    if (a.vkey_id) keyToApp.set(a.vkey_id, a.name);
    for (const k of a.retired_vkey_ids ?? []) keyToApp.set(k, a.name);
  }
  const activeApps = apps.filter((a) => a.status === "active").sort((a, b) => a.id - b.id);
  const colorOf = new Map<string, string>();
  let slot = 0;
  for (const a of activeApps) {
    if (a.name === "ops-manual" || slot >= APP_PALETTE.length) colorOf.set(a.name, GRAY);
    else colorOf.set(a.name, APP_PALETTE[slot++]);
  }

  // ── 本月總量 ──
  let month = { spendUsd: 0, calls: 0, tokens: 0, failed: 0 };
  try {
    const r = await client.query(
      `SELECT COALESCE(sum(spend),0)::float8 AS s, count(*)::int AS n,
              COALESCE(sum(total_tokens),0)::bigint AS t,
              count(*) FILTER (WHERE status <> 'success')::int AS f
         FROM "LiteLLM_SpendLogs" WHERE "startTime" >= $1 AND "startTime" < $2`,
      [monthStart.toISOString(), monthEnd.toISOString()]
    );
    const x = r.rows[0];
    month = { spendUsd: Number(x.s), calls: Number(x.n), tokens: Number(x.t), failed: Number(x.f) };
  } catch (e) {
    problems.push("本月總量讀不到");
    console.warn("[bigscreen] month", e);
  }

  // ── 每日（台北日，近 30 天，沒有呼叫的日子補 0）──
  const daily: BigScreenData["daily"] = [];
  try {
    const r = await client.query(
      `SELECT to_char((("startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Taipei')::date, 'YYYY-MM-DD') AS d,
              COALESCE(sum(spend),0)::float8 AS s, count(*)::int AS n
         FROM "LiteLLM_SpendLogs" WHERE "startTime" >= $1 GROUP BY 1`,
      [dailyStart.toISOString()]
    );
    const byDay = new Map(r.rows.map((x) => [String(x.d), { s: Number(x.s), n: Number(x.n) }]));
    for (let i = 0; i < 30; i++) {
      const d = new Date(dailyStart.getTime() + i * DAY_MS + TPE_MS).toISOString().slice(0, 10);
      const v = byDay.get(d);
      daily.push({ day: d.slice(5).replace("-", "/"), usd: v?.s ?? 0, calls: v?.n ?? 0 });
    }
  } catch (e) {
    problems.push("每日花費讀不到");
    console.warn("[bigscreen] daily", e);
  }

  // ── 近 24 小時每小時（台北）──
  // 2026-09-12 以前是「今日」，午夜一過就歸零——User：「今日每小時呼叫一直都沒有出現任何內容」，
  // 實查當時台北 01:12、今天只有 1 次呼叫。改成往回滾 24 小時，任何時候打開都有內容。
  const HOUR_MS = 3_600_000;
  const hourStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - 23 * HOUR_MS);
  const hourly: BigScreenData["hourly"] = [];
  const byHour = new Map<string, number>();
  try {
    const r = await client.query(
      `SELECT to_char(date_trunc('hour', "startTime"), 'YYYY-MM-DD"T"HH24') AS h, count(*)::int AS n
         FROM "LiteLLM_SpendLogs" WHERE "startTime" >= $1 GROUP BY 1`,
      [hourStart.toISOString()]
    );
    for (const x of r.rows) byHour.set(String(x.h), Number(x.n));
  } catch (e) {
    problems.push("近 24 小時讀不到");
    console.warn("[bigscreen] hourly", e);
  }
  for (let i = 0; i < 24; i++) {
    const t = new Date(hourStart.getTime() + i * HOUR_MS);
    const tp = new Date(t.getTime() + TPE_MS).toISOString();
    const hh = tp.slice(11, 13);
    const next = String((Number(hh) + 1) % 24).padStart(2, "0");
    hourly.push({
      // 跨日的那一格改寫日期，看得出哪邊是昨天、哪邊是今天
      label: hh === "00" ? tp.slice(5, 10).replace("-", "/") : hh,
      tip: `${tp.slice(5, 10).replace("-", "/")} ${hh}:00–${next}:00`,
      calls: byHour.get(t.toISOString().slice(0, 13)) ?? 0,
    });
  }
  const lastTp = new Date(hourStart.getTime() + 23 * HOUR_MS + TPE_MS).toISOString();
  const hourlyThrough = `${lastTp.slice(5, 10).replace("-", "/")} ${lastTp.slice(11, 13)}:00`;

  // ── 本月流向：軟體 × 模型 ──
  const appAgg = new Map<string, { calls: number; spend: number; tokens: number }>();
  const modelAgg = new Map<string, { calls: number; spend: number }>();
  try {
    const r = await client.query(
      `SELECT api_key,
              CASE WHEN status <> 'success' THEN $3 ELSE COALESCE(NULLIF(model_group,''), $4) END AS mg,
              count(*)::int AS n, COALESCE(sum(spend),0)::float8 AS s, COALESCE(sum(total_tokens),0)::bigint AS t
         FROM "LiteLLM_SpendLogs" WHERE "startTime" >= $1 AND "startTime" < $2 GROUP BY 1, 2`,
      [monthStart.toISOString(), monthEnd.toISOString(), FAILED, OTHER]
    );
    for (const x of r.rows) {
      const app = (x.api_key && keyToApp.get(String(x.api_key))) || UNATTRIBUTED;
      const a = appAgg.get(app) ?? { calls: 0, spend: 0, tokens: 0 };
      a.calls += Number(x.n); a.spend += Number(x.s); a.tokens += Number(x.t);
      appAgg.set(app, a);
      const m = modelAgg.get(String(x.mg)) ?? { calls: 0, spend: 0 };
      m.calls += Number(x.n); m.spend += Number(x.s);
      modelAgg.set(String(x.mg), m);
    }
  } catch (e) {
    problems.push("軟體與模型流向讀不到");
    console.warn("[bigscreen] flows", e);
  }

  const appsOut: BigScreenData["apps"] = activeApps.map((a) => {
    const v = appAgg.get(a.name) ?? { calls: 0, spend: 0, tokens: 0 };
    return { name: a.name, color: colorOf.get(a.name) ?? GRAY, calls: v.calls, spendUsd: v.spend, tokens: v.tokens, idle: v.calls === 0 };
  });
  // 已封存但本月還有流量的，以及對不回任何軟體的，也要列出來——不列就等於數字被靜靜吃掉
  for (const [name, v] of appAgg) {
    if (appsOut.some((a) => a.name === name)) continue;
    appsOut.push({ name, color: GRAY, calls: v.calls, spendUsd: v.spend, tokens: v.tokens, idle: false });
  }
  appsOut.sort((a, b) => b.calls - a.calls);

  // 模型：流量前四名各自列出（冰藍色階），失敗單獨一類，其餘併成「其他」
  const ranked = [...modelAgg.entries()].filter(([n]) => n !== FAILED && n !== OTHER).sort((a, b) => b[1].calls - a[1].calls);
  const modelsOut: BigScreenData["models"] = ranked.slice(0, 4).map(([name, v]) => ({ name, calls: v.calls, spendUsd: v.spend, kind: "model" as const }));
  const fail = modelAgg.get(FAILED);
  if (fail) modelsOut.push({ name: FAILED, calls: fail.calls, spendUsd: fail.spend, kind: "fail" });
  const rest = ranked.slice(4).reduce((s, [, v]) => ({ calls: s.calls + v.calls, spend: s.spend + v.spend }), { calls: modelAgg.get(OTHER)?.calls ?? 0, spend: modelAgg.get(OTHER)?.spend ?? 0 });
  if (rest.calls > 0) modelsOut.push({ name: OTHER, calls: rest.calls, spendUsd: rest.spend, kind: "other" });

  // ── 免費額度：把數跟著閘道設定走（2026-09-12 User：「應該是會隨著金鑰變動，而不是固定的」）──
  const pools: BigScreenData["pools"] = applyActualKeyCounts(poolsRaw, inventory)
    .filter((p) => p.enabled)
    .map((p) => ({
      name: p.model_name,
      used: p.usedRequests,
      failed: p.failedRequests,
      limit: p.poolLimitRpd,
      keys: p.key_count,
      auto: p.keyCountSource === "gateway",
    }));
  if (!inventory || inventory.configError) problems.push("金鑰盤點讀不到，免費額度暫用手填的把數");

  // ── 訂閱省下多少（與總覽頁同一支函式、同一個本月區間）──
  let savings: BigScreenData["savings"] = { rows: [], apiTwd: 0, feeTwd: 0 };
  try {
    const rows = await getSubscriptionSavings(monthStart, monthEnd, fxRate.rate);
    savings = {
      rows: rows.map((s) => ({ provider: s.provider, apiTwd: s.apiTwd, feeTwd: s.feeTwd, noData: s.noDataReason, tokens: s.tokens })),
      apiTwd: rows.reduce((n, s) => n + s.apiTwd, 0),
      feeTwd: rows.reduce((n, s) => n + s.feeTwd, 0),
    };
  } catch (e) {
    problems.push("訂閱省下多少讀不到");
    console.warn("[bigscreen] savings", e);
  }

  // ── 最近異常：失敗的請求＋預算告警，依時間排 ──
  const events: BigScreenData["events"] = [];
  try {
    const r = await client.query(
      `SELECT ("startTime" AT TIME ZONE 'UTC') AS at, api_key, NULLIF(model_group,'') AS mg,
              metadata->'error_information'->>'error_code' AS code,
              metadata->'error_information'->>'error_class' AS cls,
              metadata->'error_information'->>'error_message' AS msg
         FROM "LiteLLM_SpendLogs" WHERE status <> 'success' ORDER BY "startTime" DESC LIMIT 40`
    );
    for (const x of r.rows) {
      const d = describeFailure(x.code, x.cls, x.msg);
      const who = (x.api_key && keyToApp.get(String(x.api_key))) || UNATTRIBUTED;
      events.push({ at: new Date(x.at).toISOString(), level: d.level, text: `${who}${x.mg ? ` · ${x.mg}` : ""}：${d.text}` });
    }
  } catch (e) {
    problems.push("失敗紀錄讀不到");
    console.warn("[bigscreen] failures", e);
  }
  for (const a of alerts) {
    events.push({
      at: new Date(a.fired_at).toISOString(),
      level: a.level === "warn" ? "warn" : "crit",
      text: `預算告警：${a.app_name ?? "全站"}${a.label ? `（${a.label}）` : ""} 已用 ${Math.round(a.pct)}%`,
    });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  // 同一分鐘、同一件事合併成一條並標次數——2026-09-12 大屏上「未歸戶：金鑰格式錯誤」
  // 同一分鐘連列好幾條，把其他事件擠出畫面。
  const collapsed: BigScreenData["events"] = [];
  const counts: number[] = [];
  for (const e of events) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.text === e.text && last.at.slice(0, 16) === e.at.slice(0, 16)) {
      counts[counts.length - 1]++;
    } else {
      collapsed.push({ ...e });
      counts.push(1);
    }
  }
  collapsed.forEach((e, i) => { if (counts[i] > 1) e.text += ` ×${counts[i]}`; });

  return {
    generatedAt: now.toISOString(),
    gateway,
    fx: { rate: fxRate.rate, day: fxRate.day, stale: fxRate.stale },
    month,
    daily,
    hourlyThrough,
    hourly,
    apps: appsOut,
    models: modelsOut,
    pools,
    savings,
    events: collapsed.slice(0, 12),
    problems,
  };
}

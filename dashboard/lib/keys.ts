import { listQuotaPools, type QuotaPoolStatus } from "@/lib/db";
/**
 * 上游金鑰盤點（D-1 金鑰管理頁的資料來源）。
 *
 * 為什麼要用「解析 litellm-config.yaml ＋ 現場問閘道」兩邊對照，
 * 而不是任何一邊單獨來源：
 *
 *   - 閘道的 /model/info **刻意不外露 api_key**，所以只問閘道，
 *     拿得到部署 id 卻對不回「這是 .env 裡的哪一把」。
 *   - 只讀 yaml 則會說謊：yaml 寫了不代表閘道真的載入
 *     （設計原則第 7 條：手寫的靜態模型清單會說謊）。
 *
 * 對照方法：同一個 model_name 底下，yaml 的第 N 筆對應 /model/info 的第 N 筆。
 * 這個順序假設**已實證**（2026-08-23）：在閘道容器內用 LiteLLM 自己的
 * _generate_model_id 演算法（sha256(model_group + 逐一串接 litellm_params 的鍵值)）
 * 重算 gemini-flash-free 五把金鑰的部署 id，五個雜湊與 /model/info 回的五個 id
 * 依序完全吻合：GEMINI_FREE_KEY_1→d234c0f9…、2→f2a1e685…、3→aaa6fbe8…、
 * 4→225a7347…、5→584abcd2…。所以 yaml 順序＝閘道載入順序。
 *
 * 對不上的時候（yaml 有 3 筆、閘道只有 2 筆）不猜，標成「閘道未載入」讓人看見。
 *
 * 金鑰值本身永遠不會出現在這裡——只讀環境變數的「名字」。
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { getPool } from "@/lib/db";

const CONFIG_CANDIDATES = [
  process.env.LITELLM_CONFIG_PATH,
  "/app/litellm-config.yaml",
  "../litellm-config.yaml",
].filter((p): p is string => !!p);

const LITELLM_URL = process.env.LITELLM_BASE_URL || "http://litellm:4000";

/** 主機端寫的尾碼表。讀不到就當成沒有，不要讓整頁掛掉。 */
const TAILS_PATH = process.env.UPSTREAM_KEY_SPOOL
  ? `${process.env.UPSTREAM_KEY_SPOOL}/_tails.json`
  : "/app/spool/upstream-keys/_tails.json";

async function readTails(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(TAILS_PATH, "utf8");
    const d = JSON.parse(raw) as { tails?: Record<string, string> };
    return d.tails ?? {};
  } catch {
    return {};
  }
}

export type PricingType = "free" | "payg" | "subscription" | "unknown";

/** 憑證的種類。橋接 token 與服務帳戶不是供應商金鑰，介面要分開講。 */
export type CredentialKind = "provider" | "bridge" | "service-account";

export type KeyDeployment = {
  modelName: string;
  backendModel: string;
  /** 閘道上的部署 id。null＝yaml 有寫但閘道沒載入。 */
  deploymentId: string | null;
};

export type DeploymentUsage = {
  todayCalls: number;
  todayTokens: number;
  todaySpend: number;
  totalCalls: number;
  totalFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
};

export const EMPTY_USAGE: DeploymentUsage = {
  todayCalls: 0,
  todayTokens: 0,
  todaySpend: 0,
  totalCalls: 0,
  totalFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
};

export type UpstreamKeyRow = {
  /** .env 裡的變數名，例如 GEMINI_FREE_KEY_1。這不是機密。 */
  envName: string;
  provider: string;
  pricing: PricingType;
  kind: CredentialKind;
  deployments: KeyDeployment[];
  /**
   * 金鑰值的**尾 4 碼**。null＝拿不到。
   *
   * 為什麼要有：儀表板刻意沒有掛 `.env`，所以只知道變數名。
   * 但要去供應商後台停用一把，人認的是尾碼不是變數名——
   * User 2026-09-07 的原話：「每一組金鑰都沒有出現尾碼，也不知道哪支是哪支，
   * 他說失敗我也沒辦法知道要換哪支」。
   *
   * 來源是主機端 apply-upstream-key.py 每分鐘寫的 `_tails.json`（只有尾 4 碼）。
   * 完整金鑰值仍然一個位元組都不會到瀏覽器。
   */
  tail: string | null;
  /** 同池第幾把（依 yaml 順序），單把的池為 null。 */
  slot: number | null;
  poolSize: number;
  usage: DeploymentUsage;
};

export type KeyInventory = {
  ok: boolean;
  /** yaml 讀不到、或閘道問不到時的原因。兩者都各自降級，不整頁爆掉。 */
  configError: string | null;
  gatewayError: string | null;
  keys: UpstreamKeyRow[];
  /** yaml 寫了但閘道沒載入的部署數。>0 代表設定檔與線上不一致，要當成警訊。 */
  unloaded: number;
  totalDeployments: number;
  checkedAt: Date;
};

// ── yaml ────────────────────────────────────────────────────────────

type ConfigEntry = {
  modelName: string;
  backendModel: string;
  envName: string | null;
  pricing: PricingType;
  isWildcard: boolean;
};

function pricingOf(v: unknown): PricingType {
  return v === "free" || v === "payg" || v === "subscription" ? v : "unknown";
}

/** 從 litellm_params.model 的前綴判供應商。前綴就是 LiteLLM 自己的分類法。 */
export function providerOfModel(backendModel: string, apiBase?: string): string {
  const m = backendModel;
  if (m.startsWith("vertex_ai/")) return "Vertex AI";
  if (m.startsWith("gemini/")) return "Google AI Studio";
  if (m.startsWith("openrouter/")) return "OpenRouter";
  if (m.startsWith("groq/")) return "Groq";
  if (m.startsWith("anthropic/")) return "Anthropic";
  if (m.startsWith("openai/") && apiBase && apiBase.includes("8788")) return "訂閱橋接";
  if (m.startsWith("openai/")) return "OpenAI";
  if (m.startsWith("xai/")) return "xAI";
  if (m.startsWith("deepseek/")) return "DeepSeek";
  return m.split("/")[0] || "其他";
}

async function readConfig(): Promise<{ entries: ConfigEntry[]; error: string | null }> {
  const tried: string[] = [];
  for (const path of CONFIG_CANDIDATES) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      tried.push(path);
      continue;
    }
    try {
      const doc = parseYaml(text) as { model_list?: unknown[] };
      const list = Array.isArray(doc?.model_list) ? doc.model_list : [];
      const entries: ConfigEntry[] = [];
      for (const raw of list) {
        const o = raw as Record<string, unknown>;
        const modelName = typeof o.model_name === "string" ? o.model_name : "";
        if (!modelName) continue;
        const params = (o.litellm_params ?? {}) as Record<string, unknown>;
        const info = (o.model_info ?? {}) as Record<string, unknown>;
        const backendModel = typeof params.model === "string" ? params.model : "";
        const apiKey = typeof params.api_key === "string" ? params.api_key : "";
        const envName = apiKey.startsWith("os.environ/") ? apiKey.slice("os.environ/".length) : null;
        entries.push({
          modelName,
          backendModel,
          envName,
          pricing: pricingOf(info.pricing_type),
          isWildcard: modelName.includes("*") || backendModel.includes("*"),
        });
      }
      return { entries, error: null };
    } catch (err) {
      return { entries: [], error: `${path} 解析失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { entries: [], error: `找不到 litellm-config.yaml（試過 ${tried.join("、")}）` };
}

// ── 閘道現場 ─────────────────────────────────────────────────────────

type LiveDeployment = { modelName: string; backendModel: string; apiBase: string; id: string };

async function readGateway(): Promise<{ live: LiveDeployment[]; error: string | null }> {
  const key = process.env.LITELLM_MASTER_KEY || "";
  if (!key) return { live: [], error: "伺服器未設定 LITELLM_MASTER_KEY" };
  try {
    const r = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { live: [], error: `閘道回 HTTP ${r.status}` };
    const j = (await r.json()) as { data?: unknown[] };
    const items = Array.isArray(j.data) ? j.data : [];
    const live: LiveDeployment[] = [];
    for (const it of items) {
      const o = it as Record<string, unknown>;
      const params = (o.litellm_params ?? {}) as Record<string, unknown>;
      const info = (o.model_info ?? {}) as Record<string, unknown>;
      const id = typeof info.id === "string" ? info.id : "";
      if (!id) continue;
      live.push({
        modelName: typeof o.model_name === "string" ? o.model_name : "",
        backendModel: typeof params.model === "string" ? params.model : "",
        apiBase: typeof params.api_base === "string" ? params.api_base : "",
        id,
      });
    }
    return { live, error: null };
  } catch (err) {
    return { live: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 用量（依部署 id） ─────────────────────────────────────────────────

/**
 * 每個部署的用量。日界線與 listQuotaPools 用同一個算式（台北當日），
 * 不要另外發明一套，否則同一頁上兩個「今日」會對不起來。
 */
export async function getUsageByDeployment(): Promise<Map<string, DeploymentUsage>> {
  const out = new Map<string, DeploymentUsage>();
  try {
    const client = getPool();
    // 日界線：台北當日 00:00。與 listQuotaPools 用同一個算式，不要另外發明一套，
    // 否則同一頁上兩個「今日」會對不起來。startTime 是 naive UTC、伺服器 TimeZone=UTC，
    // 直接與 timestamptz 比較是對的（2026-08-23 在正式庫確認過邊界值）。
    const DAY0 = `date_trunc('day', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei'`;
    const { rows } = await client.query(
      `SELECT model_id,
              COUNT(*) FILTER (WHERE "startTime" >= ${DAY0})::int                          AS today_calls,
              COALESCE(SUM(total_tokens) FILTER (WHERE "startTime" >= ${DAY0}), 0)::bigint AS today_tokens,
              COALESCE(SUM(spend)        FILTER (WHERE "startTime" >= ${DAY0}), 0)::float8 AS today_spend,
              COUNT(*)::int                                                                AS total_calls,
              COUNT(*) FILTER (WHERE status = 'failure')::int                              AS total_failures,
              MAX("startTime") FILTER (WHERE status = 'success')                           AS last_success,
              MAX("startTime") FILTER (WHERE status = 'failure')                           AS last_failure
         FROM "LiteLLM_SpendLogs"
        WHERE model_id IS NOT NULL AND model_id <> ''
        GROUP BY model_id`
    );
    for (const r of rows) {
      out.set(String(r.model_id), {
        todayCalls: Number(r.today_calls) || 0,
        todayTokens: Number(r.today_tokens) || 0,
        todaySpend: Number(r.today_spend) || 0,
        totalCalls: Number(r.total_calls) || 0,
        totalFailures: Number(r.total_failures) || 0,
        lastSuccessAt: r.last_success ? new Date(r.last_success) : null,
        lastFailureAt: r.last_failure ? new Date(r.last_failure) : null,
      });
    }
  } catch (err) {
    console.warn("[keys] getUsageByDeployment failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

function mergeUsage(parts: DeploymentUsage[]): DeploymentUsage {
  const acc: DeploymentUsage = { ...EMPTY_USAGE };
  for (const p of parts) {
    acc.todayCalls += p.todayCalls;
    acc.todayTokens += p.todayTokens;
    acc.todaySpend += p.todaySpend;
    acc.totalCalls += p.totalCalls;
    acc.totalFailures += p.totalFailures;
    if (p.lastSuccessAt && (!acc.lastSuccessAt || p.lastSuccessAt > acc.lastSuccessAt)) {
      acc.lastSuccessAt = p.lastSuccessAt;
    }
    if (p.lastFailureAt && (!acc.lastFailureAt || p.lastFailureAt > acc.lastFailureAt)) {
      acc.lastFailureAt = p.lastFailureAt;
    }
  }
  return acc;
}

// ── 組裝 ─────────────────────────────────────────────────────────────

/** 把 `openrouter/*` 這種 glob 轉成前綴比對。只支援尾端一個星號，夠用。 */
function globMatches(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === value;
  return value.startsWith(pattern.slice(0, star));
}

export async function getKeyInventory(): Promise<KeyInventory> {
  const checkedAt = new Date();
  const [{ entries, error: configError }, { live, error: gatewayError }, usage] = await Promise.all([
    readConfig(),
    readGateway(),
    getUsageByDeployment(),
  ]);

  // 同名 model_name 底下的線上部署，維持閘道回傳的順序。
  const liveByName = new Map<string, LiveDeployment[]>();
  for (const d of live) {
    const arr = liveByName.get(d.modelName) ?? [];
    arr.push(d);
    liveByName.set(d.modelName, arr);
  }
  const claimed = new Set<string>();

  // 第一輪：非萬用字元的設定，依 yaml 順序對到閘道同名部署的第 N 筆。
  const cursor = new Map<string, number>();
  const resolved: { entry: ConfigEntry; id: string | null }[] = [];
  for (const e of entries) {
    if (e.isWildcard) {
      resolved.push({ entry: e, id: null });
      continue;
    }
    const arr = liveByName.get(e.modelName) ?? [];
    const i = cursor.get(e.modelName) ?? 0;
    cursor.set(e.modelName, i + 1);
    const hit = arr[i];
    if (hit) claimed.add(hit.id);
    resolved.push({ entry: e, id: hit ? hit.id : null });
  }

  // 第二輪：萬用字元設定收走「後端 model 前綴吻合、且還沒被認領」的部署。
  // openrouter-* 在閘道會被展開成 openrouter/<家族>/<模型> 一百多個名字，
  // 用 model_name 比對不會中，要比對後端 model 字串。
  const wildcardIds = new Map<number, string[]>();
  resolved.forEach((r, idx) => {
    if (!r.entry.isWildcard || !r.entry.envName) return;
    const ids: string[] = [];
    for (const d of live) {
      if (claimed.has(d.id)) continue;
      if (globMatches(r.entry.backendModel, d.backendModel)) {
        ids.push(d.id);
        claimed.add(d.id);
      }
    }
    wildcardIds.set(idx, ids);
  });

  // 依環境變數名歸戶。一把金鑰可能掛在多個模型上（GROQ_KEY_1 同時在 groq-large 與 groq-fast）。
  const byEnv = new Map<string, { rows: KeyDeployment[]; pricing: PricingType; provider: string; kind: CredentialKind; ids: Set<string> }>();
  let unloaded = 0;

  resolved.forEach((r, idx) => {
    const e = r.entry;
    if (!e.envName) return; // Vertex 走服務帳戶，另外處理
    const apiBase = live.find((d) => d.id === r.id)?.apiBase ?? "";
    const provider = providerOfModel(e.backendModel, apiBase);
    const kind: CredentialKind = provider === "訂閱橋接" ? "bridge" : "provider";
    const cur =
      byEnv.get(e.envName) ??
      { rows: [], pricing: e.pricing, provider, kind, ids: new Set<string>() };
    if (e.isWildcard) {
      const ids = wildcardIds.get(idx) ?? [];
      cur.rows.push({ modelName: e.modelName, backendModel: e.backendModel, deploymentId: ids[0] ?? null });
      ids.forEach((id) => cur.ids.add(id));
      if (ids.length === 0) unloaded += 1;
    } else {
      cur.rows.push({ modelName: e.modelName, backendModel: e.backendModel, deploymentId: r.id });
      if (r.id) cur.ids.add(r.id);
      else unloaded += 1;
    }
    // 同一把金鑰若橫跨不同計價型態（不該發生），保守取較貴的那個。
    if (cur.pricing !== e.pricing && e.pricing === "payg") cur.pricing = "payg";
    byEnv.set(e.envName, cur);
  });

  // 每個「池」（同一個 model_name 下的多把金鑰）算出第幾把。
  const poolOf = new Map<string, { size: number; slot: number }>();
  const groupCounter = new Map<string, number>();
  for (const e of entries) {
    if (!e.envName || e.isWildcard) continue;
    const n = (groupCounter.get(e.modelName) ?? 0) + 1;
    groupCounter.set(e.modelName, n);
    if (!poolOf.has(e.envName)) poolOf.set(e.envName, { size: 0, slot: n });
  }
  for (const [env, v] of poolOf) {
    const first = entries.find((e) => e.envName === env && !e.isWildcard);
    v.size = first ? (groupCounter.get(first.modelName) ?? 1) : 1;
  }

  const keys: UpstreamKeyRow[] = [...byEnv.entries()].map(([envName, v]) => {
    const pool = poolOf.get(envName);
    return {
      envName,
      provider: v.provider,
      pricing: v.pricing,
      kind: v.kind,
      deployments: v.rows,
      tail: null, // 之後由 readTails() 填
      slot: pool && pool.size > 1 ? pool.slot : null,
      poolSize: pool?.size ?? 1,
      usage: mergeUsage([...v.ids].map((id) => usage.get(id) ?? EMPTY_USAGE)),
    };
  });

  // 服務帳戶：Vertex 那些部署沒有 api_key，用的是閘道唯讀掛載的憑證檔。
  // 它是不折不扣的上游憑證，漏掉它會讓「十把金鑰」看起來就是全部。
  const vertexIds = new Set<string>();
  const vertexModels: KeyDeployment[] = [];
  for (const d of live) {
    if (!d.backendModel.startsWith("vertex_ai/")) continue;
    vertexIds.add(d.id);
    if (vertexModels.length < 40) {
      vertexModels.push({ modelName: d.modelName, backendModel: d.backendModel, deploymentId: d.id });
    }
  }
  if (vertexIds.size > 0) {
    keys.push({
      envName: "GOOGLE_APPLICATION_CREDENTIALS",
      provider: "Vertex AI",
      pricing: "payg",
      kind: "service-account",
      deployments: vertexModels,
      tail: null, // 之後由 readTails() 填
      slot: null,
      poolSize: 1,
      usage: mergeUsage([...vertexIds].map((id) => usage.get(id) ?? EMPTY_USAGE)),
    });
  }

  // 排序：免費的排前面（那是要盯著看的），其次訂閱、隨用隨付，同組再依名字。
  const order: Record<PricingType, number> = { free: 0, subscription: 1, payg: 2, unknown: 3 };
  keys.sort((a, b) => order[a.pricing] - order[b.pricing] || a.envName.localeCompare(b.envName));

  const tails = await readTails();
  for (const k of keys) k.tail = tails[k.envName] ?? null;

  return {
    ok: !configError,
    configError,
    gatewayError,
    keys,
    unloaded,
    totalDeployments: live.length,
    checkedAt,
  };
}

/**
 * 免費額度的把數跟著閘道設定走（2026-09-12）。
 *
 * User：「免費額度應該是會隨著金鑰變動，而不是固定的」。quota_pools.key_count 是手填的，
 * 9/7 新增第 6、7 把之後沒有人去改，整池上限一直少算兩把（150 次，實際是 210 次）。
 * 這裡用金鑰盤點數「設定檔裡有幾把上游金鑰掛在這個模型組」覆寫手填值；
 * 新增或移除金鑰之後，上限自動跟著變。設定檔讀不到才退回手填值，並標成 manual 讓畫面講出來。
 */
export function applyActualKeyCounts(pools: QuotaPoolStatus[], inv: KeyInventory | null): QuotaPoolStatus[] {
  const ok = !!inv && !inv.configError;
  return pools.map((p) => {
    const n = ok
      ? inv!.keys.filter((k) => k.kind === "provider" && k.deployments.some((d) => d.modelName === p.model_name)).length
      : 0;
    if (!ok || n === 0) return { ...p, keyCountSource: "manual" as const };
    const poolLimitRpd = p.limit_rpd == null ? null : p.limit_rpd * n;
    const poolLimitTpd = p.limit_tpd == null ? null : p.limit_tpd * n;
    return {
      ...p,
      key_count: n,
      keyCountSource: "gateway" as const,
      poolLimitRpd,
      poolLimitTpd,
      pctRequests: poolLimitRpd ? (p.usedRequests / poolLimitRpd) * 100 : null,
      pctTokens: poolLimitTpd ? (p.usedTokens / poolLimitTpd) * 100 : null,
    };
  });
}

/** listQuotaPools 加上「把數跟著閘道設定走」。總覽頁、免費額度 API 用這支。 */
export async function listQuotaPoolsLive(): Promise<QuotaPoolStatus[]> {
  const [pools, inv] = await Promise.all([listQuotaPools(), getKeyInventory().catch(() => null)]);
  return applyActualKeyCounts(pools, inv);
}

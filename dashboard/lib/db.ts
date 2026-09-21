import { Pool } from "pg";
import {
  ANTHROPIC_PRICES,
  OPENAI_PRICES,
  toApiEquivalent,
  type ModelPrice,
  type UsageRow,
} from "@/lib/pricing";
import { taipeiDay } from "@/lib/range";

/**
 * 全域連線池。任何呼叫方都不得假設連線一定成功——本機開發環境的
 * PostgreSQL 服務可能未啟動、埠號被占用、或帳密不符，所有查詢函式
 * 一律包在 try/catch 內，失敗時降級為空結果，不得讓頁面或 API 500。
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
    });
    pool.on("error", (err) => {
      // 閒置連線發生錯誤時不要讓 process 崩潰
      console.warn("[db] pool idle client error:", err.message);
    });
  }
  return pool;
}

export type UsageByModel = {
  model: string;
  spend: number;
  tokens: number;
};

export type UsageByApiKey = {
  apiKey: string;
  spend: number;
  tokens: number;
};

export type UsageSummary = {
  totalSpend: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  byModel: UsageByModel[];
  byApiKey: UsageByApiKey[];
  daily: { date: string; spend: number }[];
  available: boolean;
};

const EMPTY_SUMMARY: UsageSummary = {
  totalSpend: 0,
  totalTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheTokens: 0,
  byModel: [],
  byApiKey: [],
  daily: [],
  available: false,
};

/**
 * 從 LiteLLM 自建的 "LiteLLM_SpendLogs" 表彙總日期範圍內的花費與 token。
 * 這張表由 LiteLLM 自己建立，Phase 1 環境下很可能還不存在（LiteLLM 容器
 * 沒起過、或還沒打過任何請求），也可能整個資料庫都連不上——任何錯誤一律
 * 降級為空集合結構，只 console.warn，不拋出。
 */
export async function getUsageSummary(from: Date, to: Date): Promise<UsageSummary> {
  try {
    const client = getPool();
    const result = await client.query(
      `SELECT
         "api_key"        AS api_key,
         "model"          AS model,
         COALESCE("spend", 0)::float8            AS spend,
         COALESCE("total_tokens", 0)::bigint      AS total_tokens,
         COALESCE("prompt_tokens", 0)::bigint     AS prompt_tokens,
         COALESCE("completion_tokens", 0)::bigint AS completion_tokens,
         "startTime"       AS start_time
       FROM "LiteLLM_SpendLogs"
       WHERE "startTime" >= $1 AND "startTime" < $2`,
      [from.toISOString(), to.toISOString()]
    );

    const byModelMap = new Map<string, UsageByModel>();
    const byApiKeyMap = new Map<string, UsageByApiKey>();
    const dailyMap = new Map<string, number>();
    let totalSpend = 0;
    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const row of result.rows) {
      const spend = Number(row.spend) || 0;
      const tokens = Number(row.total_tokens) || 0;
      const inputTokens = Number(row.prompt_tokens) || 0;
      const outputTokens = Number(row.completion_tokens) || 0;
      const model = row.model || "(未知模型)";
      const apiKey = row.api_key || "(未知金鑰)";
      // 每日分桶用台北日（2026-09-12 起「本月」改台北時間，日界線一起改）
      const day = row.start_time ? taipeiDay(new Date(row.start_time)) : null;

      totalSpend += spend;
      totalTokens += tokens;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      const m = byModelMap.get(model) ?? { model, spend: 0, tokens: 0 };
      m.spend += spend;
      m.tokens += tokens;
      byModelMap.set(model, m);

      const k = byApiKeyMap.get(apiKey) ?? { apiKey, spend: 0, tokens: 0 };
      k.spend += spend;
      k.tokens += tokens;
      byApiKeyMap.set(apiKey, k);

      if (day) {
        dailyMap.set(day, (dailyMap.get(day) ?? 0) + spend);
      }
    }

    return {
      totalSpend,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens: 0,
      byModel: [...byModelMap.values()].sort((a, b) => b.spend - a.spend),
      byApiKey: [...byApiKeyMap.values()].sort((a, b) => b.spend - a.spend),
      daily: [...dailyMap.entries()]
        .map(([date, spend]) => ({ date, spend }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      available: true,
    };
  } catch (err) {
    console.warn(
      "[db] getUsageSummary failed, degrading to empty result:",
      err instanceof Error ? err.message : err
    );
    return EMPTY_SUMMARY;
  }
}

export type AppRow = {
  id: number;
  name: string;
  description: string | null;
  vkey_id: string | null;
  status: string;
  created_at: string;
  /**
   * 換過的舊金鑰。歸戶一定要連它一起比對——
   * 只比 `vkey_id` 的話，換過鑰的軟體會整批掉進「未歸戶」（第六十六節第四段）。
   * 2026-08-30 補進這支查詢：`getSpendByProject` 與 `getUnattributedUsage`
   * 8/26 就修好了，**但總覽的軟體費用排行沒有一起改**，
   * 於是 app-a 換鑰之後，它八月的 86 筆、US$0.7563 全部被算進
   * 排行最後那列「開發測試」，而它本來應該是第一名。
   */
  retired_vkey_ids: string[];
};

export async function listApps(): Promise<AppRow[]> {
  try {
    const client = getPool();
    const result = await client.query<AppRow>(
      `SELECT id, name, description, vkey_id, status, created_at,
              COALESCE(retired_vkey_ids, '{}') AS retired_vkey_ids
       FROM costscale.apps
       ORDER BY created_at DESC`
    );
    return result.rows;
  } catch (err) {
    console.warn("[db] listApps failed, degrading to empty list:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function createApp(input: {
  name: string;
  description?: string | null;
  vkeyId?: string | null;
}): Promise<AppRow | null> {
  try {
    const client = getPool();
    const result = await client.query<AppRow>(
      `INSERT INTO costscale.apps (name, description, vkey_id, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, name, description, vkey_id, status, created_at`,
      [input.name, input.description ?? null, input.vkeyId ?? null]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.warn("[db] createApp failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function patchApp(
  id: number,
  patch: { name?: string; status?: string; vkeyId?: string | null }
): Promise<AppRow | null> {
  try {
    const client = getPool();
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.vkeyId !== undefined) {
      sets.push(`vkey_id = $${i++}`);
      values.push(patch.vkeyId);
    }
    if (sets.length === 0) return null;
    values.push(id);
    const result = await client.query<AppRow>(
      `UPDATE costscale.apps SET ${sets.join(", ")} WHERE id = $${i}
       RETURNING id, name, description, vkey_id, status, created_at`,
      values
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.warn("[db] patchApp failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 換金鑰：新的寫進 vkey_id，舊的推進 retired_vkey_ids。
 *
 * 兩件事必須在同一句 SQL 裡完成。分兩次寫的話，中間掛掉會變成
 * 「新金鑰生效但舊金鑰沒被記下」——那個軟體過去的花費就永久對不回來了。
 *
 * 舊金鑰為 null（本來就沒有金鑰的軟體）時只寫新的，不要往陣列塞 null。
 */
export async function retireAppVkey(
  id: number,
  oldVkey: string | null,
  newVkey: string
): Promise<AppRow | null> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `UPDATE costscale.apps
          SET vkey_id = $2,
              retired_vkey_ids = CASE
                WHEN $3::text IS NULL OR $3 = '' THEN retired_vkey_ids
                WHEN $3 = ANY(retired_vkey_ids) THEN retired_vkey_ids
                ELSE array_append(retired_vkey_ids, $3::text)
              END
        WHERE id = $1
        RETURNING *`,
      [id, newVkey, oldVkey]
    );
    return (rows[0] as AppRow) ?? null;
  } catch (err) {
    console.warn("[db] retireAppVkey failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getAppById(id: number): Promise<AppRow | null> {
  try {
    const client = getPool();
    const result = await client.query<AppRow>(
      `SELECT id, name, description, vkey_id, status, created_at FROM costscale.apps WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.warn("[db] getAppById failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSettings(): Promise<Record<string, string>> {
  try {
    const client = getPool();
    const result = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM costscale.settings`
    );
    const map: Record<string, string> = {};
    for (const row of result.rows) map[row.key] = row.value;
    return map;
  } catch (err) {
    console.warn("[db] getSettings failed, degrading to empty map:", err instanceof Error ? err.message : err);
    return {};
  }
}

// ── GCP 帳單（BigQuery 匯出合併後）──────────────────────────────
//
// 與 gcp_usage 是兩回事，介面上不要混：
//   gcp_usage     來自 Cloud Monitoring，是用量，金額靠價目表估算
//   billing_daily 來自帳單匯出，是 Google 實際計價的結果
// 同一段用量在兩邊會有不同數字，那是資料源不同，不是誰算錯。

export type BillingClientRow = {
  source: string;
  clientId: string;
  gross: number;
  credit: number;
  net: number;
};

export type BillingSkuRow = {
  service: string;
  sku: string;
  gross: number;
  net: number;
  /**
   * 帳單自己記的用量。對 token 類的 SKU 這就是 token 數。
   * 注意單位字面上是 "requests"——那是 Google 對「可計費單位個數」的統稱，
   * 不是請求次數（2026-08-23 實測確認）。
   */
  usageAmount: number;
  usageUnit: string | null;
};

export type BillingExportState = {
  source: string;
  maxExportTime: Date | null;
  maxUsageDay: string | null;
  rowsSeen: number;
  excludedGross: number;
  fetchedAt: Date;
  /** 資料補到的那天距今幾天。介面靠這個決定要不要示警。 */
  lagDays: number | null;
};

export type BillingSummary = {
  available: boolean;
  currencies: string[];
  totalGross: number;
  totalCredit: number;
  totalNet: number;
  byClient: BillingClientRow[];
  bySku: BillingSkuRow[];
  daily: { date: string; gross: number; net: number }[];
  states: BillingExportState[];
};

const EMPTY_BILLING: BillingSummary = {
  available: false,
  currencies: [],
  totalGross: 0,
  totalCredit: 0,
  totalNet: 0,
  byClient: [],
  bySku: [],
  daily: [],
  states: [],
};

/**
 * 帳單匯出的彙總。
 *
 * 三個數字一定要一起給，不能只給一個：
 *   gross  原價，未扣抵免額
 *   credit 抵免（負值），試用額度期間會把 gross 抵到零
 *   net    實付 = gross + credit
 * 只看 net 會以為沒花錢，只看 gross 又不是實際支出。
 *
 * states 是匯出水位，**呼叫端必須顯示**。帳單匯出是回填的，
 * 資料還沒補到今天時，這裡算出來的「本月花費」會偏低但看起來完全正常。
 */
export async function getBillingSummary(from: Date, to: Date): Promise<BillingSummary> {
  const now = Date.now();
  try {
    const client = getPool();
    const args = [taipeiDay(from), taipeiDay(to)];

    const [totals, byClient, bySku, daily, states] = await Promise.all([
      client.query(
        `SELECT COALESCE(SUM(gross),0)::float8 g, COALESCE(SUM(credit),0)::float8 c,
                COALESCE(SUM(net),0)::float8 n,
                COALESCE(ARRAY_AGG(DISTINCT currency), '{}') AS currencies
           FROM costscale.billing_daily WHERE day >= $1 AND day < $2`, args),
      client.query(
        `SELECT source, client_id, SUM(gross)::float8 g, SUM(credit)::float8 c, SUM(net)::float8 n
           FROM costscale.billing_daily WHERE day >= $1 AND day < $2
          GROUP BY source, client_id ORDER BY SUM(gross) DESC`, args),
      client.query(
        `SELECT service, sku, SUM(gross)::float8 g, SUM(net)::float8 n,
                SUM(usage_amount)::float8 ua, MAX(usage_unit) uu
           FROM costscale.billing_daily WHERE day >= $1 AND day < $2
          GROUP BY service, sku ORDER BY SUM(gross) DESC LIMIT 12`, args),
      client.query(
        `SELECT to_char(day,'YYYY-MM-DD') d, SUM(gross)::float8 g, SUM(net)::float8 n
           FROM costscale.billing_daily WHERE day >= $1 AND day < $2
          GROUP BY day ORDER BY day`, args),
      client.query(
        `SELECT source, max_export_time, to_char(max_usage_day,'YYYY-MM-DD') max_usage_day,
                rows_seen, excluded_gross, fetched_at
           FROM costscale.billing_export_state ORDER BY source`),
    ]);

    const t = totals.rows[0];
    return {
      available: true,
      currencies: (t.currencies || []).filter(Boolean),
      totalGross: Number(t.g) || 0,
      totalCredit: Number(t.c) || 0,
      totalNet: Number(t.n) || 0,
      byClient: byClient.rows.map((r) => ({
        source: r.source,
        clientId: r.client_id,
        gross: Number(r.g) || 0,
        credit: Number(r.c) || 0,
        net: Number(r.n) || 0,
      })),
      bySku: bySku.rows.map((r) => ({
        service: r.service,
        sku: r.sku,
        gross: Number(r.g) || 0,
        net: Number(r.n) || 0,
        usageAmount: Number(r.ua) || 0,
        usageUnit: r.uu ? String(r.uu) : null,
      })),
      daily: daily.rows.map((r) => ({
        date: r.d,
        gross: Number(r.g) || 0,
        net: Number(r.n) || 0,
      })),
      states: states.rows.map((r) => ({
        source: r.source,
        maxExportTime: r.max_export_time ? new Date(r.max_export_time) : null,
        maxUsageDay: r.max_usage_day,
        rowsSeen: Number(r.rows_seen) || 0,
        excludedGross: Number(r.excluded_gross) || 0,
        fetchedAt: new Date(r.fetched_at),
        lagDays: r.max_usage_day
          ? Math.floor((now - new Date(`${r.max_usage_day}T00:00:00Z`).getTime()) / 86_400_000)
          : null,
      })),
    };
  } catch (err) {
    console.warn(
      "[db] getBillingSummary failed, degrading to empty result:",
      err instanceof Error ? err.message : err
    );
    return EMPTY_BILLING;
  }
}

export type ProjectSpendRow = {
  /** CostScale 這邊的名字，等於虛擬金鑰別名。 */
  app: string;
  /** App Hub 看板上的專案名。沒填就是 null，看板無從對應。 */
  boardProjectName: string | null;
  /** 經閘道的花費，逐筆精確，含所有供應商（Google、Groq、OpenRouter、訂閱）。 */
  gatewayUsd: number;
  gatewayTwd: number;
  gatewayTokens: number;
  /** GCP 帳單側。沒填任何標籤就是 null，代表無從歸戶，不是零。多個標籤已加總。 */
  billingGrossTwd: number | null;
  billingNetTwd: number | null;
};

/**
 * 每個軟體的本期花費，供 App Hub 的專案卡使用。
 *
 * **兩個數字不可相加。** 這是這支函式最容易被誤用的地方：
 *   gateway 是「經閘道的所有請求」，含 Google 也含 Groq、OpenRouter、訂閱
 *   billing 是「Google 實際收的錢」，含經閘道的也含專案直連 Vertex 的
 * 兩者在「經閘道打 Google」這一段是重疊的，相加會把那段算兩次。
 * 所以回傳時分開兩欄，呼叫端要自己決定顯示哪一個，不提供合計。
 *
 * billing 欄位為 null 與為 0 的意思不同：null 是「沒填對應，無從歸戶」，
 * 0 是「有對應但這期沒有費用」。介面不可把兩者都畫成 0。
 */
export async function getSpendByProject(
  from: Date,
  to: Date,
  fx: number
): Promise<ProjectSpendRow[]> {
  try {
    const client = getPool();
    const [apps, gateway, billing] = await Promise.all([
      client.query(
        `SELECT name, vkey_id, retired_vkey_ids, board_project_name, billing_client_ids
           FROM costscale.apps WHERE status = 'active' ORDER BY name`
      ),
      client.query(
        `SELECT "api_key" k, COALESCE(SUM("spend"),0)::float8 s,
                COALESCE(SUM("total_tokens"),0)::bigint t
           FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= $1 AND "startTime" < $2
          GROUP BY "api_key"`,
        [from.toISOString(), to.toISOString()]
      ),
      client.query(
        `SELECT client_id, SUM(gross)::float8 g, SUM(net)::float8 n
           FROM costscale.billing_daily WHERE day >= $1 AND day < $2
          GROUP BY client_id`,
        [taipeiDay(from), taipeiDay(to)]
      ),
    ]);

    const byKey = new Map(gateway.rows.map((r) => [r.k, r]));
    const byClient = new Map(billing.rows.map((r) => [r.client_id, r]));

    return apps.rows.map((a) => {
      // 現用金鑰 ＋ 換掉的舊金鑰都要算進來。只算現用的話，
      // 一換金鑰這個軟體過去的花費就整批掉進「未歸戶」——
      // 數字不會消失，但會歸錯地方，而且沒有任何錯誤訊息（2026-08-26）。
      const keys: string[] = [a.vkey_id, ...(a.retired_vkey_ids ?? [])].filter(
        (k): k is string => typeof k === "string" && k.length > 0
      );
      let usd = 0;
      let tokens = 0;
      for (const k of keys) {
        const row = byKey.get(k);
        usd += Number(row?.s) || 0;
        tokens += Number(row?.t) || 0;
      }
      // 一個軟體可能有多個歷史帳單標籤（改過名的專案，舊標籤留在歷史帳單裡），
      // 所以要把所有標籤的金額加起來，不是取第一個。
      const labels: string[] = a.billing_client_ids ?? [];
      const hasLabels = labels.length > 0;
      let gross = 0;
      let net = 0;
      for (const label of labels) {
        const b = byClient.get(label);
        gross += Number(b?.g) || 0;
        net += Number(b?.n) || 0;
      }
      return {
        app: a.name,
        boardProjectName: a.board_project_name,
        gatewayUsd: usd,
        gatewayTwd: usd * fx,
        gatewayTokens: tokens,
        billingGrossTwd: hasLabels ? gross : null,
        billingNetTwd: hasLabels ? net : null,
      };
    });
  } catch (err) {
    console.warn(
      "[db] getSpendByProject failed, degrading to empty list:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

export type SubUsageRow = {
  provider: string;
  windowLabel: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: Date | null;
  plan: string | null;
  limitReached: boolean;
  fetchedAt: Date;
  /** 距離最後一次抓取的分鐘數。判斷放在資料層，避免在 render 裡讀時鐘。 */
  ageMinutes: number;
  /** 超過一小時沒抓到就當舊資料——橋接跑在家用主機上，關機時會停在舊值。 */
  stale: boolean;
  /**
   * 燃燒速率（D-3）：本重置週期內，每天用掉幾個百分點。
   * null 代表算不出來——週期內的點不足兩個、或時間跨度不到兩小時。
   * 算不出來就是 null，不要補 0：「速率為零」與「不知道」是兩回事。
   */
  burnPerDay: number | null;
  /**
   * 照目前速率推到 reset_at 時的預估已用百分比（上限 100）。
   * 只有 burnPerDay 與 resetAt 都有值才算得出來。
   */
  projectedAtReset: number | null;
};

/**
 * 訂閱的剩餘額度。由 scripts/fetch-sub-usage.py 定時寫入。
 *
 * 這裡不即時打橋接：那會讓總覽的載入時間綁在家機開不開機上。
 * 讀資料庫拿到的是「最後一次抓到的值」，所以 fetchedAt 一定要一起回傳，
 * 介面才能標示它有多舊——顯示一個過期的百分比而不說它過期，比不顯示更糟。
 */
/**
 * 從歷史軌跡算各視窗的燃燒速率。
 *
 * 只用**同一個重置週期內**的點：視窗重置時 used 會驟降，跨界算會得到負速率。
 * 週期邊界不用 reset_at 對比（上游回報的 reset_at 本身會隨時間微調），
 * 而是從最新往回走，遇到 used 比後一筆高出 5 個百分點就當成上一個週期，停下。
 * 斜率用最簡單的首尾差除以時距——15 分鐘一抓的等距資料，最小平方法是多餘的。
 */
async function subUsageBurnRates(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT provider, window_label, used_percent, fetched_at
         FROM costscale.sub_usage_history
        WHERE fetched_at > now() - interval '24 hours'
        ORDER BY provider, window_label, fetched_at DESC`
    );
    const byKey = new Map<string, { used: number; at: number }[]>();
    for (const r of rows) {
      const key = `${r.provider}|${r.window_label}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({
        used: Number(r.used_percent),
        at: new Date(r.fetched_at).getTime(),
      });
    }
    for (const [key, pts] of byKey) {
      // pts 是新到舊。從最新往回收集同週期的點。
      const cycle: { used: number; at: number }[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].used > pts[i - 1].used + 5) break; // 往回走遇到更高的 used＝上個週期
        cycle.push(pts[i]);
      }
      const first = cycle[cycle.length - 1];
      const last = cycle[0];
      const spanHours = (last.at - first.at) / 3_600_000;
      if (cycle.length < 2 || spanHours < 2) continue; // 點太少或跨度太短，斜率是噪音
      out.set(key, ((last.used - first.used) / spanHours) * 24);
    }
  } catch (err) {
    console.warn("[db] subUsageBurnRates failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

export async function listSubUsage(): Promise<SubUsageRow[]> {
  const now = Date.now();
  try {
    const client = getPool();
    const [{ rows }, burn] = await Promise.all([
      client.query(
        `SELECT provider, window_label, used_percent, remaining_percent,
                reset_at, plan, limit_reached, fetched_at
           FROM costscale.sub_usage
          ORDER BY provider, window_label`
      ),
      subUsageBurnRates(),
    ]);
    return rows.map((r) => ({
      provider: r.provider,
      windowLabel: r.window_label,
      usedPercent: Number(r.used_percent),
      remainingPercent: Number(r.remaining_percent),
      resetAt: r.reset_at ? new Date(r.reset_at) : null,
      plan: r.plan,
      limitReached: r.limit_reached,
      fetchedAt: new Date(r.fetched_at),
      ageMinutes: Math.round((now - new Date(r.fetched_at).getTime()) / 60_000),
      stale: now - new Date(r.fetched_at).getTime() > 60 * 60_000,
      ...(() => {
        const rate = burn.get(`${r.provider}|${r.window_label}`) ?? null;
        const resetMs = r.reset_at ? new Date(r.reset_at).getTime() : null;
        let projected: number | null = null;
        if (rate !== null && resetMs !== null && resetMs > now) {
          const daysLeft = (resetMs - now) / 86_400_000;
          projected = Math.min(100, Number(r.used_percent) + Math.max(0, rate) * daysLeft);
        }
        return { burnPerDay: rate, projectedAtReset: projected };
      })(),
    }));
  } catch (err) {
    console.warn("[db] listSubUsage failed, degrading to empty list:", err instanceof Error ? err.message : err);
    return [];
  }
}

export type FxRate = {
  /** 已含手續費的實際換算率。畫面上要換算台幣一律用這個值。 */
  rate: number;
  /** 未加手續費的牌告值，顯示用。 */
  baseRate: number;
  markupPct: number;
  /** 'open.er-api' / 'currency-api' / 'manual'（fx_rates 沒資料時退回 settings） */
  source: string;
  /** 匯率的日期。manual 時為 null。 */
  day: string | null;
  /** 自動匯率超過兩天沒更新。介面要標示，否則會拿舊匯率當今天的算而不自知。 */
  stale: boolean;
};

const MANUAL_FX_FALLBACK = 32.5;

/**
 * 取目前該用的匯率。優先讀 fx_rates 的最新一筆（由 scripts/fetch-fx.py 每日寫入），
 * 取不到才退回手動填的 settings.fx_usd_twd。
 *
 * 注意這個值只適用「未發生的預估」。已發生的訂閱扣款要用
 * subscription_charges 裡凍結的 fx_rate，不能用這裡的最新值重算，
 * 否則歷史台幣金額會隨匯率浮動，跟信用卡帳單對不起來。
 */
export async function getFxRate(): Promise<FxRate> {
  const settings = await getSettings();
  const markupPct = Number(settings.fx_markup_pct) || 0;
  const manual = Number(settings.fx_usd_twd) || MANUAL_FX_FALLBACK;

  try {
    const client = getPool();
    const result = await client.query<{ rate: string; source: string; day: Date }>(
      `SELECT rate, source, day FROM costscale.fx_rates
        WHERE base = 'USD' AND quote = 'TWD'
        ORDER BY day DESC LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) throw new Error("fx_rates 尚無資料");

    const baseRate = Number(row.rate);
    const day = new Date(row.day).toISOString().slice(0, 10);
    const ageDays = Math.floor((Date.now() - new Date(day).getTime()) / 86_400_000);
    return {
      rate: baseRate * (1 + markupPct / 100),
      baseRate,
      markupPct,
      source: row.source,
      day,
      stale: ageDays > 2,
    };
  } catch (err) {
    console.warn("[db] getFxRate failed, degrading to manual rate:", err instanceof Error ? err.message : err);
    // 退回手動值時不加手續費：手動填的那個數字是使用者自己認定的最終匯率。
    return { rate: manual, baseRate: manual, markupPct: 0, source: "manual", day: null, stale: true };
  }
}

export async function updateSetting(key: string, value: string): Promise<boolean> {
  try {
    const client = getPool();
    await client.query(
      `INSERT INTO costscale.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
    return true;
  } catch (err) {
    console.warn("[db] updateSetting failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export type SubscriptionRow = {
  id: number;
  service: string;
  plan: string | null;
  /** 該計費週期的金額。月繳是月費、年繳是年費——看 billing_cycle 才知道是哪個。 */
  fee: string;
  currency: string;
  billing_cycle: "monthly" | "yearly";
  billing_day: number;
  /** 年繳的扣款月份（1-12）。月繳為 null。 */
  billing_month: number | null;
  status: string;
  note: string | null;
};

export async function listSubscriptions(): Promise<SubscriptionRow[]> {
  try {
    const client = getPool();
    const result = await client.query<SubscriptionRow>(
      `SELECT id, service, plan, fee, currency, billing_cycle, billing_day, billing_month, status, note
       FROM costscale.subscriptions
       ORDER BY id ASC`
    );
    return result.rows;
  } catch (err) {
    console.warn("[db] listSubscriptions failed, degrading to empty list:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 已發生的訂閱扣款。金額與匯率都是扣款當下的快照，不隨現在的匯率浮動。 */
export type SubscriptionChargeRow = {
  id: number;
  sub_id: number;
  service: string;
  charged_on: string;
  fee: string;
  currency: string;
  /** 扣款當天的牌告匯率快照。幣別為 TWD 時是 1。 */
  fx_rate: string;
  fx_source: string;
  /** 信用卡外幣交易手續費率（%）。TWD 時是 0。 */
  markup_pct: string;
  amount_twd: string;
  /** 'auto'＝排程在扣款日凍結的；'manual'＝人工補的（升級差額之類）。 */
  source: string;
  /** 人工補這筆的理由。自動入帳是 null。 */
  note: string | null;
  /** 信用卡帳單上的實際入帳金額，人工填。null 表示尚未對帳。 */
  actual_twd: string | null;
  reconciled_at: string | null;
};

/**
 * 扣款歷史（2026-08-24，C-13）。
 *
 * 這張表從 2026-08-21 建好之後就沒有任何地方在讀——`scripts/fetch-fx.py` 每天寫，
 * 但介面上的台幣金額一直是 `fee × 目前匯率` 當場算的。當場算對「未發生的預估」
 * 是正確的，可是 `db/init/12-fx-rates.sql` 當初要修的問題是**已發生的金額**
 * 會被新匯率改寫；快照存了卻沒拿出來用，那個問題等於沒修完。
 *
 * 所以這裡只做一件事：把凍結的值原樣讀出來。
 * **不要在這裡用現在的匯率重算任何東西**，那會把凍結的意義抵消掉。
 */
/**
 * 填入（或清除）某一筆扣款的實際入帳金額（2026-08-25，D-2）。
 *
 * 只動 actual_twd 與 reconciled_at。**凍結的那五欄一概不碰**——
 * 對帳的意義是「拿實際去比對當初凍結的預期」，
 * 一旦讓對帳反過來改寫預期值，就沒有東西可以比了。
 *
 * 傳 null 表示取消對帳（填錯時要退得回去）。
 */
export async function setChargeActual(
  id: number,
  actualTwd: number | null
): Promise<SubscriptionChargeRow | null> {
  try {
    const client = getPool();
    const { rows } = await client.query<SubscriptionChargeRow>(
      `UPDATE costscale.subscription_charges
          SET actual_twd = $2,
              reconciled_at = CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END
        WHERE id = $1
      RETURNING id, sub_id, '' AS service,
                to_char(charged_on, 'YYYY-MM-DD') AS charged_on,
                fee, currency, fx_rate, fx_source, markup_pct, amount_twd,
                actual_twd, reconciled_at`,
      [id, actualTwd]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[db] setChargeActual failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 期間比較與月底推估（2026-08-25，D-4／D-5）────────────────────────

/**
 * 跟上一期比，以及本月推估。
 *
 * 為什麼需要：原本所有統計格都是絕對值。
 * **成本管理最重要的訊號是變化，不是水位**——
 * 「本月 NT$1,234」沒有「上月 NT$890、＋38%」有用，
 * 而預算告警是撞到門檻才響，撞之前沒有任何軌跡。
 *
 * 推估只在「查詢區間包含今天」時才給。看的是已經結束的月份時，
 * 推估沒有意義，硬要給只會讓人以為那是預測。
 *
 * 推估法是**已發生天數的線性外推**，不是移動平均或迴歸：
 * 用量的形狀受工作日與專案節奏影響，樣本又只有一個月，
 * 套複雜模型只會得到一個看起來比較精緻但一樣不準的數字。
 * 線性外推至少講得清楚它假設了什麼。
 */
export type SpendTrend = {
  currentTwd: number;
  previousTwd: number;
  /** 相對上一期的變化百分比；上一期為 0 時給 null（除以零沒有意義）。 */
  deltaPct: number | null;
  /** 區間已經過的天數與總天數。 */
  daysElapsed: number;
  daysTotal: number;
  /** 依已發生天數線性外推的區間總額；區間不含今天時為 null。 */
  projectedTwd: number | null;
};

export async function getSpendTrend(
  from: Date,
  to: Date,
  fxRate: number
): Promise<SpendTrend> {
  const empty: SpendTrend = {
    currentTwd: 0, previousTwd: 0, deltaPct: null,
    daysElapsed: 0, daysTotal: 0, projectedTwd: null,
  };
  try {
    const client = getPool();
    const spanMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - spanMs);

    const sumSpend = async (a: Date, b: Date): Promise<number> => {
      const { rows } = await client.query<{ spend: string }>(
        `SELECT COALESCE(sum("spend"), 0)::text AS spend
           FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= $1 AND "startTime" < $2`,
        [a, b]
      );
      return Number(rows[0]?.spend ?? 0) * fxRate;
    };

    const currentTwd = await sumSpend(from, to);
    const previousTwd = await sumSpend(prevFrom, from);
    const deltaPct =
      previousTwd > 0 ? ((currentTwd - previousTwd) / previousTwd) * 100 : null;

    const dayMs = 86_400_000;
    const daysTotal = Math.max(1, Math.round(spanMs / dayMs));
    const now = Date.now();
    const includesToday = now >= from.getTime() && now < to.getTime();
    const daysElapsed = includesToday
      ? Math.max(1, Math.ceil((now - from.getTime()) / dayMs))
      : daysTotal;
    const projectedTwd =
      includesToday && daysElapsed > 0
        ? (currentTwd / daysElapsed) * daysTotal
        : null;

    return { currentTwd, previousTwd, deltaPct, daysElapsed, daysTotal, projectedTwd };
  } catch (err) {
    console.warn("[db] getSpendTrend failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

// ── 單位成本比較（2026-08-25，D-3）────────────────────────────────────

/**
 * 訂閱與付費 API 的每百萬 token 等效成本。
 *
 * 這是整套軟體最終要回答的問題：**訂閱划不划算**。
 * 在此之前系統只知道「API 花了多少錢」與「訂閱月費多少」，
 * 兩者單位不同（金額 vs 金額），沒有共同的分母，所以無法比較。
 *
 * 三個必須講清楚的限制，不要在介面上藏起來：
 *
 * 1. **兩條訂閱各自有不同的 token 來源，不要只看一張表。**
 *    Codex 走 `cli_session_usage`（收集器讀 session 檔）；
 *    Claude Code 走 `otel_usage`（遙測，每次推論回報一筆）。
 *    2026-08-25 第一版只查了 `cli_session_usage`，就下結論說
 *    「Claude 只有百分比、沒有 token」——**那是看錯表**。
 *    ratelimit 表頭那條確實只有百分比，但遙測那條有完整 token 數。
 *    Google One 才是真的沒有：它根本不是 AI 訂閱。
 * 2. **token 數含大量快取讀取。** 實測某一輪 94.6% 是 cached input。
 *    API 那側快取讀取也比較便宜，所以這個比較偏樂觀——
 *    它回答的是「同樣的 token 量」，不是「同樣的錢買到的價值」。
 * 3. **視窗是資料實際涵蓋的期間**，不是日曆月。session 的 token 是
 *    累計值、會跨月，硬切成「本月」會重複計算。所以改成用整個資料視窗，
 *    月費按視窗天數等比例折算。視窗會顯示在介面上。
 */
export type UnitCostRow = {
  label: string;
  /**
   * 這一列自己的資料視窗（2026-09-07 加）。
   *
   * 原本全部共用一個「整張 cli_session_usage 的 min/max」。
   * 加進 Claude Code 的本機紀錄之後那個視窗從 2026-07-29 往前拉到 05-29，
   * 而 Codex 的 token 沒有變——月費按天數折算的結果是
   * **Codex 的單位成本被灌水 2.5 倍**，而且畫面上看不出來。
   *
   * 每一條訂閱各自量各自的涵蓋期間才是對的語意，
   * 閘道那一列本來就這樣做（它把自己的視窗寫在 note 裡）。
   */
  windowFrom: string | null;
  windowTo: string | null;
  windowDays: number;
  /** 該期間的成本（TWD） */
  costTwd: number;
  /** 該期間的 token 數；null 表示量不到 */
  tokens: number | null;
  /** 每百萬 token 的台幣成本；null 表示算不出來 */
  twdPerMTok: number | null;
  /** 算不出來時的原因，或需要提醒的限制 */
  note: string | null;
  /**
   * 其中屬於「快取讀取」的 token（2026-08-27）。
   * 兩條訂閱通道的 token 有九成以上是這種，而快取讀取代表的是
   * 「同一段內容被重複送進模型」，不是新產出的工作量。
   * 只看含快取的總量會把單位成本壓得非常低——那個數字沒有錯，
   * 但它回答的不是「這個訂閱幫我做了多少事」。
   */
  cachedTokens: number | null;
  /** 扣掉快取讀取之後的 token（新內容）。 */
  freshTokens: number | null;
  /** 只用新內容 token 算的每百萬成本，是同一件事的悲觀邊界。 */
  twdPerMTokFresh: number | null;
};

export type UnitEconomics = {
  windowFrom: string | null;
  windowTo: string | null;
  windowDays: number;
  rows: UnitCostRow[];
};

/**
 * 訂閱服務名稱 → `cli_session_usage.source`。
 * 只列真的量得到 token 的。故意做成明表而不是猜字串比對：
 * 猜錯的話會把某個訂閱的成本除到別人的 token 上，而且沒有人看得出來。
 */
const SUB_TOKEN_SOURCE: Record<string, { table: "cli" | "otel"; source: string }> = {
  ChatGPT: { table: "cli", source: "codex-cli" },
  // 2026-09-07 從 otel 換成本機會話紀錄。**遙測那條漏掉六成。**
  // 同一個時間視窗實測（08-20 起）：遙測 67.2 億、本機紀錄 170.7 億，
  // 本機是遙測的 2.54 倍；而遙測開通之前（05-29 至 08-19）的 266.6 億完全沒有。
  // 漏的痕跡：claude-fable-5 在本機同期有 5.63 億 token，
  // 而 otel_usage 裡連這個模型都沒出現過——整批 session 沒回報。
  // 推測是那些 session 啟動時沒帶到 OTLP 環境變數（**假設**，未查證）。
  // 本機紀錄不依賴任何環境變數有沒有設對，是第一手資料。
  Claude: { table: "cli", source: "claude-code-local" },
};

export async function getUnitEconomics(fxRate: number): Promise<UnitEconomics> {
  const empty: UnitEconomics = { windowFrom: null, windowTo: null, windowDays: 0, rows: [] };
  try {
    const client = getPool();

    // 資料視窗：CLI session 實際涵蓋的期間。
    //
    // **兩端要帶時分、天數要含小數。**（2026-08-26 修）原本印兩個日期
    // 「2026-07-28 至 2026-08-26」再配 EXTRACT(DAY ...) 的 28 天，
    // 讀的人數日期會得到 30，跟旁邊的 28 對不起來——實際跨距是
    // 28 天 15 小時 41 分，日期部分被整數截掉了。截掉的那 0.65 天
    // 還會讓下面的期間成本低估約 2%，因為月費是按天數等比例折算的。
    //
    // 時區用台北，與站上其他顯示一致（免費額度那格也是台北日界線）。
    // startedAt 是原始 timestamptz，底下兩個查詢直接拿它當下界，
    // 不要再截成日期——截了就會跟這裡顯示的視窗差半天到一天。
    const { rows: win } = await client.query<{
      f: string | null; t: string | null; d: string; fts: string | null; fday: string | null;
    }>(
      `SELECT to_char(min(started_at)    AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS f,
              to_char(max(last_event_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS t,
              GREATEST(0.01, EXTRACT(EPOCH FROM max(last_event_at) - min(started_at)) / 86400)::text AS d,
              min(started_at)::text AS fts,
              to_char(min(started_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS fday
         FROM costscale.cli_session_usage`
    );
    const windowFrom = win[0]?.f ?? null;
    const windowTo = win[0]?.t ?? null;
    const windowDays = Number(win[0]?.d ?? 0) || 0;
    const windowStartTs = win[0]?.fts ?? null;
    const windowStartDay = win[0]?.fday ?? null;
    if (!windowFrom || !windowStartTs || !windowStartDay || windowDays <= 0) return empty;

    const { rows: byCli } = await client.query<{ source: string; tokens: string; cached: string }>(
      `SELECT source,
              COALESCE(sum(total_tokens), 0)::text        AS tokens,
              COALESCE(sum(cached_input_tokens), 0)::text AS cached
         FROM costscale.cli_session_usage GROUP BY source`
    );
    // 遙測那側只取視窗內的事件——otel_usage 是逐筆事件（有 received_at），
    // 不像 cli_session_usage 是累計快照，所以這裡可以、也應該用時間切。
    const { rows: byOtel } = await client.query<{ source: string; tokens: string; cached: string }>(
      `SELECT source,
              COALESCE(sum(input_tokens + output_tokens + cache_read + cache_write), 0)::text AS tokens,
              COALESCE(sum(cache_read), 0)::text AS cached
         FROM costscale.otel_usage
        WHERE received_at >= $1::timestamptz
        GROUP BY source`,
      [windowStartTs]
    );
    const cliTokens = new Map(
      byCli.map((r) => [r.source, { total: Number(r.tokens), cached: Number(r.cached) }])
    );
    const otelTokens = new Map(
      byOtel.map((r) => [r.source, { total: Number(r.tokens), cached: Number(r.cached) }])
    );

    // 每個來源自己的資料視窗（2026-09-07）。
    // 兩張表分開量：cli 看 started_at／last_event_at，otel 看 received_at。
    // 天數帶小數，理由同上面那段（整數會跟顯示的日期對不起來）。
    type Win = { from: string; to: string; days: number };
    const srcWindow = new Map<string, Win>();
    const winSql = (table: string, startCol: string, endCol: string) =>
      `SELECT source,
              to_char(min(${startCol}) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS f,
              to_char(max(${endCol})   AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS t,
              GREATEST(0.01, EXTRACT(EPOCH FROM max(${endCol}) - min(${startCol})) / 86400)::text AS d
         FROM ${table} GROUP BY source`;
    for (const [table, sc, ec, prefix] of [
      ["costscale.cli_session_usage", "started_at", "last_event_at", "cli"],
      ["costscale.otel_usage", "received_at", "received_at", "otel"],
    ] as const) {
      const { rows: ws } = await client.query<{ source: string; f: string; t: string; d: string }>(
        winSql(table, sc, ec)
      );
      for (const w of ws) {
        srcWindow.set(`${prefix}:${w.source}`, {
          from: w.f,
          to: w.t,
          days: Number(w.d) || 0,
        });
      }
    }

    const { rows: subs } = await client.query<{
      service: string; fee: string; currency: string; billing_cycle: string;
    }>(
      `SELECT service, fee, currency, billing_cycle
         FROM costscale.subscriptions WHERE status = 'active' ORDER BY id`
    );

    const rows: UnitCostRow[] = [];
    for (const sub of subs) {
      const perMonth =
        (Number(sub.fee) || 0) / (sub.billing_cycle === "yearly" ? 12 : 1);
      const monthlyTwd = sub.currency === "TWD" ? perMonth : perMonth * fxRate;

      const mapping = SUB_TOKEN_SOURCE[sub.service];
      const win = mapping ? srcWindow.get(`${mapping.table}:${mapping.source}`) ?? null : null;
      // 月費按「這條訂閱自己的資料視窗」折算，30 天為一個月。
      //
      // **量不到 token 的訂閱不折算，直接列月費。**（2026-09-07 User 裁決）
      // 它沒有資料來源，套任何視窗都是任意的——原本退回整體視窗，
      // 而整體視窗會隨著別條訂閱的資料範圍變動：9/7 加進 Claude 的本機紀錄之後
      // 從 38 天變成 101 天，Google One 的「該期間成本」就跟著從約 360 變成 912，
      // 而它本身什麼都沒變。列月費至少是一個有定義的數字。
      const hasWindow = win !== null;
      const rowFrom = hasWindow ? win.from : null;
      const rowTo = hasWindow ? win.to : null;
      const rowDays = hasWindow ? win.days : 0;
      const costTwd = hasWindow ? (monthlyTwd * rowDays) / 30 : monthlyTwd;

      const usage = mapping
        ? (mapping.table === "cli" ? cliTokens : otelTokens).get(mapping.source) ?? null
        : null;
      const tokens = usage ? usage.total : null;
      if (tokens && tokens > 0) {
        // 快取讀取不是新產出的工作量，扣掉之後才是「這個訂閱實際幫我做了多少事」。
        // 兩個數字都給：含快取的是樂觀邊界、只算新內容的是悲觀邊界，
        // 真實價值在兩者之間。只給一個的話，給哪一個都是在替使用者做結論。
        const cachedTokens = usage ? usage.cached : 0;
        const freshTokens = Math.max(0, tokens - cachedTokens);
        rows.push({
          label: sub.service,
          windowFrom: rowFrom,
          windowTo: rowTo,
          windowDays: rowDays,
          costTwd,
          tokens,
          twdPerMTok: (costTwd / tokens) * 1_000_000,
          note: "token 含大量快取讀取，比較偏樂觀",
          cachedTokens,
          freshTokens,
          twdPerMTokFresh: freshTokens > 0 ? (costTwd / freshTokens) * 1_000_000 : null,
        });
      } else {
        rows.push({
          label: sub.service,
          windowFrom: rowFrom,
          windowTo: rowTo,
          windowDays: rowDays,
          costTwd,
          tokens: null,
          twdPerMTok: null,
          note: mapping
            ? "這個視窗內沒有量到 token"
            : "不是 AI 訂閱，沒有 token 可歸戶；這一列列的是月費原價，沒有按天數折算",
          cachedTokens: null,
          freshTokens: null,
          twdPerMTokFresh: null,
        });
      }
    }

    // 對照組：閘道的模型計價。
    //
    // **這一列用它自己的視窗**，不是上面那個。閘道 2026-08-18 才開始記錄，
    // 硬套訂閱的視窗會變成「拿 7 天的花費配 26 天的標籤」——
    // 單價本身還是對的（分子分母同一批資料），但期間成本那一欄會低估。
    // 2026-08-25 第一版就是這樣錯的，User 拿 GCP 帳單一對就對不上。
    const { rows: gw } = await client.query<{
      spend: string; tokens: string; f: string | null; t: string | null;
    }>(
      `SELECT COALESCE(sum("spend"), 0)::text AS spend,
              COALESCE(sum("total_tokens"), 0)::text AS tokens,
              to_char(min("startTime"), 'YYYY-MM-DD') AS f,
              to_char(max("startTime"), 'YYYY-MM-DD') AS t
         FROM "LiteLLM_SpendLogs"`
    );
    const gwTokens = Number(gw[0]?.tokens ?? 0);
    const gwCostTwd = Number(gw[0]?.spend ?? 0) * fxRate;
    const gwWindow = gw[0]?.f ? `${gw[0].f} 起` : "無資料";

    // GCP 帳單的實付淨額。**牌價不等於帳單**——目前 Vertex 全額被試用抵免，
    // 實付是 0，所以「訂閱比 API 便宜幾倍」在現在的計費狀態下是誤導。
    // 這件事必須顯示，不能只給一個看起來很划算的倍數。
    // 「同期」要對的是**閘道自己的視窗**，不是訂閱那個。（2026-09-07 修）
    // 原本用整體視窗的起日，而整體視窗 9/7 加進 Claude 本機紀錄之後往前拉到 05-29，
    // 那會把閘道開始記錄（08-18）之前的 GCP 帳單也加進來，
    // 而註解裡寫的是「同期」——數字與說明會對不起來。
    const billFromDay = gw[0]?.f ?? windowStartDay;
    const { rows: bill } = await client.query<{ gross: string; net: string }>(
      `SELECT COALESCE(sum(gross), 0)::text AS gross, COALESCE(sum(net), 0)::text AS net
         FROM costscale.billing_daily WHERE day >= $1::date`,
      [billFromDay]
    );
    const billGross = Number(bill[0]?.gross ?? 0);
    const billNet = Number(bill[0]?.net ?? 0);

    rows.push({
      label: "閘道模型牌價（對照）",
      windowFrom: gw[0]?.f ?? null,
      windowTo: gw[0]?.t ?? null,
      windowDays: 0, // 這一列的成本是實際加總，不按天數折算，所以天數不參與計算
      costTwd: gwCostTwd,
      tokens: gwTokens || null,
      twdPerMTok: gwTokens > 0 ? (gwCostTwd / gwTokens) * 1_000_000 : null,
      note:
        gwTokens > 0
          ? `${gwWindow} · 這是 LiteLLM 的牌價，不是帳單；同期 GCP 實付 NT$${billNet.toFixed(0)}（原價 NT$${billGross.toFixed(0)}，其餘為試用抵免）`
          : "沒有經閘道的付費用量",
      // 閘道這側沒有快取可扣：LiteLLM 自己的回應快取沒有啟用，
      // 上游也沒有回報 prompt cache（2026-08-27 實查 552 筆，
      // cache_hit 全是 False 或空，additional_usage_values 裡的
      // cached_tokens 與 cache_read_input_tokens 也都是 null）。
      // 所以這一列的樂觀值與悲觀值是同一個數字，不是漏算。
      cachedTokens: 0,
      freshTokens: gwTokens || null,
      twdPerMTokFresh: gwTokens > 0 ? (gwCostTwd / gwTokens) * 1_000_000 : null,
    });

    return { windowFrom, windowTo, windowDays, rows };
  } catch (err) {
    console.warn("[db] getUnitEconomics failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

/**
 * 人工補一筆訂閱扣款（2026-09-21）。
 *
 * User 的情境：「升級是補差額…這個月想從 5X 升級成 10X」。
 * 排程只在 billing_day 凍結固定月費，升級當下補的那筆差額沒有地方記，
 * 帳面就會少掉一筆真的付出去的錢。
 *
 * 算法**與排程完全相同**（fee × 匯率 × (1 + 手續費率)），差別只有三點：
 *   1. source 記 'manual'，看得出這筆是事後補的。
 *   2. fx_source 前面加 manual:，因為補的時候用的是「今天」的匯率，
 *      不是扣款當天的——隔了幾天就會有差，不標示的話沒人知道。
 *   3. 幣別是台幣時不換匯也不加手續費，跟排程一致。
 *
 * 這支**不做 upsert**。人工補的就是一筆新紀錄，重複按兩次會有兩筆，
 * 那是操作者要負責的事；自動去猜「這筆是不是重複」反而會吃掉合法的第二筆。
 */
export async function addManualCharge(params: {
  subId: number;
  chargedOn: string;
  fee: number;
  currency: string;
  note: string | null;
}): Promise<SubscriptionChargeRow> {
  const client = getPool();
  const fx = await getFxRate();
  const isTwd = params.currency.toUpperCase() === "TWD";
  const rate = isTwd ? 1 : fx.baseRate;
  const markup = isTwd ? 0 : fx.markupPct;
  const amount = params.fee * rate * (1 + markup / 100);

  const result = await client.query<SubscriptionChargeRow>(
    `INSERT INTO costscale.subscription_charges
       (sub_id, charged_on, fee, currency, fx_rate, fx_source, markup_pct, amount_twd, source, note)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, 'manual', $9)
     RETURNING id, sub_id, to_char(charged_on, 'YYYY-MM-DD') AS charged_on,
               fee, currency, fx_rate, fx_source, markup_pct, amount_twd,
               source, note, actual_twd, reconciled_at,
               (SELECT service FROM costscale.subscriptions WHERE id = sub_id) AS service`,
    [
      params.subId,
      params.chargedOn,
      params.fee.toFixed(6),
      params.currency.toUpperCase(),
      rate.toFixed(6),
      isTwd ? "n/a" : `manual:${fx.source}`,
      markup.toFixed(3),
      amount.toFixed(2),
      params.note,
    ]
  );
  return result.rows[0];
}

/**
 * 刪掉一筆**人工補的**扣款（2026-09-21）。
 *
 * 只能刪 source='manual'。排程凍結的那些是「已經發生的事」的紀錄，
 * 刪掉等於竄改帳——要調整實際金額請用「實際入帳」那一欄做對帳，那才是設計給人改的地方。
 *
 * 刻意不做「就地編輯」：這是一筆財務紀錄，改錯了沒有痕跡。
 * 填錯就刪掉重補一筆，時間序上看得出來發生過什麼。
 */
export async function deleteManualCharge(id: number): Promise<SubscriptionChargeRow | null> {
  const client = getPool();
  const result = await client.query<SubscriptionChargeRow>(
    `DELETE FROM costscale.subscription_charges
      WHERE id = $1 AND source = 'manual'
      RETURNING id, sub_id, to_char(charged_on, 'YYYY-MM-DD') AS charged_on,
                fee, currency, fx_rate, fx_source, markup_pct, amount_twd,
                source, note, actual_twd, reconciled_at,
                (SELECT service FROM costscale.subscriptions WHERE id = sub_id) AS service`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function listSubscriptionCharges(limit = 60): Promise<SubscriptionChargeRow[]> {
  try {
    const client = getPool();
    const result = await client.query<SubscriptionChargeRow>(
      // charged_on 在資料庫是 DATE，但 pg 驅動會把它轉成 JS Date，
      // 再經 JSON 序列化就變成 2026-07-28T00:00:00.000Z 那種完整時間戳，
      // 畫面上就多出一截沒有意義的 00:00:00（2026-08-24 在正式站上看到）。
      // 這是一個「本來就沒有時間」的欄位，所以在 SQL 裡就轉成字串，
      // 不要讓它中途變成有時區的型別再想辦法轉回來。
      `SELECT c.id, c.sub_id, s.service,
              to_char(c.charged_on, 'YYYY-MM-DD') AS charged_on,
              c.fee, c.currency,
              c.fx_rate, c.fx_source, c.markup_pct, c.amount_twd,
              c.source, c.note, c.actual_twd, c.reconciled_at
         FROM costscale.subscription_charges c
         JOIN costscale.subscriptions s ON s.id = c.sub_id
        ORDER BY c.charged_on DESC, s.service ASC
        LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.warn("[db] listSubscriptionCharges failed, degrading to empty list:", err instanceof Error ? err.message : err);
    return [];
  }
}

export type OtelUsageRow = {
  source: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  rawAttrs?: unknown;
};

export async function insertOtelUsage(row: OtelUsageRow): Promise<boolean> {
  try {
    const client = getPool();
    await client.query(
      `INSERT INTO costscale.otel_usage
         (source, model, input_tokens, output_tokens, cache_read, cache_write, reasoning, raw_attrs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.source,
        row.model ?? null,
        row.inputTokens ?? 0,
        row.outputTokens ?? 0,
        row.cacheRead ?? 0,
        row.cacheWrite ?? 0,
        row.reasoning ?? 0,
        row.rawAttrs ? JSON.stringify(row.rawAttrs) : null,
      ]
    );
    return true;
  } catch (err) {
    console.warn("[db] insertOtelUsage failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Vertex 用量：由 scripts/fetch-gcp-usage.py 每小時寫入 ──
//
// **這是專案層的總量，含經過閘道的那一部分**，不是只有直連。
// 抓的是 Cloud Monitoring 的 publisher 計量，而閘道的 vertex_project
// 就是同一個專案，抓取程式從來沒有扣掉閘道。
// 原本這裡寫「沒有經過閘道的 Vertex 呼叫」是錯的，2026-08-25 實測更正。
// 要拿直連量，得減去 LiteLLM 的 vertex_ai 花費——見 gatewayVertexSpend()。

export type GcpUsageRow = {
  model: string;
  invocations: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  estCost: number;
};

export type GcpUsageSummary = {
  rows: GcpUsageRow[];
  totalInvocations: number;
  totalTokens: number;
  totalEstCost: number;
  lastFetched: Date | null;
};

export async function getGcpUsage(from: Date, to: Date): Promise<GcpUsageSummary> {
  const empty: GcpUsageSummary = {
    rows: [], totalInvocations: 0, totalTokens: 0, totalEstCost: 0, lastFetched: null,
  };
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT model,
              SUM(invocations)::bigint    AS invocations,
              SUM(tokens)::bigint         AS tokens,
              SUM(input_tokens)::bigint   AS input_tokens,
              SUM(output_tokens)::bigint  AS output_tokens,
              SUM(est_cost)               AS est_cost,
              MAX(fetched_at)             AS fetched_at
         FROM costscale.gcp_usage
        WHERE day >= $1::date AND day < $2::date
        GROUP BY model
        ORDER BY SUM(tokens) DESC`,
      // 只存日期的欄位要用台北日；直接傳 Date 會被當成 UTC 取日期，台北月初會取到上個月最後一天
      [taipeiDay(from), taipeiDay(to)]
    );
    const parsed: GcpUsageRow[] = rows.map((r) => ({
      model: String(r.model),
      invocations: Number(r.invocations ?? 0),
      tokens: Number(r.tokens ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      estCost: Number(r.est_cost ?? 0),
    }));
    const fetchedValues = rows
      .map((r) => (r.fetched_at ? new Date(r.fetched_at as string) : null))
      .filter((d): d is Date => d !== null);
    return {
      rows: parsed,
      totalInvocations: parsed.reduce((s, r) => s + r.invocations, 0),
      totalTokens: parsed.reduce((s, r) => s + r.tokens, 0),
      totalEstCost: parsed.reduce((s, r) => s + r.estCost, 0),
      lastFetched: fetchedValues.length
        ? new Date(Math.max(...fetchedValues.map((d) => d.getTime())))
        : null,
    };
  } catch (err) {
    // 表還沒建、或抓取程式尚未跑過時，回空集不要讓整頁掛掉
    console.warn("[db] getGcpUsage failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

// ── Phase 2：訂閱帳號維護 ──

export async function createSubscription(input: {
  service: string;
  plan?: string | null;
  fee: number;
  currency: string;
  billingCycle: "monthly" | "yearly";
  billingDay: number;
  billingMonth?: number | null;
  note?: string | null;
}): Promise<SubscriptionRow | null> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `INSERT INTO costscale.subscriptions
         (service, plan, fee, currency, billing_cycle, billing_day, billing_month, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.service,
        input.plan ?? null,
        input.fee,
        input.currency,
        input.billingCycle,
        input.billingDay,
        input.billingCycle === "yearly" ? (input.billingMonth ?? 1) : null,
        input.note ?? null,
      ]
    );
    return (rows[0] as SubscriptionRow) ?? null;
  } catch (err) {
    console.warn("[db] createSubscription failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function patchSubscription(
  id: number,
  patch: {
    service?: string;
    plan?: string | null;
    fee?: number;
    currency?: string;
    billingCycle?: "monthly" | "yearly";
    billingDay?: number;
    billingMonth?: number | null;
    status?: string;
    note?: string | null;
  }
): Promise<SubscriptionRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.service !== undefined) push("service", patch.service);
  if (patch.plan !== undefined) push("plan", patch.plan);
  if (patch.fee !== undefined) push("fee", patch.fee);
  if (patch.currency !== undefined) push("currency", patch.currency);
  if (patch.billingCycle !== undefined) push("billing_cycle", patch.billingCycle);
  if (patch.billingDay !== undefined) push("billing_day", patch.billingDay);
  if (patch.billingMonth !== undefined) push("billing_month", patch.billingMonth);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.note !== undefined) push("note", patch.note);
  if (!sets.length) return null;

  vals.push(id);
  try {
    const client = getPool();
    const { rows } = await client.query(
      `UPDATE costscale.subscriptions SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    return (rows[0] as SubscriptionRow) ?? null;
  } catch (err) {
    console.warn("[db] patchSubscription failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function deleteSubscription(id: number): Promise<boolean> {
  try {
    const client = getPool();
    await client.query(`DELETE FROM costscale.subscriptions WHERE id = $1`, [id]);
    return true;
  } catch (err) {
    console.warn("[db] deleteSubscription failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Phase 2：訂閱制 CLI 遙測彙總 ──

export type OtelBySource = {
  source: string;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  lastSeen: Date | null;
};

export type OtelSummary = {
  rows: OtelBySource[];
  sources: { source: string; lastSeen: Date | null; totalTokens: number }[];
  totalTokens: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  /** 寫進快取的量。**與 totalTokens 不重疊**，要算「全部送進去多少」時要另外加。 */
  totalCacheWrite: number;
};

export async function getOtelSummary(from: Date, to: Date): Promise<OtelSummary> {
  const empty: OtelSummary = {
    rows: [], sources: [], totalTokens: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0,
    totalCacheWrite: 0,
  };
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT source,
              model,
              count(*)                     AS calls,
              COALESCE(SUM(input_tokens),0)  AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(cache_read),0)    AS cache_read,
              COALESCE(SUM(cache_write),0)   AS cache_write,
              COALESCE(SUM(reasoning),0)     AS reasoning,
              MAX(received_at)               AS last_seen
         FROM costscale.otel_usage
        WHERE received_at >= $1 AND received_at <= $2
        GROUP BY source, model
        ORDER BY SUM(input_tokens + output_tokens) DESC`,
      [from, to]
    );

    const parsed: OtelBySource[] = rows.map((r) => ({
      source: String(r.source),
      model: r.model ? String(r.model) : null,
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      cacheWrite: Number(r.cache_write ?? 0),
      reasoning: Number(r.reasoning ?? 0),
      lastSeen: r.last_seen ? new Date(r.last_seen as string) : null,
    }));

    const bySource = new Map<string, { lastSeen: Date | null; totalTokens: number }>();
    for (const r of parsed) {
      const cur = bySource.get(r.source) ?? { lastSeen: null, totalTokens: 0 };
      cur.totalTokens += r.inputTokens + r.outputTokens;
      if (r.lastSeen && (!cur.lastSeen || r.lastSeen > cur.lastSeen)) cur.lastSeen = r.lastSeen;
      bySource.set(r.source, cur);
    }

    return {
      rows: parsed,
      sources: [...bySource.entries()].map(([source, v]) => ({ source, ...v })),
      totalTokens: parsed.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      totalInput: parsed.reduce((s, r) => s + r.inputTokens, 0),
      totalOutput: parsed.reduce((s, r) => s + r.outputTokens, 0),
      totalCacheRead: parsed.reduce((s, r) => s + r.cacheRead, 0),
      totalCacheWrite: parsed.reduce((s, r) => s + r.cacheWrite, 0),
    };
  } catch (err) {
    console.warn("[db] getOtelSummary failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

// ── Phase 4：預算與告警 ──────────────────────────────────────────────

export type BudgetRow = {
  id: number;
  scope: "global" | "app";
  app_id: number | null;
  app_name: string | null;
  label: string | null;
  monthly_limit: number;
  /** 第一段：接近上限。 */
  warn_pct: number;
  /** 第二段：嚴重。必須大於 warn_pct，由資料表約束保證。 */
  critical_pct: number;
  /** 只影響「用哪個數字判定」，不影響要不要算——兩種花費一律都會算出來。 */
  include_gcp: boolean;
  enabled: boolean;
};

/**
 * 一筆預算加上本期實際花費後的判定結果。
 *
 * 兩種花費**一律都算出來**，`include_gcp` 只決定哪一個拿去判定。
 * 初版只算一種，結果是設定完就看不到另一個數字，等於逼使用者為了「換個角度看」
 * 而多開一筆預算——那是把檢視需求誤當成設定需求（2026-08-20 User 指出）。
 */
export type BudgetStatus = BudgetRow & {
  /** 經閘道的花費，逐筆精確。 */
  spendGateway: number;
  /** Vertex 直連的估算花費＝專案總量扣掉經閘道的部分。單一軟體範圍恆為 0，見 gcpAttributable。 */
  spendGcp: number;
  /** 拿來判定的金額：include_gcp 為真時是兩者相加，否則只有閘道那份。 */
  spend: number;
  /** 已用百分比，limit 為 0 時回 0 而不是 Infinity。 */
  pct: number;
  /** 若改用另一種基準會是幾 %，供介面並列顯示。 */
  pctAlt: number;
  level: BudgetLevel;
  /**
   * 這筆預算的花費是否可能涵蓋 Vertex 直連用量。
   * 全域預算可以（直連總額抓得到）；單一軟體不行——GCP 那份目前只到模型層級，
   * 分不出是哪個軟體，硬加會重複計算或算到別人頭上。帳單標籤接上後再放開。
   */
  gcpAttributable: boolean;
};

export type BudgetLevel = "ok" | "warn" | "critical" | "over";

export async function listBudgets(): Promise<BudgetRow[]> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT b.id, b.scope, b.app_id, a.name AS app_name, b.label,
              b.monthly_limit::float8 AS monthly_limit,
              b.warn_pct, b.critical_pct, b.include_gcp, b.enabled
         FROM costscale.budgets b
         LEFT JOIN costscale.apps a ON a.id = b.app_id
        ORDER BY b.scope DESC, a.name NULLS FIRST`
    );
    return rows as BudgetRow[];
  } catch (err) {
    console.warn("[db] listBudgets failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function createBudget(input: {
  scope: "global" | "app";
  appId?: number | null;
  label?: string | null;
  monthlyLimit: number;
  warnPct: number;
  criticalPct: number;
  includeGcp?: boolean;
}): Promise<BudgetRow | null> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `INSERT INTO costscale.budgets
         (scope, app_id, label, monthly_limit, warn_pct, critical_pct, include_gcp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.scope,
        input.scope === "app" ? (input.appId ?? null) : null,
        input.label ?? null,
        input.monthlyLimit,
        input.warnPct,
        input.criticalPct,
        input.includeGcp ?? true,
      ]
    );
    const id = rows[0]?.id as number | undefined;
    if (!id) return null;
    return (await listBudgets()).find((b) => b.id === id) ?? null;
  } catch (err) {
    console.warn("[db] createBudget failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function patchBudget(
  id: number,
  patch: {
    label?: string | null;
    monthlyLimit?: number;
    warnPct?: number;
    criticalPct?: number;
    includeGcp?: boolean;
    enabled?: boolean;
  }
): Promise<BudgetRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.label !== undefined) push("label", patch.label);
  if (patch.monthlyLimit !== undefined) push("monthly_limit", patch.monthlyLimit);
  if (patch.warnPct !== undefined) push("warn_pct", patch.warnPct);
  if (patch.criticalPct !== undefined) push("critical_pct", patch.criticalPct);
  if (patch.includeGcp !== undefined) push("include_gcp", patch.includeGcp);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (!sets.length) return null;
  sets.push("updated_at = now()");

  vals.push(id);
  try {
    const client = getPool();
    await client.query(
      `UPDATE costscale.budgets SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals
    );
    return (await listBudgets()).find((b) => b.id === id) ?? null;
  } catch (err) {
    console.warn("[db] patchBudget failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function deleteBudget(id: number): Promise<boolean> {
  try {
    const client = getPool();
    await client.query(`DELETE FROM costscale.budgets WHERE id = $1`, [id]);
    return true;
  } catch (err) {
    console.warn("[db] deleteBudget failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * 把每筆預算對上本期實際花費。
 *
 * 刻意重用 getUsageSummary／getGcpUsage 而不另寫 SQL：預算判定的數字
 * 必須與儀表板上顯示的數字同源，否則兩處對不起來時無從查起。
 */
/**
 * 閘道自己打掉的 Vertex 花費（LiteLLM 牌價，USD）。
 *
 * 用途是把它從 gcp_usage 的專案總量裡扣掉，才得到真正的「直連」。
 * 2026-08-25 之前預算把兩者直接相加，經閘道的 Vertex 被算了兩次。
 */
async function gatewayVertexSpend(from: Date, to: Date): Promise<number> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(spend), 0)::float8 AS usd
         FROM "LiteLLM_SpendLogs"
        WHERE custom_llm_provider = 'vertex_ai'
          AND "startTime" >= $1 AND "startTime" < $2`,
      [from.toISOString(), to.toISOString()]
    );
    return Number(rows[0]?.usd) || 0;
  } catch (err) {
    // 取不到就回 0：那會讓直連估算偏高（回到舊行為），
    // 比讓整個預算評估掛掉安全。
    console.warn("[db] gatewayVertexSpend failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function evaluateBudgets(from: Date, to: Date): Promise<BudgetStatus[]> {
  const [budgets, summary, apps, gcp, gwVertex] = await Promise.all([
    listBudgets(),
    getUsageSummary(from, to),
    listApps(),
    getGcpUsage(from, to),
    gatewayVertexSpend(from, to),
  ]);
  if (!budgets.length) return [];

  const spendByVkey = new Map(summary.byApiKey.map((r) => [r.apiKey, r.spend]));
  const vkeyByAppId = new Map(
    apps.filter((a) => a.vkey_id).map((a) => [a.id, a.vkey_id as string])
  );

  return budgets.map((b) => {
    const gcpAttributable = b.scope === "global";
    let spendGateway: number;
    if (b.scope === "global") {
      spendGateway = summary.totalSpend;
    } else {
      const vkey = b.app_id != null ? vkeyByAppId.get(b.app_id) : undefined;
      spendGateway = (vkey && spendByVkey.get(vkey)) || 0;
    }
    // gcp.totalEstCost 是 Vertex 專案總量，**含經閘道的那一部分**。
    // 直接跟 spendGateway 相加會把經閘道的 Vertex 算兩次，所以先扣掉。
    // 夾在 0 以上：產圖按張計價，Cloud Monitoring 的 token 估算看不到，
    // 所以閘道記到的金額有可能反而比估算高，那時直連就是 0 不是負數。
    const spendGcp = gcpAttributable ? Math.max(0, gcp.totalEstCost - gwVertex) : 0;

    const spend = b.include_gcp ? spendGateway + spendGcp : spendGateway;
    const spendAlt = b.include_gcp ? spendGateway : spendGateway + spendGcp;

    const limit = Number(b.monthly_limit) || 0;
    const ratio = (v: number) => (limit > 0 ? (v / limit) * 100 : 0);
    const pct = ratio(spend);

    const level: BudgetLevel =
      pct >= 100
        ? "over"
        : pct >= b.critical_pct
          ? "critical"
          : pct >= b.warn_pct
            ? "warn"
            : "ok";

    return { ...b, spendGateway, spendGcp, spend, pct, pctAlt: ratio(spendAlt), level, gcpAttributable };
  });
}

export type BudgetAlertRow = {
  id: number;
  budget_id: number;
  scope: string;
  app_name: string | null;
  label: string | null;
  period: string;
  level: "warn" | "critical" | "over";
  spend_usd: number;
  limit_usd: number;
  pct: number;
  fired_at: Date;
  emailed_at: Date | null;
  email_error: string | null;
};

export async function listRecentAlerts(limit = 20): Promise<BudgetAlertRow[]> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT al.id, al.budget_id, b.scope, a.name AS app_name, b.label,
              to_char(al.period, 'YYYY-MM') AS period, al.level,
              al.spend_usd::float8 AS spend_usd,
              al.limit_usd::float8 AS limit_usd,
              al.pct::float8       AS pct,
              al.fired_at, al.emailed_at, al.email_error
         FROM costscale.budget_alerts al
         JOIN costscale.budgets b ON b.id = al.budget_id
         LEFT JOIN costscale.apps a ON a.id = b.app_id
        ORDER BY al.fired_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows as BudgetAlertRow[];
  } catch (err) {
    console.warn("[db] listRecentAlerts failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Phase 4：報表匯出 ───────────────────────────────────────────────

export type UsageExportRow = {
  day: string;
  source: string;
  app: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  spend_usd: number;
  cost_basis: string;
};

/**
 * 匯出用的逐日明細，合併兩個來源。
 *
 * 兩者的金額性質不同，所以另立 cost_basis 欄標明，不要讓讀報表的人
 * 把估算值當成實際帳單金額加總。
 */
export async function getUsageExportRows(from: Date, to: Date): Promise<UsageExportRow[]> {
  const out: UsageExportRow[] = [];
  const client = getPool();

  try {
    const { rows } = await client.query(
      `SELECT to_char(s."startTime", 'YYYY-MM-DD')      AS day,
              COALESCE(a.name, s.metadata->>'user_api_key_alias', '(未對應)') AS app,
              COALESCE(NULLIF(s.model, ''), '(未知模型)') AS model,
              COUNT(*)::int                             AS calls,
              COALESCE(SUM(s.prompt_tokens), 0)::bigint     AS input_tokens,
              COALESCE(SUM(s.completion_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(s.total_tokens), 0)::bigint      AS total_tokens,
              COALESCE(SUM(s.spend), 0)::float8             AS spend_usd
         FROM "LiteLLM_SpendLogs" s
         LEFT JOIN costscale.apps a ON a.vkey_id = s.api_key
        WHERE s."startTime" >= $1 AND s."startTime" < $2
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3`,
      [from.toISOString(), to.toISOString()]
    );
    for (const r of rows) {
      out.push({
        day: r.day,
        source: "閘道",
        app: r.app,
        model: r.model,
        calls: Number(r.calls),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        total_tokens: Number(r.total_tokens),
        spend_usd: Number(r.spend_usd),
        cost_basis: "閘道實際計價",
      });
    }
  } catch (err) {
    console.warn("[db] export gateway rows failed:", err instanceof Error ? err.message : err);
  }

  try {
    const { rows } = await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day,
              model,
              SUM(invocations)::bigint   AS calls,
              SUM(input_tokens)::bigint  AS input_tokens,
              SUM(output_tokens)::bigint AS output_tokens,
              SUM(tokens)::bigint        AS total_tokens,
              SUM(est_cost)::float8      AS spend_usd
         FROM costscale.gcp_usage
        WHERE day >= $1::date AND day < $2::date
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [taipeiDay(from), taipeiDay(to)]
    );
    for (const r of rows) {
      out.push({
        day: r.day,
        source: "Vertex 用量",
        // GCP 監控只到模型層級，分不出哪個軟體。留空會被誤讀成漏資料，寫明原因。
        app: "(專案總量，含經閘道，未分軟體)",
        model: r.model,
        calls: Number(r.calls),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        total_tokens: Number(r.total_tokens),
        spend_usd: Number(r.spend_usd),
        cost_basis: "依價目表估算",
      });
    }
  } catch (err) {
    console.warn("[db] export gcp rows failed:", err instanceof Error ? err.message : err);
  }

  out.sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source));
  return out;
}

/**
 * 記錄一筆告警。靠 (budget_id, period, level) 的唯一索引做去重，
 * 所以同一筆預算同一個月的同一個等級只會寫入一次——這就是「不重複寄信」
 * 的實作方式，不另外維護狀態。
 *
 * 回傳值刻意區分三種結果。初版把「已經發過」與「寫入失敗」都回 null，
 * 結果是 pct 欄位溢位時整筆告警被無聲吞掉，看起來就像本月已經發過
 * （2026-08-20 實測踩到）。告警機制最不能有的就是這種靜默失敗。
 */
export type RecordAlertResult =
  | { status: "created"; id: number }
  | { status: "duplicate" }
  | { status: "error"; message: string };

export async function recordAlert(input: {
  budgetId: number;
  period: string;
  level: "warn" | "critical" | "over";
  spend: number;
  limit: number;
  pct: number;
}): Promise<RecordAlertResult> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `INSERT INTO costscale.budget_alerts (budget_id, period, level, spend_usd, limit_usd, pct)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (budget_id, period, level) DO NOTHING
       RETURNING id`,
      [input.budgetId, input.period, input.level, input.spend, input.limit, input.pct]
    );
    const id = rows[0]?.id as number | undefined;
    return id ? { status: "created", id } : { status: "duplicate" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[db] recordAlert failed:", message);
    return { status: "error", message };
  }
}

export async function markAlertEmailed(id: number, error?: string): Promise<void> {
  try {
    const client = getPool();
    await client.query(
      `UPDATE costscale.budget_alerts
          SET emailed_at = CASE WHEN $2::text IS NULL THEN now() ELSE NULL END,
              email_error = $2
        WHERE id = $1`,
      [id, error ?? null]
    );
  } catch (err) {
    console.warn("[db] markAlertEmailed failed:", err instanceof Error ? err.message : err);
  }
}

// ── 免費額度計數（金鑰池）──────────────────────────────────────────

export type QuotaPoolRow = {
  id: number;
  model_name: string;
  provider: string;
  key_count: number;
  limit_rpd: number | null;
  limit_tpd: number | null;
  source: "default" | "user";
  enabled: boolean;
  note: string | null;
};

export type QuotaPoolStatus = QuotaPoolRow & {
  /** 今日經閘道**成功**的請求數。失敗的另計於 failedRequests。 */
  usedRequests: number;
  /**
   * 今日失敗的請求數（2026-08-27）。
   * 不併進 usedRequests：免費層的上限算的是「打到供應商的次數」，
   * 而失敗的多數是閘道自己擋掉的、根本沒送出去。
   * 但也不能不顯示——不顯示的話「今天只用了 3 次」會讓人以為一切正常，
   * 實際上可能有幾十次打不出去。
   */
  failedRequests: number;
  /** 今日經閘道的 token 數。 */
  usedTokens: number;
  /** 整池的每日上限＝每把上限 × 把數。未設定上限時為 null。 */
  poolLimitRpd: number | null;
  poolLimitTpd: number | null;
  /** 已用百分比。上限未設定時為 null，介面要顯示「未設定」而不是 0%。 */
  pctRequests: number | null;
  pctTokens: number | null;
  /**
   * 把數的來源（2026-09-12）。gateway＝由閘道設定檔實際掛的金鑰數算出來；
   * manual＝設定檔讀不到，暫用 quota_pools.key_count 的手填值。見 lib/keys.ts 的 applyActualKeyCounts。
   */
  keyCountSource: "gateway" | "manual";
};

/**
 * 金鑰池的今日用量。
 *
 * 兩個必須講清楚的限制：
 * 1. 只計「經本閘道」消耗的量。同一把金鑰若被閘道以外的地方用掉，這裡看不到，
 *    所以這是估算的下限，不是供應商端的實際剩餘。
 * 2. 日界線用的是 Asia/Taipei 的當日，與供應商的額度重設時點不一定一致
 *    （Google AI Studio 是太平洋時間午夜）。跨重設時點時數字會對不上。
 * 兩點都必須顯示在介面上，不能只寫在這裡。
 */
export async function listQuotaPools(): Promise<QuotaPoolStatus[]> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT p.id, p.model_name, p.provider, p.key_count,
              p.limit_rpd, p.limit_tpd, p.source, p.enabled, p.note,
              COALESCE(u.calls, 0)::int     AS used_requests,
              COALESCE(u.failed, 0)::int    AS failed_requests,
              COALESCE(u.tokens, 0)::bigint AS used_tokens
         FROM costscale.quota_pools p
         LEFT JOIN (
           -- 只算成功的請求（2026-08-27）。免費層的上限是「打到供應商的次數」，
           -- 而失敗的請求裡絕大多數根本沒有送到供應商就被閘道自己擋掉了
           -- （實查 236 筆失敗，BadRequest 121、TypeError 13、ProxyException 15、
           -- KeyNotFound 5、Auth 5 都是閘道端產生的）。把它們算進去等於高估消耗。
           -- 但也不能假裝失敗不存在——失敗數另外撈出來顯示在旁邊。
           SELECT model_group,
                  COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'failure') AS calls,
                  COUNT(*) FILTER (WHERE status = 'failure')                AS failed,
                  COALESCE(SUM(total_tokens), 0)  AS tokens
             FROM "LiteLLM_SpendLogs"
            WHERE "startTime" >= date_trunc('day', now() AT TIME ZONE 'Asia/Taipei')
                                 AT TIME ZONE 'Asia/Taipei'
            GROUP BY model_group
         ) u ON u.model_group = p.model_name
        ORDER BY p.id`
    );
    return rows.map((r) => {
      const keyCount = Number(r.key_count) || 1;
      const limitRpd = r.limit_rpd == null ? null : Number(r.limit_rpd);
      const limitTpd = r.limit_tpd == null ? null : Number(r.limit_tpd);
      const poolLimitRpd = limitRpd == null ? null : limitRpd * keyCount;
      const poolLimitTpd = limitTpd == null ? null : limitTpd * keyCount;
      const usedRequests = Number(r.used_requests) || 0;
      const failedRequests = Number(r.failed_requests) || 0;
      const usedTokens = Number(r.used_tokens) || 0;
      return {
        id: r.id,
        model_name: r.model_name,
        provider: r.provider,
        key_count: keyCount,
        keyCountSource: "manual" as const,
        limit_rpd: limitRpd,
        limit_tpd: limitTpd,
        source: r.source,
        enabled: r.enabled,
        note: r.note,
        usedRequests,
        failedRequests,
        usedTokens,
        poolLimitRpd,
        poolLimitTpd,
        pctRequests: poolLimitRpd ? (usedRequests / poolLimitRpd) * 100 : null,
        pctTokens: poolLimitTpd ? (usedTokens / poolLimitTpd) * 100 : null,
      };
    });
  } catch (err) {
    console.warn("[db] listQuotaPools failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function patchQuotaPool(
  id: number,
  patch: {
    keyCount?: number;
    limitRpd?: number | null;
    limitTpd?: number | null;
    enabled?: boolean;
    note?: string | null;
  }
): Promise<QuotaPoolRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.keyCount !== undefined) push("key_count", patch.keyCount);
  if (patch.limitRpd !== undefined) push("limit_rpd", patch.limitRpd);
  if (patch.limitTpd !== undefined) push("limit_tpd", patch.limitTpd);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.note !== undefined) push("note", patch.note);
  if (!sets.length) return null;
  // 使用者一旦動過，就不再是未經確認的預設值。
  sets.push("source = 'user'", "updated_at = now()");

  vals.push(id);
  try {
    const client = getPool();
    const { rows } = await client.query(
      `UPDATE costscale.quota_pools SET ${sets.join(", ")} WHERE id = $${vals.length}
       RETURNING id, model_name, provider, key_count, limit_rpd, limit_tpd, source, enabled, note`,
      vals
    );
    return (rows[0] as QuotaPoolRow) ?? null;
  } catch (err) {
    console.warn("[db] patchQuotaPool failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Phase 3：軟體可用的訂閱 ──────────────────────────────────────

/**
 * 非訂閱模型的萬用比對組合。
 *
 * LiteLLM 的金鑰白名單只有「允許清單」沒有「拒絕清單」，所以要擋訂閱模型，
 * 就得把「其餘全部」明確列出來。用萬用比對而不是逐一列舉，是為了避免
 * 日後閘道新增模型時，沒有重新同步的軟體突然打不通。
 *
 * 2026-08-21 實測這組涵蓋所有既有模型且不會誤中 sub-*：
 *   gemini-3.1-flash-lite、gemini-flash-free、groq-large、openrouter-auto 全放行
 *   sub-claude、sub-gemini、sub-imagegen 擋下
 *
 * 註：`["*"]` 會連 sub-* 一起放行，不可使用。
 */
/**
 * 取不到閘道部署清單時的退路。
 *
 * 2026-08-26 之前這是唯一的來源（全部是萬用樣式）。現在正常情況下
 * 會改用 listGatewayModelNames() 拿實際部署名；只有閘道連不上時才回退到這裡。
 * 退回樣式而不是空陣列是刻意的：空陣列會被 LiteLLM 當成「什麼都不准打」，
 * 一次同步失敗就會讓所有軟體斷線。
 */
export const NON_SUB_MODEL_PATTERNS = [
  "gemini-*",
  "groq-*",
  "openrouter*",
  // 這兩個的部署 2026-08-24 起在 litellm-config.yaml 裡是註解掉的（金鑰無效），
  // 打過去會拿到 400 no healthy deployments。名字留著是刻意的：
  // 之後填了真金鑰、把設定檔的註解拿掉，既有金鑰不必重發就能用。
  "claude-sonnet-paid",
  "gpt-paid",
];

/**
 * Vertex 直通用的萬用樣式。只加給 `vertex_passthrough = true` 的軟體。
 *
 * 直通的模型名是 Google 型錄那一整套，列不完，只能維持萬用。
 * 代價是那個軟體的 /v1/models 會多出上百筆展開的 Vertex 型錄，
 * 所以不需要直通的軟體不要加。
 */
export const VERTEX_PASSTHROUGH_PATTERN = "vertex_ai/*";

/** 一把虛擬金鑰目前的模型設定。直接讀 LiteLLM 自己的資料表，那是唯一的真相。 */
export type KeyModelSetting = {
  /** 允許使用的模型（含訂閱通道與別名本身）。 */
  models: string[];
  /** 這把金鑰專屬的模型對應，例如 { default: "gemini-smart" }。 */
  aliases: Record<string, string>;
};

/**
 * 一次讀多把金鑰的模型設定（2026-09-21）。
 *
 * 為什麼不逐把打 /key/info：軟體一多就是 N 次往返，而這些資料本來就在
 * 同一個資料庫裡，一次查完即可。查不到就回空的，讓畫面顯示「讀不到」，
 * 不要讓整頁掛掉。
 */
export async function getKeyModelSettings(
  vkeyIds: string[]
): Promise<Record<string, KeyModelSetting>> {
  const ids = vkeyIds.filter(Boolean);
  if (ids.length === 0) return {};
  try {
    const client = getPool();
    const { rows } = await client.query<{ token: string; models: string[] | null; aliases: unknown }>(
      `SELECT token, models, aliases FROM "LiteLLM_VerificationToken" WHERE token = ANY($1)`,
      [ids]
    );
    const out: Record<string, KeyModelSetting> = {};
    for (const r of rows) {
      const aliases =
        r.aliases && typeof r.aliases === "object" && !Array.isArray(r.aliases)
          ? (r.aliases as Record<string, string>)
          : {};
      out[r.token] = { models: r.models ?? [], aliases };
    }
    return out;
  } catch (err) {
    console.warn("[db] getKeyModelSettings failed:", err instanceof Error ? err.message : err);
    return {};
  }
}

export type AppSubRow = {
  id: number;
  name: string;
  vkey_id: string | null;
  sub_note: string | null;
  review_at: string | null;
  acl_synced_at: Date | null;
  acl_error: string | null;
  /** 允許使用的訂閱模型，例如 ["sub-claude", "sub-codex"]。 */
  subs: string[];
  /**
   * 是否需要 Vertex 直通。true 才會在白名單裡保留 `vertex_ai/*`。
   * 代價是該軟體的 /v1/models 會多出上百筆展開的 Vertex 型錄，
   * 所以不需要直通的軟體不要開（2026-08-26）。
   */
  vertex_passthrough: boolean;
  /** App Hub 看板上的專案名（資料夾名）。與 name 是兩套命名，必須明填。 */
  board_project_name: string | null;
  /** GCP 帳單 labels 的 client_id 值，可多個——專案改過名時舊標籤仍留在歷史帳單裡。 */
  billing_client_ids: string[] | null;
};

/**
 * 「訂閱橋接」面板的資料源。**只回 active 的軟體**（2026-08-29 加的過濾）。
 *
 * 封存過的軟體金鑰已經撤銷，給它勾訂閱不會有任何作用，卻會出現在面板上
 * 讓人以為設定得動。更實際的問題在「重新同步白名單」：那支路由拿這份清單
 * 逐一打 /key/update，而封存軟體的 token 在閘道上早就不存在，
 * 每一個都會回 404 被算成同步失敗——**封存的軟體累積得越多，
 * 那顆按鈕就越常回報一串假的失敗**，久了就沒人會認真看它的結果。
 */
export async function listAppSubscriptions(): Promise<AppSubRow[]> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT a.id, a.name, a.vkey_id, a.sub_note,
              to_char(a.review_at, 'YYYY-MM-DD') AS review_at,
              a.acl_synced_at, a.acl_error, a.vertex_passthrough,
              a.board_project_name, a.billing_client_ids,
              COALESCE(
                ARRAY_AGG(s.sub_model ORDER BY s.sub_model)
                  FILTER (WHERE s.sub_model IS NOT NULL),
                '{}'
              ) AS subs
         FROM costscale.apps a
         LEFT JOIN costscale.app_subscriptions s ON s.app_id = a.id
        WHERE a.status = 'active'
        GROUP BY a.id
        ORDER BY a.id`
    );
    return rows as AppSubRow[];
  } catch (err) {
    console.warn("[db] listAppSubscriptions failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 整組取代某個軟體的訂閱允許清單。 */
export async function setAppSubscriptions(appId: number, subs: string[]): Promise<boolean> {
  const client = getPool();
  const conn = await client.connect();
  try {
    await conn.query("BEGIN");
    await conn.query(`DELETE FROM costscale.app_subscriptions WHERE app_id = $1`, [appId]);
    for (const s of subs) {
      await conn.query(
        `INSERT INTO costscale.app_subscriptions (app_id, sub_model) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [appId, s]
      );
    }
    // 設定一改，先前的同步就過期了。清掉時間戳讓介面顯示「待同步」，
    // 不要讓使用者以為改完就生效了。
    await conn.query(
      `UPDATE costscale.apps SET acl_synced_at = NULL, acl_error = NULL WHERE id = $1`,
      [appId]
    );
    await conn.query("COMMIT");
    return true;
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.warn("[db] setAppSubscriptions failed:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    conn.release();
  }
}

export async function patchAppMeta(
  appId: number,
  patch: {
    note?: string | null;
    reviewAt?: string | null;
    boardProjectName?: string | null;
    billingClientIds?: string[] | null;
  }
): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.note !== undefined) {
    vals.push(patch.note);
    sets.push(`sub_note = $${vals.length}`);
  }
  if (patch.reviewAt !== undefined) {
    vals.push(patch.reviewAt);
    sets.push(`review_at = $${vals.length}::date`);
  }
  if (patch.boardProjectName !== undefined) {
    vals.push(patch.boardProjectName);
    sets.push(`board_project_name = $${vals.length}`);
  }
  if (patch.billingClientIds !== undefined) {
    vals.push(patch.billingClientIds);
    sets.push(`billing_client_ids = $${vals.length}::text[]`);
  }
  if (!sets.length) return false;
  vals.push(appId);
  try {
    const client = getPool();
    await client.query(
      `UPDATE costscale.apps SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals
    );
    return true;
  } catch (err) {
    console.warn("[db] patchAppMeta failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function markAclSynced(appId: number, error?: string): Promise<void> {
  try {
    const client = getPool();
    await client.query(
      `UPDATE costscale.apps
          SET acl_synced_at = CASE WHEN $2::text IS NULL THEN now() ELSE acl_synced_at END,
              acl_error = $2
        WHERE id = $1`,
      [appId, error ?? null]
    );
  } catch (err) {
    console.warn("[db] markAclSynced failed:", err instanceof Error ? err.message : err);
  }
}

// ── Phase 3：兩種提醒 ────────────────────────────────────────────

export type Reminder = {
  kind: "review" | "billing";
  name: string;
  /** 剩餘天數。負數代表已經過了。 */
  days: number;
  detail: string;
};

/**
 * 到期前一週的提醒，兩種來源：
 *
 * 1. 軟體的訂閱設定複查日（`apps.review_at`）——像換衣間這種
 *    「現在自用、開賣後必須關掉訂閱」的情況，靠人記得不可靠。
 * 2. 年繳訂閱的扣款日——那是唯一一次「不續就要現在決定」的時機，
 *    錯過就再綁一年。月繳不提醒，每月都扣，提醒會變成雜訊。
 */
export async function listReminders(daysAhead = 7): Promise<Reminder[]> {
  const out: Reminder[] = [];
  try {
    const client = getPool();

    const { rows: reviews } = await client.query(
      `SELECT name, review_at,
              (review_at - CURRENT_DATE) AS days
         FROM costscale.apps
        WHERE review_at IS NOT NULL
          AND review_at <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY review_at`,
      [daysAhead]
    );
    for (const r of reviews) {
      out.push({
        kind: "review",
        name: r.name,
        days: Number(r.days),
        detail: "訂閱設定複查日",
      });
    }

    // 年繳的下次扣款日。billing_month/billing_day 組出今年的日期，
    // 已經過了就算明年。
    const { rows: subs } = await client.query(
      `SELECT service, billing_month, billing_day, fee, currency,
              (CASE
                 WHEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, billing_month, billing_day)
                      >= CURRENT_DATE
                 THEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, billing_month, billing_day)
                 ELSE make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, billing_month, billing_day)
               END) AS next_billing
         FROM costscale.subscriptions
        WHERE status = 'active'
          AND billing_cycle = 'yearly'
          AND billing_month IS NOT NULL`
    );
    for (const s of subs) {
      const days = Math.ceil(
        (new Date(s.next_billing).getTime() - Date.now()) / 86400000
      );
      if (days <= daysAhead) {
        out.push({
          kind: "billing",
          name: s.service,
          days,
          detail: `年繳續約，${s.currency} ${Number(s.fee).toLocaleString("zh-TW")}`,
        });
      }
    }
  } catch (err) {
    console.warn("[db] listReminders failed:", err instanceof Error ? err.message : err);
  }
  return out.sort((a, b) => a.days - b.days);
}

// ── Phase 5 A2：專案看板 ──────────────────────────────────────────

export type BoardCycle = { start: string; end: string; note: string };
export type BoardLink = { label: string; url: string };

export type BoardProject = {
  id: string;
  name: string;
  owner: string;
  title: string;
  /** 生效狀態：override 蓋過 status.json，「完成後又有活動」自動回到 in-progress。 */
  status: "planned" | "in-progress" | "done";
  category: string;
  host: string;
  path: string;
  apps: string[];
  links: BoardLink[];
  summary: string;
  cycles: BoardCycle[];
  progress: string;
  notes: string;
  tags: string[];
  updatedAt: string;
  hasStatusFile: boolean;
  source: "github" | "draft" | "pushed";
  url: string;
  lastActivity: string;
  /** 設計中專案距上次程式碼活動的天數，null = 不適用或無資料。 */
  staleDays: number | null;
  /**
   * 本機推送的卡片最後一次收到推送的時間（ISO）。空字串＝從未收到過，
   * 那代表這張卡是在這個欄位加上之前推的，之後只要那台電腦還在推就會補上。
   * 這與 updatedAt 不同：updatedAt 是 status.json 內容自己宣稱的日期，
   * 內容沒改但排程還在推的時候它不會動；last_pushed_at 才看得出「還活著嗎」。
   */
  lastPushedAt: string;
  reactivated: boolean;
  /**
   * 排序用的時間戳（毫秒）。取「這張卡最近一次有動靜」的那個時間。
   *
   * 2026-09-21 修：原本是字串且取 `pushed_at`——但那個欄位的語意是
   * **「這張卡第一次出現的時間」**（push 路由刻意用 COALESCE 保留第一次的值），
   * 於是看板其實是按「卡片建立順序」排的，不是按「誰最近有更新」。
   * User：「專案看板不是有更新的會排在最前面嗎？為何我看他都不會動」。
   *
   * 現在取 updated_at（status.json 寫的內容日期）與 last_pushed_at（實際收到推送的時間）
   * 之中較晚的那個。用數字不用字串：內容日期有的寫 "2026-09-21"、有的寫
   * "2026-09-21T16:30:00+08:00"，字串比大小會讓只寫日期的那張永遠排在同一天有時間的後面。
   */
  sortKey: number;
};

export type BoardData = {
  projects: BoardProject[];
  /** GitHub 快取的最後同步時間。null = 從未同步（GITHUB_TOKEN 未設定時就是這樣）。 */
  githubSyncedAt: Date | null;
  githubRepoCount: number;
};

function boardParsePrefixDate(name: string): string {
  const m = String(name || "").match(/^(\d{2})(\d{2})(\d{2})\b/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * 開發週期與進度說明的推導，語意照搬 App Hub 的 projects.js——
 * A2 的驗收是與線上看板並排比對，任何「順手改進」都會讓比對失敗。
 * 想改的等 A3 寫入功能落地、舊站下線之後再說。
 */
function boardDeriveCycles(
  obj: Record<string, unknown> | null,
  name: string,
  createdAt: string
): BoardCycle[] {
  const cycles = obj?.cycles;
  if (Array.isArray(cycles) && cycles.length) {
    return cycles.map((c: Record<string, unknown>) => ({
      start: String(c?.start ?? ""),
      end: String(c?.end ?? ""),
      note: String(c?.note ?? ""),
    }));
  }
  const start = String(obj?.startDate ?? "") || boardParsePrefixDate(name) || createdAt;
  const end = String(obj?.endDate ?? "");
  if (!start && !end) return [];
  return [{ start, end, note: "" }];
}

function boardDeriveProgress(status: Record<string, unknown> | null): string {
  if (status?.progress) return String(status.progress);
  if (!status) return "";
  const parts: string[] = [];
  const completed = status.completed as string[] | undefined;
  const todo = status.todo as string[] | undefined;
  if (completed?.length) parts.push("已完成：\n" + completed.map((x) => "• " + x).join("\n"));
  if (todo?.length) parts.push("待完成：\n" + todo.map((x) => "• " + x).join("\n"));
  return parts.join("\n\n");
}

/**
 * status.json 的字串陣列欄位（apps、tags）。
 *
 * 部分專案把物件塞進 apps —— `{url,name}`（其實是 links）與 `{name,role}`
 * （其實是技術堆疊）。原本的 `String(s)` 會把它們變成 `[object Object]`，
 * 直接吐進卡片的「開啟」連結。物件一律取 name，取不到就丟掉，
 * 寧可少一個項目也不要吐垃圾字串給小幫手。
 */
function boardStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => {
      if (s === null || s === undefined) return "";
      if (typeof s === "object") {
        const name = (s as Record<string, unknown>).name;
        return typeof name === "string" ? name : "";
      }
      return String(s);
    })
    .filter((s) => s !== "");
}

/**
 * 三欄看板的彙整。資料全部來自 PostgreSQL（A1 遷移的卡片 ＋ A2 的 GitHub 快取），
 * 這個請求不打 GitHub——同步是排程的事，GitHub 掛了看板照常，只是資料舊。
 *
 * 合併規則照搬 App Hub：GitHub 卡與草稿先進，本機推送同名覆蓋（推送最新）。
 */
/**
 * 一組時間字串裡最晚的那個，回毫秒。全部解析不出來就回 0。
 * 日期格式混用（"2026-09-21" 與 "2026-09-21T16:30:00+08:00"）是常態，
 * 所以一律轉成時間戳再比，不要用字串比大小。
 */
function tsOf(...values: (string | null | undefined)[]): number {
  let best = 0;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(String(v));
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

export async function getBoardData(): Promise<BoardData> {
  try {
    const client = getPool();
    const [gh, ov, cards, mapRow] = await Promise.all([
      client.query(
        `SELECT repo, name, description, html_url,
                to_char(repo_created,'YYYY-MM-DD') created, repo_pushed,
                status_json, to_char(last_activity,'YYYY-MM-DD') last_activity, synced_at
           FROM costscale.board_github`
      ),
      client.query(
        `SELECT repo, status, to_char(end_date,'YYYY-MM-DD') end_date
           FROM costscale.board_overrides`
      ),
      client.query(
        `SELECT id, source, name, title, status, category, host, path, summary,
                progress, notes, apps, links, cycles, tags, updated_at, pushed_at,
                last_pushed_at, created_at, raw
           FROM costscale.board_cards`
      ),
      client.query(`SELECT value FROM costscale.settings WHERE key = 'board_category_map'`),
    ]);

    // 分類收斂（2026-08-22 User 核定）：歷史資料的 23 種自創分類在顯示層
    // 對映到受控清單，原始值不動——治理是呈現規則，不是資料改寫。
    // 對照表存在 settings（board_category_map），之後設定頁可調。
    // 表上沒有的值原樣顯示，不硬塞「其他」——新出現的正當分類不該被吃掉。
    let catMap: Record<string, string> = {};
    try {
      catMap = mapRow.rows[0] ? JSON.parse(mapRow.rows[0].value) : {};
    } catch {
      catMap = {};
    }
    const mapCat = (c: string) => catMap[c] ?? c;

    const ovByRepo = new Map(ov.rows.map((r) => [r.repo, r]));
    const now = Date.now();

    const ghProjects: BoardProject[] = gh.rows.map((r) => {
      const sj = (r.status_json ?? null) as Record<string, unknown> | null;
      const override = ovByRepo.get(r.repo);
      let effective = String(sj?.status ?? "planned");
      if (override?.status) effective = override.status;
      if (!["planned", "in-progress", "done"].includes(effective)) effective = "planned";

      const cycles = boardDeriveCycles(sj, r.name, r.created ?? "");
      if (override?.status === "done" && override.end_date && cycles.length) {
        const last = cycles[cycles.length - 1];
        if (!last.end) last.end = override.end_date;
      }

      const lastActivity = r.last_activity ?? "";
      let staleDays: number | null = null;
      let reactivated = false;
      if (effective === "done" && lastActivity) {
        const endDate =
          override?.end_date || (cycles.length ? cycles[cycles.length - 1].end : "") || "";
        if (endDate && new Date(lastActivity) > new Date(endDate + "T23:59:59")) {
          effective = "in-progress";
          reactivated = true;
        }
      }
      if (effective === "in-progress" && lastActivity) {
        staleDays = Math.max(0, Math.floor((now - new Date(lastActivity).getTime()) / 86400000));
      }
      const pushedAt = r.repo_pushed ? new Date(r.repo_pushed).toISOString() : "";
      return {
        id: r.repo,
        name: r.name,
        owner: String(r.repo).split("/")[0] ?? "",
        title: String(sj?.title ?? "") || r.name,
        status: effective as BoardProject["status"],
        category: mapCat(String(sj?.category ?? "")),
        host: String(sj?.host ?? ""),
        path: String(sj?.path ?? ""),
        apps: boardStrArr(sj?.apps),
        links: Array.isArray(sj?.links)
          ? (sj?.links as Record<string, unknown>[]).map((l) => ({
              label: String(l?.label ?? ""),
              url: String(l?.url ?? ""),
            }))
          : [],
        summary: String(sj?.summary ?? "") || r.description || "",
        cycles,
        progress: boardDeriveProgress(sj),
        notes: String(sj?.notes ?? ""),
        tags: boardStrArr(sj?.tags),
        updatedAt: String(sj?.updatedAt ?? ""),
        hasStatusFile: sj !== null,
        source: "github",
        url: r.html_url ?? "",
        lastActivity,
        staleDays,
        reactivated,
        // GitHub 來源的卡不是靠推送進來的，這一欄不適用。
        lastPushedAt: "",
        sortKey: tsOf(lastActivity, pushedAt),
      };
    });

    const cardProjects: BoardProject[] = cards.rows.map((r) => {
      const isDraft = r.source === "draft";
      let staleDays: number | null = null;
      if (!isDraft && r.status === "in-progress" && r.updated_at) {
        const t = Date.parse(r.updated_at);
        if (!Number.isNaN(t)) staleDays = Math.max(0, Math.floor((now - t) / 86400000));
      }
      const pushedAt = r.pushed_at ? new Date(r.pushed_at).toISOString() : "";
      const lastPushedAt = r.last_pushed_at ? new Date(r.last_pushed_at).toISOString() : "";
      const createdAt = r.created_at ? new Date(r.created_at).toISOString() : "";
      return {
        id: r.id,
        name: r.name,
        owner: isDraft ? "" : "本機",
        title: r.title || r.name,
        status: r.status as BoardProject["status"],
        category: mapCat(r.category),
        host: r.host,
        path: r.path,
        apps: boardStrArr(r.apps),
        links: Array.isArray(r.links) ? (r.links as BoardLink[]) : [],
        summary: r.summary,
        cycles: boardDeriveCycles(r.raw as Record<string, unknown>, r.name, createdAt.slice(0, 10)),
        progress: r.progress,
        notes: r.notes,
        tags: boardStrArr(r.tags),
        updatedAt: isDraft ? createdAt.slice(0, 10) : r.updated_at,
        hasStatusFile: !isDraft,
        source: r.source as BoardProject["source"],
        url: "",
        lastActivity: "",
        staleDays,
        reactivated: false,
        lastPushedAt,
        // 「最近有動靜」＝內容日期與最後推送取較晚者。
        // pushed_at 是第一次出現的時間，不能拿來排最近更新（2026-09-21 修）。
        sortKey: tsOf(r.updated_at, lastPushedAt, createdAt),
      };
    });

    // 名稱合併，規則照 projects.js：
    //   1. 草稿與 GitHub 同名時**以 GitHub 為準**（草稿是還沒建 repo 前的占位，
    //      repo 建了就該讓位）——所以草稿只在沒有同名 GitHub 卡時才進。
    //   2. 本機推送同名一律覆蓋（推送最新）。
    // 第一版把草稿放在 GitHub 之後進 Map，同名時草稿反而蓋掉 GitHub，
    // 而看板上真有同名的一組（260622-AIgoodgame），已修正。
    const byName = new Map<string, BoardProject>();
    for (const p of ghProjects) byName.set(p.name, p);
    for (const p of cardProjects.filter((c) => c.source === "draft")) {
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
    for (const p of cardProjects.filter((c) => c.source === "pushed")) byName.set(p.name, p);

    const all = [...byName.values()];
    const rank = (s: string) => (s === "in-progress" ? 0 : s === "planned" ? 1 : 2);
    all.sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return b.sortKey - a.sortKey;
    });

    const syncedAt = gh.rows.length
      ? new Date(Math.max(...gh.rows.map((r) => new Date(r.synced_at).getTime())))
      : null;
    return { projects: all, githubSyncedAt: syncedAt, githubRepoCount: gh.rows.length };
  } catch (err) {
    console.warn(
      "[db] getBoardData failed, degrading to empty board:",
      err instanceof Error ? err.message : err
    );
    return { projects: [], githubSyncedAt: null, githubRepoCount: 0 };
  }
}

// ── D-2：訂閱制 CLI 的逐 session 用量（2026-08-23）─────────────────────
//
// 為什麼與 otel_usage 分開，見 db/init/20-cli-session-usage.sql 的表註解：
// 來源檔給的是「累計值」，用 insert 會愈加愈多，必須以 session 為單位覆寫。

export type CliSessionInput = {
  sessionId: string;
  model: string | null;
  startedAt: string;
  lastEventAt: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /**
   * cacheWriteTokens 之中屬於 1 小時快取的部分（2026-09-10）。
   * Anthropic 的 1 小時寫入是 2 倍輸入價、5 分鐘是 1.25 倍，只記總數會低估。
   * Codex 沒有這個概念，不送就是 0。
   */
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  originator: string | null;
  threadSource: string | null;
  quotaUsedPct: number | null;
  quotaWindowMinutes: number | null;
  quotaResetsAt: string | null;
  planType: string | null;
};

/**
 * 以 (source, session_id) 覆寫。同一批重複送幾次，結果都一樣。
 *
 * 只在「新的累計值比較大」時才覆寫（WHERE total_tokens <= EXCLUDED.total_tokens）：
 * 多台電腦同步同一個 Codex 帳號時，某一台可能拿到還沒寫完的舊檔，
 * 讓數字往回跳比缺一筆更糟——那會讓趨勢圖出現不存在的下降。
 */
export async function upsertCliSessions(
  source: string,
  host: string | null,
  sessions: CliSessionInput[]
): Promise<{ written: number; error: string | null }> {
  if (sessions.length === 0) return { written: 0, error: null };
  const cols = 19;
  const values: unknown[] = [];
  const tuples: string[] = [];
  sessions.forEach((s, i) => {
    const base = i * cols;
    tuples.push(
      `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(", ")})`
    );
    values.push(
      source,
      s.sessionId,
      s.model,
      s.startedAt,
      s.lastEventAt,
      s.inputTokens,
      s.cachedInputTokens,
      s.cacheWriteTokens,
      s.cacheWrite1hTokens ?? 0,
      s.outputTokens,
      s.reasoningTokens,
      s.totalTokens,
      s.originator,
      s.threadSource,
      s.quotaUsedPct,
      s.quotaWindowMinutes,
      s.quotaResetsAt,
      s.planType,
      host
    );
  });

  try {
    const client = getPool();
    const { rowCount } = await client.query(
      `INSERT INTO costscale.cli_session_usage
         (source, session_id, model, started_at, last_event_at,
          input_tokens, cached_input_tokens, cache_write_tokens, cache_write_1h_tokens,
          output_tokens, reasoning_tokens, total_tokens,
          originator, thread_source,
          quota_used_pct, quota_window_minutes, quota_resets_at, plan_type, host)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (source, session_id) DO UPDATE SET
         model = EXCLUDED.model,
         last_event_at = EXCLUDED.last_event_at,
         input_tokens = EXCLUDED.input_tokens,
         cached_input_tokens = EXCLUDED.cached_input_tokens,
         cache_write_tokens = EXCLUDED.cache_write_tokens,
         cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
         output_tokens = EXCLUDED.output_tokens,
         reasoning_tokens = EXCLUDED.reasoning_tokens,
         total_tokens = EXCLUDED.total_tokens,
         originator = EXCLUDED.originator,
         thread_source = EXCLUDED.thread_source,
         quota_used_pct = EXCLUDED.quota_used_pct,
         quota_window_minutes = EXCLUDED.quota_window_minutes,
         quota_resets_at = EXCLUDED.quota_resets_at,
         plan_type = EXCLUDED.plan_type,
         host = EXCLUDED.host,
         updated_at = now()
       WHERE costscale.cli_session_usage.total_tokens <= EXCLUDED.total_tokens`,
      values
    );
    return { written: rowCount ?? 0, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[db] upsertCliSessions failed:", msg);
    return { written: 0, error: msg };
  }
}

export type CliUsageBySource = {
  source: string;
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  lastEventAt: Date | null;
  /** 供應商自己回報的訂閱額度用量，取最近一筆 session 的值。 */
  quotaUsedPct: number | null;
  quotaWindowMinutes: number | null;
  quotaResetsAt: Date | null;
  planType: string | null;
  hosts: string[];
};

export type CliSessionRow = {
  sessionId: string;
  model: string | null;
  originator: string | null;
  threadSource: string | null;
  totalTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  lastEventAt: Date;
};

export type CliUsageSummary = {
  bySource: CliUsageBySource[];
  recent: CliSessionRow[];
  totalTokens: number;
};

/**
 * 三個來源合起來的 token 總量（2026-08-29）。
 *
 * 起因：User 看著總覽的「總 Token」問「這數字對嗎？我每天訂閱都用好用滿，
 * 但它都沒有再變」。數字是對的，但它**只算經過閘道的量**——
 * User 自己開 Claude Code 與 Codex 在用的量根本不經過閘道，
 * 而那才是絕大部分。User 裁決：總覽那格要放「我所有的使用量」。
 *
 * **三個來源的計法本來不一致，這裡先對齊再加。** 不對齊就相加是先前
 * 「總 Token · 訂閱制 CLI」那格的做法，結果是 claude-code 取 input＋output
 * （不含快取）、codex 取 session 檔的 total（含快取）——
 * 兩個標準相加，看起來像 codex 是 claude 的 280 倍，
 * 實際上扣掉快取是 8,262 萬對 4,350 萬，不到 2 倍。
 *
 * 對齊後每個來源都給兩個數：
 *   all      全部送進去的量，**含快取重讀**
 *   cached   其中屬於快取重讀的部分
 * 「實際新內容」就是 all − cached。兩個邊界都要給，只給一個一定會被誤讀
 * （同第七十二節快取節省分析的裁決）。
 */
export type AllSourceTokens = {
  gateway: number;
  claudeAll: number;
  claudeCached: number;
  codexAll: number;
  codexCached: number;
  /** 三個來源的總和，含快取重讀。 */
  all: number;
  /** 扣掉快取重讀之後的量。 */
  fresh: number;
  /** 快取重讀佔 all 的百分比，all 為 0 時是 0。 */
  cachedPct: number;
};

/**
 * 「訂閱省下多少」（2026-08-29）。
 *
 * User 問「之前不是說要設計省了多少錢，那是在哪裡？」——第七十二節做的
 * 「快取的實際影響」回答的是單價，不是金額。真正的「省了多少」要拿
 * **實際用掉的 token × 官方 API 價目 − 訂閱月費**，而那需要一個比價基準，
 * 基準由 User 指定：Claude 一律 Opus 5、ChatGPT 是 terra 與 luna。
 *
 * 三個刻意的取捨，都寫在面板頁尾：
 *   1. OpenAI 用短脈絡價目（長脈絡是兩倍）——往低估的方向錯比較安全。
 *      Claude 4.6 之後官方整個 1M 上下文都是標準價，沒有這個問題（2026-09-10 讀官方頁）。
 *   2. 對不到型號的按 User 指定的一支補算，並把補了多少 token 顯示出來
 *      （2026-08-29 以前是給上下界，User 裁決改成單一數字）。
 *   3. Codex 的 `input_tokens` 已含 `cached_input_tokens`，要相減，
 *      不然快取那一段會被按全價算兩次。
 */
export type SubscriptionSaving = {
  provider: string;
  /** 這期實際用掉的 token，含快取重讀。沒有遙測時是 0。 */
  tokens: number;
  /**
   * 有月費但拿不到 token 的訂閱（例如 Google One／Gemini）。
   *
   * **這種一定要列出來，不能因為算不出來就整列消失。** User 2026-08-29
   * 看到面板時第一句話是「我的訂閱還有 Gemini 阿」——那時它被靜靜濾掉了，
   * 而合計的「省下」把它的月費也一起省略，等於高估。
   * 現在合計的月費含全部訂閱，省下＝有資料的 API 換算 − 全部月費，
   * 算出來偏保守；偏保守可以接受，靜靜漏掉不行。
   */
  noDataReason: string | null;
  /** 若走 API 需付，台幣。 */
  apiTwd: number;
  /** 這期的訂閱月費，台幣。 */
  feeTwd: number;
  /** 型號對不到價目、按 fallback 補算的 token 量。 */
  fallbackTokens: number;
  /** 補算時用的是哪一支型號。 */
  fallbackPricedAs: string | null;
  models: string[];
};

export async function getSubscriptionSavings(
  from: Date,
  to: Date,
  fxRate: number
): Promise<SubscriptionSaving[]> {
  try {
    const client = getPool();
    const [otel, cli] = await Promise.all([
      // Claude Code 2026-09-07 從 otel_usage 換成本機會話紀錄（同 SUB_TOKEN_SOURCE）。
      // 遙測那條同期只收到約四成，兩個面板若各讀各的會互相打架。
      //
      // **這裡不要抄下面 Codex 那段的相減。** Codex 的 input_tokens 含 cached，
      // 要減掉才不會把快取按全價算兩次；Claude 的 input_tokens 與
      // cache_read_input_tokens 是**分開回報**的，減了會把新輸入算成負的。
      client.query(
        `SELECT model,
                COALESCE(SUM(input_tokens),0)        AS input,
                COALESCE(SUM(output_tokens),0)       AS output,
                COALESCE(SUM(cached_input_tokens),0) AS cache_read,
                COALESCE(SUM(cache_write_tokens),0)  AS cache_write,
                COALESCE(SUM(cache_write_1h_tokens),0) AS cache_write_1h
           FROM costscale.cli_session_usage
          WHERE source = 'claude-code-local' AND last_event_at >= $1 AND last_event_at < $2
          GROUP BY model`,
        [from, to]
      ),
      client.query(
        `SELECT model,
                COALESCE(SUM(input_tokens),0)        AS input_total,
                COALESCE(SUM(cached_input_tokens),0) AS cached,
                COALESCE(SUM(cache_write_tokens),0)  AS cache_write,
                COALESCE(SUM(output_tokens),0)       AS output
           FROM costscale.cli_session_usage
          WHERE source = 'codex-cli' AND last_event_at >= $1 AND last_event_at < $2
          GROUP BY model`,
        [from, to]
      ),
    ]);

    const claudeRows: UsageRow[] = otel.rows
      .map((r) => ({
        model: r.model as string | null,
        input: Number(r.input),
        output: Number(r.output),
        cacheRead: Number(r.cache_read),
        cacheWrite: Number(r.cache_write),
        // 寫入總數裡屬於 1 小時快取的部分，計價時按 2 倍輸入價（見 pricing.ts costOf）。
        cacheWrite1h: Number(r.cache_write_1h),
      }))
      .filter((r) => r.input + r.output + r.cacheRead + r.cacheWrite > 0);

    const codexRows: UsageRow[] = cli.rows
      .map((r) => ({
        model: r.model as string | null,
        // input_tokens 含 cached_input_tokens，相減才是「按全價計的新輸入」。
        input: Math.max(0, Number(r.input_total) - Number(r.cached)),
        output: Number(r.output),
        cacheRead: Number(r.cached),
        cacheWrite: Number(r.cache_write),
      }))
      .filter((r) => r.input + r.output + r.cacheRead + r.cacheWrite > 0);

    const subs = await client.query(
      `SELECT service, fee, currency, billing_cycle
         FROM costscale.subscriptions WHERE status = 'active'`
    );

    // 這段期間**實際凍結**的扣款（2026-09-21）。
    //
    // 在這之前這裡一律用「現在的月費」去算任何月份，所以改一次價，
    // 回頭看上個月的比較也會跟著用新價（User 問升級會不會影響舊金額時查出來的）。
    // 月費會變——升級、降級、漲價——而 subscription_charges 存的是
    // 當時真的扣了多少，那才是「那個月的成本」。
    //
    // 人工補的差額（source = 'manual'）一起算進來：它同樣是真的付出去的錢。
    const charged = await client.query(
      `SELECT s.service, COALESCE(SUM(c.amount_twd), 0) AS twd, COUNT(*) AS n
         FROM costscale.subscription_charges c
         JOIN costscale.subscriptions s ON s.id = c.sub_id
        WHERE c.charged_on >= $1::date AND c.charged_on < $2::date
        GROUP BY s.service`,
      [from, to]
    );
    const chargedOf = new Map<string, number>();
    for (const r of charged.rows) chargedOf.set(String(r.service), Number(r.twd) || 0);

    const feeOf = (service: string): number => {
      // 這段期間有實際扣款紀錄就用它——那是當時真的付的錢。
      const actual = chargedOf.get(service);
      if (actual !== undefined && actual > 0) return actual;
      // 沒有就退回現在的月費。看「最近七天」這種不含扣款日的區間會走到這裡，
      // 給的是整月月費——與這個面板一直以來的行為相同（月費不按日拆）。
      const row = subs.rows.find((s) => String(s.service) === service);
      if (!row) return 0;
      const perMonth = monthlyEquivalentFee(Number(row.fee) || 0, String(row.billing_cycle));
      return String(row.currency) === "TWD" ? perMonth : perMonth * fxRate;
    };

    const build = (
      provider: string,
      service: string,
      table: Record<string, ModelPrice>,
      rows: UsageRow[],
      fallbackKey: string
    ): SubscriptionSaving => {
      const eq = toApiEquivalent(table, rows, fallbackKey);
      const tokens = rows.reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
      return {
        provider,
        tokens,
        noDataReason: null,
        apiTwd: (eq.known + eq.fallback) * fxRate,
        feeTwd: feeOf(service),
        fallbackTokens: eq.fallbackTokens,
        fallbackPricedAs: eq.fallbackPricedAs,
        models: [...new Set(rows.map((r) => r.model).filter((m): m is string => !!m))],
      };
    };

    // 補算未知型號用哪一支，由 User 指定（2026-08-29）：
    // Claude 一律 Opus 5；Codex 那些缺 model 欄的 session 按地球 terra 算。
    const measured = [
      build("Claude Code", "Claude", ANTHROPIC_PRICES, claudeRows, "claude-opus-5"),
      build("Codex", "ChatGPT", OPENAI_PRICES, codexRows, "gpt-5.6-terra"),
    ].filter((r) => r.tokens > 0);

    // 有月費但沒有 token 遙測的訂閱。理由逐一寫出來——「沒有數字」與
    // 「數字是零」是兩件事，混在一起會讓人以為那個訂閱沒在用。
    const MEASURED_SERVICES = new Set(["Claude", "ChatGPT"]);
    const NO_DATA_REASON: Record<string, string> = {
      "Google One":
        "Gemini 沒有 token 遙測：本機帳號不得使用 Gemini CLI（IneligibleTierError），" +
        "Antigravity 的 agy 只回報額度百分比、不回報 token，網頁上用更是完全沒有紀錄",
    };
    const unmeasured: SubscriptionSaving[] = subs.rows
      .filter((r) => !MEASURED_SERVICES.has(String(r.service)))
      .map((r) => ({
        provider: String(r.service),
        tokens: 0,
        noDataReason:
          NO_DATA_REASON[String(r.service)] ?? "這個訂閱沒有 token 遙測，換算不出 API 等值",
        apiTwd: 0,
        feeTwd: feeOf(String(r.service)),
        fallbackTokens: 0,
        fallbackPricedAs: null,
        models: [],
      }))
      .filter((r) => r.feeTwd > 0);

    return [...measured, ...unmeasured];
  } catch (err) {
    console.warn("[db] getSubscriptionSavings failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 年繳折成月。與 lib/format 的 monthlyEquivalent 同一套規則，這裡吃字串型別的 cycle。 */
function monthlyEquivalentFee(fee: number, cycle: string): number {
  return cycle === "yearly" ? fee / 12 : fee;
}

export function combineAllSourceTokens(
  gatewayTokens: number,
  cli: CliUsageSummary
): AllSourceTokens {
  // **每一列只取自己的來源**（2026-09-18 User：「codex、claude 的 token 是不是寫錯了」）。
  // 原本兩個錯，實測本月：
  //   1. Codex 取的是 cli.totalTokens——整張 cli_session_usage 的合計。但 9/7 起 Claude Code
  //      本機收集器也寫進這張表（source = claude-code-local），於是「Codex」顯示 276.61 億，
  //      其中 270.78 億其實是 Claude Code，真正的 Codex 只有 5.83 億。
  //   2. Claude Code 還在讀 OTel 遙測（50.87 億）。9/7 已量到遙測只收得到約四成，
  //      其他面板都換成本機收集器，只有這格漏改。
  //
  // 兩個來源的 total_tokens 都已經是「含快取的全部量」，不要再加（2026-09-18 資料庫逐筆驗證）：
  //   claude-code-local：total = input＋output＋cache_read＋cache_write（636／636 筆）
  //   codex-cli：        total = input＋output，而 input 本身含 cached（414／414 筆）
  const src = (name: string) => cli.bySource.find((s) => s.source === name);
  const claude = src("claude-code-local");
  const codex = src("codex-cli");
  const claudeAll = claude?.totalTokens ?? 0;
  const claudeCached = claude?.cachedInputTokens ?? 0;
  const codexAll = codex?.totalTokens ?? 0;
  const codexCached = codex?.cachedInputTokens ?? 0;
  const all = gatewayTokens + claudeAll + codexAll;
  const cached = claudeCached + codexCached;
  return {
    gateway: gatewayTokens,
    claudeAll,
    claudeCached,
    codexAll,
    codexCached,
    all,
    fresh: all - cached,
    cachedPct: all > 0 ? (cached / all) * 100 : 0,
  };
}

const EMPTY_CLI_USAGE: CliUsageSummary = { bySource: [], recent: [], totalTokens: 0 };

/** 期間內有活動（last_event_at 落在範圍內）的 session。 */
export async function getCliUsageSummary(from: Date, to: Date): Promise<CliUsageSummary> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT source, session_id, model, originator, thread_source, host,
              input_tokens, cached_input_tokens, output_tokens,
              reasoning_tokens, total_tokens, last_event_at,
              quota_used_pct, quota_window_minutes, quota_resets_at, plan_type
         FROM costscale.cli_session_usage
        WHERE last_event_at >= $1 AND last_event_at <= $2
        ORDER BY last_event_at DESC`,
      [from, to]
    );

    const bySource = new Map<string, CliUsageBySource>();
    const recent: CliSessionRow[] = [];
    for (const r of rows) {
      const source = String(r.source);
      const lastEventAt = new Date(r.last_event_at as string);
      const cur =
        bySource.get(source) ??
        {
          source,
          sessions: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          lastEventAt: null as Date | null,
          quotaUsedPct: null as number | null,
          quotaWindowMinutes: null as number | null,
          quotaResetsAt: null as Date | null,
          planType: null as string | null,
          hosts: [] as string[],
        };
      cur.sessions += 1;
      cur.inputTokens += Number(r.input_tokens ?? 0);
      cur.cachedInputTokens += Number(r.cached_input_tokens ?? 0);
      cur.outputTokens += Number(r.output_tokens ?? 0);
      cur.reasoningTokens += Number(r.reasoning_tokens ?? 0);
      cur.totalTokens += Number(r.total_tokens ?? 0);
      // rows 已按 last_event_at DESC 排序，所以第一筆就是最新的那一筆額度回報。
      if (!cur.lastEventAt) {
        cur.lastEventAt = lastEventAt;
        cur.quotaUsedPct = r.quota_used_pct == null ? null : Number(r.quota_used_pct);
        cur.quotaWindowMinutes = r.quota_window_minutes == null ? null : Number(r.quota_window_minutes);
        cur.quotaResetsAt = r.quota_resets_at ? new Date(r.quota_resets_at as string) : null;
        cur.planType = r.plan_type ? String(r.plan_type) : null;
      }
      if (r.host && !cur.hosts.includes(String(r.host))) cur.hosts.push(String(r.host));
      bySource.set(source, cur);

      if (recent.length < 15) {
        recent.push({
          sessionId: String(r.session_id),
          model: r.model ? String(r.model) : null,
          originator: r.originator ? String(r.originator) : null,
          threadSource: r.thread_source ? String(r.thread_source) : null,
          totalTokens: Number(r.total_tokens ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          cachedInputTokens: Number(r.cached_input_tokens ?? 0),
          lastEventAt,
        });
      }
    }

    const list = [...bySource.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    return {
      bySource: list,
      recent,
      totalTokens: list.reduce((s, r) => s + r.totalTokens, 0),
    };
  } catch (err) {
    console.warn("[db] getCliUsageSummary failed:", err instanceof Error ? err.message : err);
    return EMPTY_CLI_USAGE;
  }
}

// ── 未歸戶的閘道用量（2026-08-23）───────────────────────────────────
//
// 為什麼要有這一段：getSpendByProject 只走 apps 那張表，任何對不回軟體的
// 請求都被靜靜丟掉。介面上看起來「四個軟體的用量就是全部」，其實不是——
// 實測全期間有 286 次、684,646 tokens 落在四個軟體之外。
// 那些不是漏記的正式流量（是開發驗證），但**看不見**這件事本身就是缺陷：
// 下次真的有東西在偷打，一樣不會有人發現。
//
// 閘道是金鑰認證的，所以身分不是 IP 而是金鑰。已撤銷的金鑰在 /key/list 上
// 早就不存在，但別名還留在 SpendLogs 的 metadata 裡，仍然指認得出來。

export type UnattributedKeyRow = {
  /** 金鑰別名。null 代表 master key（它沒有別名）。 */
  alias: string | null;
  calls: number;
  tokens: number;
  usd: number;
  lastAt: Date | null;
};

export type UnattributedUsage = {
  /** master key 直接打的。 */
  masterKey: { calls: number; tokens: number; usd: number; lastAt: Date | null };
  /** 曾經發出、現在已撤銷的金鑰，依 token 由多到少。 */
  retired: UnattributedKeyRow[];
  totalCalls: number;
  totalTokens: number;
  totalUsd: number;
};

const EMPTY_UNATTRIBUTED: UnattributedUsage = {
  masterKey: { calls: 0, tokens: 0, usd: 0, lastAt: null },
  retired: [],
  totalCalls: 0,
  totalTokens: 0,
  totalUsd: 0,
};

export async function getUnattributedUsage(from: Date, to: Date): Promise<UnattributedUsage> {
  try {
    const client = getPool();
    const { rows } = await client.query(
      `SELECT s.metadata->>'user_api_key_alias'        AS alias,
              count(*)::int                            AS calls,
              COALESCE(SUM(s.total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(s.spend), 0)::float8        AS usd,
              MAX(s."startTime")                       AS last_at
         FROM "LiteLLM_SpendLogs" s
         LEFT JOIN costscale.apps a
                ON a.vkey_id = s.api_key
                OR s.api_key = ANY(a.retired_vkey_ids)
        WHERE a.id IS NULL
          AND s."startTime" >= $1 AND s."startTime" < $2
        GROUP BY 1
        ORDER BY tokens DESC`,
      [from.toISOString(), to.toISOString()]
    );

    const out: UnattributedUsage = {
      masterKey: { calls: 0, tokens: 0, usd: 0, lastAt: null },
      retired: [],
      totalCalls: 0,
      totalTokens: 0,
      totalUsd: 0,
    };
    for (const r of rows) {
      const calls = Number(r.calls) || 0;
      const tokens = Number(r.tokens) || 0;
      const usd = Number(r.usd) || 0;
      const lastAt = r.last_at ? new Date(r.last_at as string) : null;
      out.totalCalls += calls;
      out.totalTokens += tokens;
      out.totalUsd += usd;
      if (r.alias == null) {
        out.masterKey = { calls, tokens, usd, lastAt };
      } else {
        out.retired.push({ alias: String(r.alias), calls, tokens, usd, lastAt });
      }
    }
    return out;
  } catch (err) {
    console.warn("[db] getUnattributedUsage failed:", err instanceof Error ? err.message : err);
    return EMPTY_UNATTRIBUTED;
  }
}

// ── D-10／D-11：Vertex 三套數字的對帳 ──

/**
 * 帳單裡沒有 client_id 標籤時，抓取程式填的哨兵值。
 * 見 scripts/fetch-billing-bq.py 的 UNLABELED。
 */
const BILLING_UNLABELED = "(未標示)";

export type VertexReconciliation = {
  /** Vertex 帳單實際補到哪一天。帳單匯出有一到兩天延遲。 */
  billThroughDay: string | null;
  /** 對帳實際採用的期間。訖日被帳單水位裁切過，才不會拿半個月比一個月。 */
  windowFrom: string;
  windowTo: string;
  /** 期間內是否完全沒有帳單資料 */
  empty: boolean;
  billGross: number;
  billCredit: number;
  billNet: number;
  /** 帳單裡未標示的部分。實測等於閘道自己打出去的量。 */
  billUnlabeled: number;
  /** 有標籤的部分＝沒有經過閘道的直連，依 client 拆開 */
  direct: { clientId: string; gross: number }[];
  /** 閘道自己記的 Vertex 牌價與 token，同一期間 */
  gatewayUsd: number;
  gatewayTokens: number;
  /** Cloud Monitoring 記到的 Vertex 總 token，**含**經過閘道的那一部分 */
  vertexTokens: number;
  /**
   * 對帳子視窗：只取「閘道當天有記到 Vertex 花費」的日子。
   *
   * 閘道 2026-08-18 才開始記 Vertex，在那之前帳單上的「未標示」是別的東西
   * （還沒貼標籤的直連）。整月一起除會反推出 54 這種不存在的匯率。
   * 兩端都是 null 代表本期沒有任何一天兩邊都有資料。
   */
  fxWindowFrom: string | null;
  fxWindowTo: string | null;
  /**
   * 由「帳單未標示 ÷ 閘道牌價」反推的 GCP 換匯率，只算對帳子視窗。
   * 分母為零時是 null——沒有除法可做，不要補 0。
   */
  impliedFx: number | null;
  /** 對帳子視窗內的閘道 token 與 Vertex 總 token */
  fxWindowGatewayTokens: number;
  fxWindowVertexTokens: number;
  /** 閘道涵蓋率，只算對帳子視窗。分母為零時 null。 */
  gatewayTokenShare: number | null;
};

const EMPTY_VERTEX_RECON: VertexReconciliation = {
  billThroughDay: null, windowFrom: "", windowTo: "", empty: true,
  billGross: 0, billCredit: 0, billNet: 0, billUnlabeled: 0, direct: [],
  gatewayUsd: 0, gatewayTokens: 0, vertexTokens: 0,
  fxWindowFrom: null, fxWindowTo: null, impliedFx: null,
  fxWindowGatewayTokens: 0, fxWindowVertexTokens: 0, gatewayTokenShare: null,
};

/**
 * 把 Vertex 的三套成本數字放在同一個期間裡對帳。
 *
 * 三套是：GCP 帳單（Google 實際計價）、閘道牌價（LiteLLM 自己算的）、
 * Cloud Monitoring 的 token 計量（專案總量）。2026-08-25 實測的對應關係：
 *
 *   帳單「未標示」 ÷ 閘道牌價 = 32.375（連續四天誤差 0.01%）
 *
 * 也就是說閘道牌價不是帳單的近似值，**它就是帳單的 gross**，
 * 差別只在抵免。而帳單上有標籤的那些 client 就是沒走閘道的直連。
 *
 * 期間的訖日一律被帳單水位裁切：拿補到一半的帳單跟完整的閘道紀錄比，
 * 會得到「閘道比帳單貴」這種假結論。
 */
export async function getVertexReconciliation(
  from: Date,
  to: Date
): Promise<VertexReconciliation> {
  try {
    const client = getPool();
    const fromDay = taipeiDay(from);
    // to 是半開區間的「不含」端（站上通用慣例，見 lib/range.ts），
    // 這個函式底下的查詢用的是 <= 的「含」端，所以要往回一天。
    // 不轉的話八月的視窗會把九月一號也算進來。
    const toDay = taipeiDay(new Date(to.getTime() - 86_400_000));

    const { rows: stateRows } = await client.query(
      `SELECT MAX(day)::text AS through FROM costscale.billing_daily WHERE source = 'vertex'`
    );
    const billThroughDay: string | null = stateRows[0]?.through ?? null;
    if (!billThroughDay) return { ...EMPTY_VERTEX_RECON, windowFrom: fromDay, windowTo: toDay };

    // 訖日取「本期結束」與「帳單補到哪」兩者較小的那個。
    const windowTo = billThroughDay < toDay ? billThroughDay : toDay;
    if (windowTo < fromDay) {
      return { ...EMPTY_VERTEX_RECON, billThroughDay, windowFrom: fromDay, windowTo };
    }

    const [bill, gateway, monitoring, fxWindow] = await Promise.all([
      client.query(
        `SELECT client_id,
                SUM(gross)::float8  AS gross,
                SUM(credit)::float8 AS credit,
                SUM(net)::float8    AS net
           FROM costscale.billing_daily
          WHERE source = 'vertex' AND service = 'Vertex AI'
            AND day >= $1::date AND day <= $2::date
          GROUP BY client_id
          ORDER BY SUM(gross) DESC`,
        [fromDay, windowTo]
      ),
      client.query(
        `SELECT COALESCE(SUM(spend), 0)::float8         AS usd,
                COALESCE(SUM(total_tokens), 0)::bigint  AS tokens
           FROM "LiteLLM_SpendLogs"
          WHERE custom_llm_provider = 'vertex_ai'
            -- startTime 是 UTC；日期是台北日，所以日界線往前推 8 小時
            AND "startTime" >= ($1::date - interval '8 hours')
            AND "startTime" < ($2::date + 1 - interval '8 hours')`,
        [fromDay, windowTo]
      ),
      client.query(
        `SELECT COALESCE(SUM(tokens), 0)::bigint AS tokens
           FROM costscale.gcp_usage
          WHERE day >= $1::date AND day <= $2::date`,
        [fromDay, windowTo]
      ),
      // 對帳子視窗：只取閘道當天真的有記到 Vertex 花費的日子，
      // 三份資料都在同一組日子上取，反推的匯率與涵蓋率才有意義。
      client.query(
        `WITH gw AS (
           SELECT ("startTime")::date            AS d,
                  SUM(spend)::float8             AS usd,
                  SUM(total_tokens)::bigint      AS tokens
             FROM "LiteLLM_SpendLogs"
            WHERE custom_llm_provider = 'vertex_ai'
              AND "startTime" >= $1::date AND "startTime" < ($2::date + 1)
            GROUP BY 1
           HAVING SUM(spend) > 0
         ), ul AS (
           SELECT day AS d, SUM(gross)::float8 AS unlabeled
             FROM costscale.billing_daily
            WHERE source = 'vertex' AND service = 'Vertex AI'
              AND client_id = $3
              AND day >= $1::date AND day <= $2::date
            GROUP BY 1
         ), mon AS (
           SELECT day AS d, SUM(tokens)::bigint AS tokens
             FROM costscale.gcp_usage
            WHERE day >= $1::date AND day <= $2::date
            GROUP BY 1
         )
         SELECT MIN(gw.d)::text                        AS from_day,
                MAX(gw.d)::text                        AS to_day,
                COALESCE(SUM(ul.unlabeled), 0)::float8 AS unlabeled,
                COALESCE(SUM(gw.usd), 0)::float8       AS usd,
                COALESCE(SUM(gw.tokens), 0)::bigint    AS gw_tokens,
                COALESCE(SUM(mon.tokens), 0)::bigint   AS mon_tokens
           FROM gw
           JOIN ul  ON ul.d  = gw.d
           LEFT JOIN mon ON mon.d = gw.d`,
        [fromDay, windowTo, BILLING_UNLABELED]
      ),
    ]);

    let billGross = 0, billCredit = 0, billNet = 0, billUnlabeled = 0;
    const direct: { clientId: string; gross: number }[] = [];
    for (const r of bill.rows) {
      const gross = Number(r.gross) || 0;
      billGross += gross;
      billCredit += Number(r.credit) || 0;
      billNet += Number(r.net) || 0;
      if (r.client_id === BILLING_UNLABELED) billUnlabeled += gross;
      else if (gross > 0) direct.push({ clientId: String(r.client_id), gross });
    }

    const gatewayUsd = Number(gateway.rows[0]?.usd) || 0;
    const gatewayTokens = Number(gateway.rows[0]?.tokens) || 0;
    const vertexTokens = Number(monitoring.rows[0]?.tokens) || 0;

    const fx = fxWindow.rows[0];
    const fxUsd = Number(fx?.usd) || 0;
    const fxUnlabeled = Number(fx?.unlabeled) || 0;
    const fxGwTokens = Number(fx?.gw_tokens) || 0;
    const fxMonTokens = Number(fx?.mon_tokens) || 0;

    return {
      billThroughDay,
      windowFrom: fromDay,
      windowTo,
      empty: bill.rows.length === 0,
      billGross, billCredit, billNet, billUnlabeled, direct,
      gatewayUsd, gatewayTokens, vertexTokens,
      fxWindowFrom: fx?.from_day ?? null,
      fxWindowTo: fx?.to_day ?? null,
      impliedFx: fxUsd > 0 ? fxUnlabeled / fxUsd : null,
      fxWindowGatewayTokens: fxGwTokens,
      fxWindowVertexTokens: fxMonTokens,
      gatewayTokenShare: fxMonTokens > 0 ? fxGwTokens / fxMonTokens : null,
    };
  } catch (err) {
    console.warn(
      "[db] getVertexReconciliation failed:",
      err instanceof Error ? err.message : err
    );
    return EMPTY_VERTEX_RECON;
  }
}

// ── 軟體的每月硬上限（2026-09-10）────────────────────────────────────
//
// 真正擋請求的是 LiteLLM（虛擬金鑰的 max_budget），這裡只負責
// 「使用者設了多少」與「閘道那邊現在是什麼狀態」。
// 閘道的金鑰表跟這個儀表板在同一個資料庫，直接 join，不另外打 API。

export type AppLimit = {
  appId: number;
  /** 使用者設的每月上限，美元。null＝不設限。 */
  hardLimitUsd: number | null;
  /** 閘道上這把金鑰現在的計數——LiteLLM 拿**這個**跟 max_budget 比。 */
  keySpendUsd: number | null;
  /** 閘道上實際生效的上限。應該等於 hardLimitUsd，不等就是沒套上。 */
  keyMaxBudgetUsd: number | null;
  /** 下一次歸零時間。 */
  budgetResetAt: string | null;
};

export async function listAppLimits(): Promise<AppLimit[]> {
  try {
    const client = getPool();
    const result = await client.query(
      // budget_reset_at 是不帶時區的 timestamp、內容是 UTC。在 SQL 裡先轉成 timestamptz，
      // 不讓 node 用容器時區去猜——賣給別人時容器不一定是 UTC。
      `SELECT a.id, a.hard_limit_usd, t.spend, t.max_budget,
              (t.budget_reset_at AT TIME ZONE 'UTC') AS budget_reset_at
         FROM costscale.apps a
         LEFT JOIN "LiteLLM_VerificationToken" t ON t.token = a.vkey_id
        WHERE a.status = 'active'`
    );
    return result.rows.map((r) => ({
      appId: Number(r.id),
      hardLimitUsd: r.hard_limit_usd == null ? null : Number(r.hard_limit_usd),
      keySpendUsd: r.spend == null ? null : Number(r.spend),
      keyMaxBudgetUsd: r.max_budget == null ? null : Number(r.max_budget),
      budgetResetAt: r.budget_reset_at ? new Date(r.budget_reset_at).toISOString() : null,
    }));
  } catch (err) {
    console.warn("[db] listAppLimits failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export type AppForLimit = {
  id: number;
  name: string;
  status: string;
  vkey_id: string | null;
  retired_vkey_ids: string[];
  hard_limit_usd: number | null;
};

export async function getAppForLimit(appId: number): Promise<AppForLimit | null> {
  try {
    const client = getPool();
    const result = await client.query(
      `SELECT id, name, status, vkey_id, COALESCE(retired_vkey_ids, '{}') AS retired_vkey_ids, hard_limit_usd
         FROM costscale.apps WHERE id = $1`,
      [appId]
    );
    const r = result.rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      name: String(r.name),
      status: String(r.status),
      vkey_id: r.vkey_id ?? null,
      retired_vkey_ids: r.retired_vkey_ids ?? [],
      hard_limit_usd: r.hard_limit_usd == null ? null : Number(r.hard_limit_usd),
    };
  } catch (err) {
    console.warn("[db] getAppForLimit failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function setAppHardLimitUsd(appId: number, usd: number | null): Promise<boolean> {
  try {
    const client = getPool();
    const { rowCount } = await client.query(
      `UPDATE costscale.apps SET hard_limit_usd = $2 WHERE id = $1`,
      [appId, usd]
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.warn("[db] setAppHardLimitUsd failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** 閘道算出來的下一次歸零時間。讀不到回 null，呼叫方要當成錯誤處理。 */
export async function getKeyBudgetResetAt(vkey: string): Promise<Date | null> {
  try {
    const client = getPool();
    const result = await client.query(
      `SELECT (budget_reset_at AT TIME ZONE 'UTC') AS budget_reset_at
         FROM "LiteLLM_VerificationToken" WHERE token = $1`,
      [vkey]
    );
    const v = result.rows[0]?.budget_reset_at;
    return v ? new Date(v) : null;
  } catch (err) {
    console.warn("[db] getKeyBudgetResetAt failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 一組金鑰從某個時間點起經閘道花了多少（美元）。
 * 要連舊金鑰一起算：月中換過鑰的軟體，本月花費有一部分記在舊金鑰上。
 * 查詢失敗回 null——**不能回 0**，0 會被當成「本期沒花錢」寫進閘道的計數。
 */
export async function spendOfKeysSince(vkeys: string[], since: Date): Promise<number | null> {
  if (vkeys.length === 0) return 0;
  try {
    const client = getPool();
    const result = await client.query(
      `SELECT COALESCE(SUM("spend"), 0)::float8 AS s
         FROM "LiteLLM_SpendLogs"
        WHERE "api_key" = ANY($1)
          AND "startTime" >= ($2::timestamptz AT TIME ZONE 'UTC')`,
      [vkeys, since.toISOString()]
    );
    return Number(result.rows[0]?.s ?? 0);
  } catch (err) {
    console.warn("[db] spendOfKeysSince failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

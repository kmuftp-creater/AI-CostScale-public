/**
 * 上手清單的訊號查詢（只讀，不寫入任何東西）。
 *
 * 四個訊號各自獨立查詢、各自降級：任何一個丟例外或逾時，那一步變成「無法確認」，
 * 其餘照常，整個總覽頁不會因此掛掉。判斷邏輯在 onboarding-core.ts。
 *
 *   1. 金鑰管理頁用的上游金鑰盤點（設定檔 ＋ 主機端寫的尾 4 碼表）。
 *      尾碼是 "lder"（placeholder 的尾 4 碼）或空字串的，視為還沒填。
 *   2. costscale.apps 啟用中且有虛擬金鑰的列數。
 *   3. LiteLLM_SpendLogs 裡 api_key 屬於這些軟體（含換掉的舊金鑰）、且 status 成功的筆數。
 *   4. costscale.fx_rates 最新一筆 fetched_at 距今小時數（用資料庫的時鐘算）。
 */
import { getPool } from "@/lib/db";
import { getKeyInventory } from "@/lib/keys";
import {
  evaluateOnboarding,
  summarizeProviderKeys,
  type OnboardingResult,
  type OnboardingSignals,
  type Probe,
} from "@/lib/onboarding-core";

export type { OnboardingResult } from "@/lib/onboarding-core";

/** 單一訊號最多等幾毫秒。閘道掛住時總覽頁最多多等這麼久，而不是 8 秒乘以好幾次。 */
const PROBE_TIMEOUT_MS = 5_000;

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("查詢逾時")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readProviderKeys() {
  return summarizeProviderKeys(await getKeyInventory());
}

async function readAppCount(): Promise<number> {
  const r = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM costscale.apps WHERE status = 'active' AND vkey_id IS NOT NULL`
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function readSuccessCalls(): Promise<number> {
  try {
    const r = await getPool().query(
      `SELECT COUNT(*)::int AS n
         FROM "LiteLLM_SpendLogs" s
        WHERE COALESCE(s.status, 'success') = 'success'
          AND s.api_key IN (
            SELECT vkey_id FROM costscale.apps WHERE vkey_id IS NOT NULL
            UNION
            SELECT unnest(retired_vkey_ids) FROM costscale.apps
          )`
    );
    return Number(r.rows[0]?.n ?? 0);
  } catch (err) {
    // 閘道第一次收到請求時才會建 LiteLLM_SpendLogs。表不存在（42P01）就是「還沒有任何請求」，
    // 是明確的未完成，不是查詢失敗。
    if ((err as { code?: string })?.code === "42P01") return 0;
    throw err;
  }
}

async function readFxAgeHours(): Promise<number | null> {
  const r = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM (now() - MAX(fetched_at))) / 3600 AS age_h FROM costscale.fx_rates`
  );
  const v = r.rows[0]?.age_h;
  return v === null || v === undefined ? null : Number(v);
}

/** 對外入口。保證不丟例外：最壞的結果是四步都「無法確認」。 */
export async function getOnboarding(): Promise<OnboardingResult> {
  const [providerKeys, appCount, successCalls, fxAgeHours] = await Promise.all([
    probe(readProviderKeys),
    probe(readAppCount),
    probe(readSuccessCalls),
    probe(readFxAgeHours),
  ]);
  const signals: OnboardingSignals = { providerKeys, appCount, successCalls, fxAgeHours };
  const gatewayUrl = (process.env.GATEWAY_PUBLIC_URL || "https://llm.example.com").replace(/\/+$/, "");
  for (const [name, p] of Object.entries(signals)) {
    if (!p.ok) console.warn(`[onboarding] ${name} 查詢失敗：${p.error}`);
  }
  return evaluateOnboarding(signals, { gatewayUrl });
}

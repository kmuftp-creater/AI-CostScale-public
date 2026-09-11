import { getKeyBudgetResetAt, spendOfKeysSince } from "@/lib/db";
import { setKeyMonthlyBudget, setKeySpend } from "@/lib/litellm";

/**
 * 把「每月硬上限」套到一把虛擬金鑰上（2026-09-10）。
 *
 * User 裁決：超過就拒絕。執行的是 LiteLLM——金鑰的 max_budget 一旦被計數追上，
 * 閘道直接回錯誤、不轉發給供應商。這支只負責把閘道設成正確的狀態。
 *
 * ## 為什麼不能只設 max_budget
 *
 * 金鑰上的 `spend` 計數是**從建立那天起的累計**。直接設一個每月上限，
 * 閘道拿累計去比，會把本月才花幾毛的軟體當場擋掉。所以順序是：
 *
 *   1. 設 max_budget 與 budget_duration=1mo
 *   2. 讀回閘道算出來的 budget_reset_at（下個月初）
 *   3. 往前推一個月＝本期起點
 *   4. 從 SpendLogs 加總本期實際花費（含換鑰前的舊金鑰）
 *   5. 把計數改寫成這個數字
 *
 * 本期起點用「讀回 reset_at 再往前推」而不是自己算月初：閘道用哪個時區
 * 決定月初是幾點，這樣不管它設哪個時區都對得上，不必兩邊各記一份。
 *
 * ## 失敗時
 *
 * 第 1 步成功、後面任何一步失敗，金鑰會停在「有上限、計數卻是累計」的狀態，
 * 最壞會把一個正常的軟體擋掉。所以失敗時把上限還原成 previousUsd，再往外丟錯誤。
 */
export async function applyHardLimit(params: {
  vkey: string;
  /** 同一個軟體換鑰前的舊金鑰。本期花費要連它們一起算。 */
  retiredVkeys: string[];
  usd: number | null;
  /** 失敗時要還原成的值（套用前的上限）。 */
  previousUsd: number | null;
}): Promise<{ periodStart: Date | null; resetAt: Date | null; seededSpendUsd: number | null }> {
  const { vkey, retiredVkeys, usd, previousUsd } = params;

  if (usd == null) {
    await setKeyMonthlyBudget({ key: vkey, maxBudgetUsd: null });
    return { periodStart: null, resetAt: null, seededSpendUsd: null };
  }

  await setKeyMonthlyBudget({ key: vkey, maxBudgetUsd: usd });
  try {
    const resetAt = await getKeyBudgetResetAt(vkey);
    if (!resetAt) throw new Error("閘道設了上限，但沒有回報歸零時間（budget_reset_at 是空的）");

    const periodStart = previousMonthBoundary(resetAt);
    const spend = await spendOfKeysSince([vkey, ...retiredVkeys], periodStart);
    if (spend == null) throw new Error("讀不到本期花費（LiteLLM_SpendLogs 查詢失敗）");

    await setKeySpend(vkey, Math.round(spend * 1e6) / 1e6);
    return { periodStart, resetAt, seededSpendUsd: spend };
  } catch (err) {
    let rollback = "上限已還原成套用前的狀態。";
    try {
      await setKeyMonthlyBudget({ key: vkey, maxBudgetUsd: previousUsd });
    } catch (e2) {
      rollback = `**還原也失敗了，要人工處理**：${e2 instanceof Error ? e2.message : String(e2)}`;
    }
    throw new Error(`${err instanceof Error ? err.message : String(err)}　${rollback}`);
  }
}

/**
 * 由「下一次歸零時間」推回「本期起點」＝上一個月的同一個邊界。
 *
 * 不能直接 setUTCMonth(-1)：閘道若設成台北時區，月初是前一天 16:00Z，
 * 「9 月 30 日 16:00Z 往前一個月」會算成 8 月 30 日，而正確答案是 8 月 31 日。
 * 所以先找出邊界相對於 UTC 月初的位移，再套到上一個月的 UTC 月初上。
 * 位移在 ±12 小時內都成立（涵蓋所有實際時區）。
 */
export function previousMonthBoundary(resetAt: Date): Date {
  const shifted = new Date(resetAt.getTime() + 12 * 3600_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const offsetMs = resetAt.getTime() - Date.UTC(y, m, 1);
  return new Date(Date.UTC(y, m - 1, 1) + offsetMs);
}

/**
 * 頁首日期選單的區間解析（2026-08-26）。
 *
 * 站上所有查詢的慣例是**半開區間** `[from, to)`——`to` 是「不包含的那一天」。
 * `monthRange(0)` 回傳的 `to` 就是下個月一號。這裡一律沿用同一個慣例，
 * 顯示用的「到哪一天」另外給 `toDay`，兩者不要混用：
 * 混用的下場是靜靜多算一天，而且總額看起來仍然很合理。
 *
 * 網址參數：
 *   （無）              本月
 *   ?range=last        上月
 *   ?from=&to=         自訂，兩端都是「包含」的日期（使用者的直覺）
 *
 * 自訂參數不合法時**退回本月並把原因帶出去**，不要靜靜當作沒填——
 * 使用者手改網址打錯字時，看到「本月」而沒有任何提示會以為是自己記錯。
 */

export type RangeMode = "this" | "last" | "custom";

export type ResolvedRange = {
  /** 查詢用的起（含），ISO 字串 */
  from: string;
  /** 查詢用的訖（**不含**），ISO 字串 */
  to: string;
  /** 顯示用的起日 YYYY-MM-DD（含） */
  fromDay: string;
  /** 顯示用的訖日 YYYY-MM-DD（**含**） */
  toDay: string;
  mode: RangeMode;
  /** 給面板標題用的短標籤 */
  label: string;
  /** 自訂參數被拒絕的原因，沒有問題時是 null */
  invalid: string | null;
};

/** 自訂區間的上限。超過就拒絕——不是效能問題，是「一年以上的比較沒有意義」。 */
const MAX_DAYS = 366;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 台北與 UTC 的時差。台灣沒有日光節約，固定 +8。 */
const TPE_MS = 8 * 3_600_000;

/**
 * 某個時間點在台北是哪一天（YYYY-MM-DD）。
 * 拿區間去比「只存日期」的欄位（GCP 帳單的 day）時一律用這個，
 * 不要用 toISOString().slice(0, 10)——台北月初是前一天 16:00Z，那樣會取到上個月的最後一天。
 */
export function taipeiDay(d: Date): string {
  return new Date(d.getTime() + TPE_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 解讀成**台北**的那一天 00:00。 */
function taipeiMidnight(iso: string): Date | null {
  if (!DATE_RE.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  // 擋掉 2026-02-31 這種：格式對、值不對，Date 會自己進位到 3 月。
  if (taipeiDay(d) !== iso) return null;
  return d;
}

/**
 * 月份邊界＝**台北**的每月 1 日 00:00（2026-09-12 起）。
 *
 * 原本是 UTC 月份，台北要到每月 1 日 08:00 才換月。User 在大屏上看到 app-a
 * 台北 9/1 凌晨的 99 次呼叫被算進 8 月、顯示「閒置」，裁決改成台北時間。
 * 閘道那一端同步設了 litellm_settings.timezone: Asia/Taipei，每月硬上限在同一個時點歸零。
 */
function monthBounds(offset: number): { start: Date; end: Date } {
  const tp = new Date(Date.now() + TPE_MS);
  return {
    start: new Date(Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth() + offset, 1) - TPE_MS),
    end: new Date(Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth() + offset + 1, 1) - TPE_MS),
  };
}

function build(start: Date, end: Date, mode: RangeMode, label: string, invalid: string | null): ResolvedRange {
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    fromDay: taipeiDay(start),
    // end 是不含的那一天，往回一天才是顯示用的「到」。
    toDay: taipeiDay(new Date(end.getTime() - DAY_MS)),
    mode,
    label,
    invalid,
  };
}

function monthRangeResolved(offset: number, invalid: string | null): ResolvedRange {
  const { start, end } = monthBounds(offset);
  return build(start, end, offset === 0 ? "this" : "last", offset === 0 ? "本月" : "上月", invalid);
}

export function resolveRange(sp: {
  range?: string;
  from?: string;
  to?: string;
}): ResolvedRange {
  const rawFrom = (sp.from ?? "").trim();
  const rawTo = (sp.to ?? "").trim();

  if (rawFrom || rawTo) {
    const f = taipeiMidnight(rawFrom);
    const t = taipeiMidnight(rawTo);
    if (!f || !t) {
      return monthRangeResolved(0, "自訂區間的日期格式不正確（需要 YYYY-MM-DD），已顯示本月");
    }
    if (t.getTime() < f.getTime()) {
      return monthRangeResolved(0, "自訂區間的結束日早於開始日，已顯示本月");
    }
    const days = Math.round((t.getTime() - f.getTime()) / DAY_MS) + 1;
    if (days > MAX_DAYS) {
      return monthRangeResolved(0, `自訂區間超過 ${MAX_DAYS} 天（給了 ${days} 天），已顯示本月`);
    }
    // 使用者給的 to 是「包含」的，轉成查詢用的「不含」要 +1 天。
    const end = new Date(t.getTime() + DAY_MS);
    return build(f, end, "custom", `${rawFrom} 至 ${rawTo}`, null);
  }

  return monthRangeResolved(sp.range === "last" ? -1 : 0, null);
}

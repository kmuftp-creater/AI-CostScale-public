export function formatUsd(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatTwd(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/**
 * 中文讀法的 token 數（2026-08-29）。
 *
 * 起因：總覽那格只有 `2.8M`，User 說「教學生時要有震撼感」。
 * `5.41B` 對中文讀者要先在腦裡換一次算，`54.1 億` 不用。
 *
 * 中文數字是**萬進位**不是千進位：億＝10^8、萬＝10^4。
 * 直接拿 `formatTokens` 那套 K／M／B 去翻譯會錯——
 * 1B 不是「10 億」以外的任何東西，但 1M 是「100 萬」不是「1 百萬單位」。
 * 所以這裡自己分段，不共用上面那支。
 */
export function formatTokensZh(value: number): string {
  const n = Math.abs(value);
  if (n >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 億`;
  if (n >= 10_000) return `${(value / 10_000).toFixed(1)} 萬`;
  return value.toLocaleString("en-US");
}

/** 回傳 [from, to) 的 ISO 日期字串，用於 usage summary 查詢的日期範圍。 */
/**
 * 月份區間＝**台北**的每月 1 日 00:00 起（2026-09-12 起，原本是 UTC 月份）。
 * 與 lib/range.ts 的 monthBounds 同一個定義；這支給不走頁首日期選單的地方用
 * （預算、每小時的預算檢查、hub 花費、用量摘要、頁首的預算橫幅）。
 */
export function monthRange(offsetMonths: number): { from: string; to: string } {
  const TPE_MS = 8 * 3_600_000;
  const tp = new Date(Date.now() + TPE_MS);
  const start = new Date(Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth() + offsetMonths, 1) - TPE_MS);
  const end = new Date(Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth() + offsetMonths + 1, 1) - TPE_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function last4(key: string | null | undefined): string {
  if (!key) return "----";
  return key.slice(-4);
}

/**
 * 訂閱的「每月等值金額」。
 *
 * 年繳的 fee 存的是年費，直接拿去加總會把一筆年繳當成十二倍。
 * 所有跨訂閱的加總都必須先過這一支，不要在各處自己除 12。
 */
export function monthlyEquivalent(fee: number, cycle: "monthly" | "yearly"): number {
  return cycle === "yearly" ? fee / 12 : fee;
}

/**
 * 台北時間的顯示字串。
 *
 * 一定要明寫 timeZone：容器的 TZ 是 UTC（實測 `date` 回 UTC、Node 的
 * resolvedOptions().timeZone 也是 UTC），不指定的話 toLocaleString 會
 * 直接印 UTC 掛鐘時間，看起來像本地時間但差八小時。
 */
export function formatTaipei(d: Date | string | null | undefined, withSeconds = false): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
  });
}

/** 距今多久。給「最近使用時間」用，絕對時間旁邊要有相對時間才讀得出新舊。 */
export function sinceNow(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "從未使用";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const mins = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (mins < 1) return "剛剛";
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

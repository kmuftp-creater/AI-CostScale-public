/**
 * 大屏的外觀清單。
 *
 * 為什麼獨立一個檔：這些常數**伺服器端與用戶端都要用**（page.tsx 要依網址參數決定 class，
 * BigScreenClient 與頁首的 BigScreenLink 要輪流切換）。
 * 放在 "use client" 的檔案裡，伺服器端 import 進來會是 undefined——
 * Next 只把「元件」接出去，同一個檔的其他匯出在伺服器端讀不到（2026-09-13 踩過：
 * `SKIN_CLASS[urlSkin].join()` 直接 500，訊息是 Cannot read properties of undefined）。
 */
export type Skin = "cyber" | "nerv" | "cmd";

export const SKIN_KEY = "costscale-bigscreen-skin";

/** 按一下換下一種的順序。 */
export const SKIN_ORDER: Skin[] = ["cyber", "nerv", "cmd"];

export const SKIN_NAME: Record<Skin, string> = {
  cyber: "藍紫科幻",
  nerv: "黑橘警戒",
  cmd: "作戰指揮",
};

/** 每種外觀要掛哪些 class。cmd 是「nerv ＋ 一層」，所以不必複寫整套樣式。 */
export const SKIN_CLASS: Record<Skin, string[]> = {
  cyber: [],
  nerv: ["bs-nerv"],
  cmd: ["bs-nerv", "bs-cmd"],
};

/** 網址參數是不是合法的外觀名稱。 */
export function parseSkin(v: string | undefined | null): Skin | null {
  return v === "cyber" || v === "nerv" || v === "cmd" ? v : null;
}

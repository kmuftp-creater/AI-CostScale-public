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

/**
 * 私有素材的插槽。`public/private/<名稱>.png|jpg|jpeg|webp` 放了檔就會出現在對應位置。
 *
 * 為什麼用「固定名稱」而不是「掃描目錄」：位置是設計過的（哪個標貼哪一塊），
 * 用檔名對應，之後想換某一塊只要換那個檔，不必改程式。
 * 這個目錄在 .gitignore 裡——素材不進版控，公開版一個都不會有，版面照樣完整。
 */
export const ASSET_SLOTS = [
  "logo",      // 頁首左上的標誌
  "mark",      // 整個舞台的背景圖（壓很淡）
  "char",      // 拓撲面板左下的人物（放在有邊框的通訊視窗裡）
  "daily",     // 每日閘道花費面板的機體圖
  "urgent",    // 有失敗時，警戒橫幅左端換成這個
  "nerv",      // 拓撲中央「閘道」後面的徽章
  "nervleaf",  // 左側直排字上方的小標
  "secret2",   // 右側直排字上方的小標
  "alarm",     // 警戒橫幅左端
  "sortie",    // 警戒橫幅右端
  "secret",    // 拓撲面板右上角
  "internal",  // 每日閘道花費
  "eva01",     // 模型用量
  "power",     // 免費額度
  "eva02",     // 流量拓撲
  "eva00",     // 近 24 小時
  "agency",    // 軟體費用排行
  "plan",      // 訂閱省下多少
  "berserk",   // 最近異常
  "weapon",    // 畫面最下方
  "unit01",    // 本月呼叫
  "unit02",    // 本月 Token
  "unit03",    // 本月閘道花費
] as const;
export type AssetSlot = (typeof ASSET_SLOTS)[number];
export type Assets = Partial<Record<AssetSlot, string>>;

/** 網址參數是不是合法的外觀名稱。 */
export function parseSkin(v: string | undefined | null): Skin | null {
  return v === "cyber" || v === "nerv" || v === "cmd" ? v : null;
}

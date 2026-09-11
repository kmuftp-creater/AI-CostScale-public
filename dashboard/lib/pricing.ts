/**
 * 訂閱制 CLI 的「若走 API 要付多少」價目表（2026-08-29）。
 *
 * 用途只有一個：回答 User 的「訂閱到底幫我省了多少錢」。
 * 這個數字**完全由比價基準決定**——同一份用量，換一個模型的價目，
 * 結論可以從「不划算」翻成「省二十倍」。所以這張表要滿足三件事：
 *
 *   1. 每一筆都寫明出處與查詢日期，不從記憶寫價目。
 *   2. 對不到型號時按 User 指定的一支補算，並把「補了多少、按哪一支補」
 *      顯示在畫面上——不靜靜套一個價，也不靜靜丟掉。
 *   3. OpenAI 一律用**短脈絡**價目。長脈絡是兩倍價，用短脈絡會低估「省下多少」——
 *      往低估的方向錯，比往高估的方向錯安全。
 *      Anthropic 沒有這個問題：官方價目頁（2026-09-10 讀取）寫明 Claude 4.6 之後的
 *      模型整個 1M 上下文都按標準價計。
 *
 * 價目單位：美元／每百萬 token。
 */

export type ModelPrice = {
  /** 一般輸入 */
  input: number;
  /** 輸出。OpenAI 的 reasoning token 已含在 output_tokens 裡，不要另外加。 */
  output: number;
  /** 讀快取 */
  cacheRead: number;
  /** 寫快取，5 分鐘 TTL 的價（1.25 倍輸入價）。Codex 的 session 檔沒有回報這一項，所以那側恆為 0。 */
  cacheWrite: number;
  /**
   * 寫快取，1 小時 TTL 的價（2 倍輸入價）。
   *
   * 2026-09-10 補。原本只有上面那一個寫入價，一律按 5 分鐘算——
   * 但實測本機 Claude Code 的寫入，Opus／Fable 有 99% 以上是 1 小時的，
   * 「若走 API 要付多少」因此少算了 US$7,388。
   * 是在拿 LibreChat 的價目表對照時發現的。
   */
  cacheWrite1h: number;
};

/**
 * Anthropic 官方價目。來源：https://platform.claude.com/docs/en/about-claude/pricing
 * 查詢日期 2026-09-10（2026-08-29 第一版取自 claude-api skill 的模型表，只有 5 分鐘寫入價）。
 *
 * - 1 小時寫入是 2 倍輸入價、5 分鐘寫入是 1.25 倍、讀快取是 0.1 倍——
 *   **Fable 5.1 例外，讀快取是 0.025 倍**（$0.25，不是 $1）。
 * - Sonnet 5 的 $2／$10 原本公告是只到 2026-08-31 的限時價，
 *   官方已改為正式價、9/1 的漲價取消。LibreChat 的註解還寫著「9/1 之後改回 $3／$15」，
 *   那一行是它過時，不是這裡錯。
 * - Fable 5／5.1 在 2026-09-10 以前不在表上，被按 Opus 5 補算——
 *   它的輸入與輸出單價都是 Opus 的兩倍，於是又少算了 US$4,184。
 */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20.0 },
  "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5, cacheWrite1h: 20.0 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2.0 },
};

/**
 * OpenAI 官方價目，短脈絡。來源：platform.openai.com/docs/pricing，
 * 查詢日期 2026-08-29。長脈絡是這裡的兩倍，刻意不用（理由見檔頭第 3 點）。
 */
export const OPENAI_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, cacheWrite1h: 0.25 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 2.5 },
  "gpt-5.6-sol": { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite: 5.0, cacheWrite1h: 5.0 },
  "gpt-5.6-cyber": { input: 12.5, output: 75.0, cacheRead: 1.25, cacheWrite: 15.625, cacheWrite1h: 15.625 },
};

/**
 * 遙測回報的型號字串對到價目表的鍵。
 *
 * Claude Code 會送帶日期後綴的版本（`claude-haiku-4-5-20251001`），
 * 先去掉八位數字後綴再查。**對不到就回 null**，由呼叫方決定要不要補算——
 * 這一支不自己挑一個預設價，否則「補算」會發生在沒有人看得到的地方。
 */
export function resolvePrice(
  table: Record<string, ModelPrice>,
  model: string | null
): ModelPrice | null {
  if (!model) return null;
  const key = model.trim().replace(/-\d{8}$/, "");
  return table[key] ?? null;
}

/**
 * 一個來源的換算結果。
 *
 * 對不到價目的型號**不是丟掉、也不是猜**：按 User 指定的一支模型補算，
 * 並把補了多少 token、按哪一支補，一起帶出來顯示在畫面上。
 * 2026-08-29 之前這裡給的是上下界區間，User 裁決改成單一數字
 * （Codex 那 7.54 億缺欄的 token 按 `gpt-5.6-terra` 算），
 * 理由是區間在教學時不好講；代價是要把「這一段是補的」講清楚。
 */
export type ApiEquivalent = {
  /** 型號對得到價目的部分，美元。 */
  known: number;
  /** 對不到價目、按 fallbackPricedAs 補算的部分，美元。 */
  fallback: number;
  /** 補算的 token 量。要顯示出來，讓人自己判斷這一段重不重要。 */
  fallbackTokens: number;
  /** 對不到價目的型號名稱。 */
  fallbackModels: string[];
  /** 補算時用的是哪一支。沒有東西要補時是 null。 */
  fallbackPricedAs: string | null;
};

export type UsageRow = {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  /** 寫快取總數（5 分鐘＋1 小時）。 */
  cacheWrite: number;
  /** cacheWrite 之中屬於 1 小時快取的部分。沒有這項資料的來源不給，當 0。 */
  cacheWrite1h?: number;
};

export function costOf(p: ModelPrice, r: UsageRow): number {
  // 1 小時的部分夾在總數以內：舊資料這一項是 0，就等於照舊全按 5 分鐘價算。
  const w1h = Math.min(Math.max(r.cacheWrite1h ?? 0, 0), r.cacheWrite);
  const w5m = r.cacheWrite - w1h;
  return (
    (r.input / 1e6) * p.input +
    (r.output / 1e6) * p.output +
    (r.cacheRead / 1e6) * p.cacheRead +
    (w5m / 1e6) * p.cacheWrite +
    (w1h / 1e6) * p.cacheWrite1h
  );
}

/**
 * 把一組用量換算成「若走 API 要付多少」。
 *
 * `fallbackKey` 是 User 指定用來補算未知型號的那一支。**它必須在表上**，
 * 不在就當作沒有補算依據，那些列直接不計——寧可少算，不要用一個
 * 不存在的價目編出一個看起來很精確的數字。
 */
export function toApiEquivalent(
  table: Record<string, ModelPrice>,
  rows: UsageRow[],
  fallbackKey: string | null
): ApiEquivalent {
  const fb = fallbackKey ? table[fallbackKey] ?? null : null;
  let known = 0;
  let fallback = 0;
  let fallbackTokens = 0;
  const fallbackModels: string[] = [];

  for (const r of rows) {
    const p = resolvePrice(table, r.model);
    if (p) {
      known += costOf(p, r);
      continue;
    }
    fallbackTokens += r.input + r.output + r.cacheRead + r.cacheWrite;
    fallbackModels.push(r.model || "(未標示)");
    if (fb) fallback += costOf(fb, r);
  }
  return {
    known,
    fallback,
    fallbackTokens,
    fallbackModels: [...new Set(fallbackModels)],
    fallbackPricedAs: fallbackTokens > 0 && fb ? fallbackKey : null,
  };
}

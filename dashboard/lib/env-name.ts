/**
 * 新增上游金鑰時，自動推「下一個沒被用的環境變數名」（2026-11-09）。
 *
 * 必須看**全站**已使用的名字，不能只看這個模型組自己的。
 * `.env` 是全站共用一份，而同一個前綴常常分散在不同模型組：
 * 模型組 A 掛 ANTHROPIC_KEY_1、模型組 B 掛 ANTHROPIC_KEY_2。
 * 只看組內時，模型組 A 會建議 ANTHROPIC_KEY_2，開新模型組會固定建議 _KEY_1，
 * 送出後都被主機端以「已經存在於 .env」拒絕。
 *
 * 主機端的 env_has() 仍是最後一道檢查；這裡只負責讓建議值一開始就能用。
 */

/** `prefix` 後面接純數字的名字裡，取最大編號加一。`floor` 是沒有任何相符時的起算值。 */
export function nextIndexedName(prefix: string, usedEnvNames: string[], floor = 0): string {
  let max = floor;
  for (const name of usedEnvNames) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

/**
 * 加進既有模型組時的建議名稱。
 * 例：組內有 ANTHROPIC_KEY_1、全站用到 ANTHROPIC_KEY_4 → ANTHROPIC_KEY_5。
 * 組內的名字沒有數字結尾（GEMINI_PAID_KEY）→ 接 `_2` 起算。組內沒有名字 → 交給人填。
 */
export function nextEnvName(groupEnvNames: string[], usedEnvNames: string[]): string {
  const all = [...groupEnvNames, ...usedEnvNames];
  for (const name of groupEnvNames) {
    const m = /^(.*?)(\d+)$/.exec(name);
    if (m) return nextIndexedName(m[1], all);
  }
  if (groupEnvNames.length > 0) return nextIndexedName(`${groupEnvNames[0]}_`, all, 1);
  return "";
}

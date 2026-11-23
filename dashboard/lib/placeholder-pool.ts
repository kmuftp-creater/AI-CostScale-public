/**
 * 閘道啟動時（scripts/litellm-entry.py）會把「金鑰還是佔位值、而且同一個 model_name 底下還有真金鑰」的部署
 * 從載入清單拿掉。金鑰管理頁用「設定檔第 N 筆對到閘道第 N 筆」對照部署，所以這裡要用同一條規則
 * 預先算出哪些設定檔條目沒有被載入，對照時跳過它們，不然 N 會對錯位。
 *
 * 純函式，不引用其他檔案，方便用 node 直接跑測試（scripts/test-placeholder-pool.mjs）。
 */

/** 範本裡未填金鑰的佔位字是 "placeholder"，尾 4 碼是 "lder"（與 onboarding-core 的 PLACEHOLDER_TAIL 相同）。 */
export const PLACEHOLDER_KEY_TAIL = "lder";

type PoolEntry = { modelName: string; envName: string | null; isWildcard: boolean };

/**
 * 回傳設定檔條目中「閘道不會載入」的索引集合。
 * @param isPlaceholder 該環境變數的金鑰是不是佔位值；查不到（尾碼表沒有）要回 false，查不到就不跳過。
 */
export function skippedPlaceholderIndexes(entries: PoolEntry[], isPlaceholder: (envName: string) => boolean): Set<number> {
  const real = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.isWildcard) continue;
    // 沒有 api_key（例如 Vertex）或金鑰是真的，都算「這個 model_name 有真部署」
    if (e.envName === null || !isPlaceholder(e.envName)) real.add(e.modelName);
  }
  const skipped = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.isWildcard || e.envName === null) continue;
    if (isPlaceholder(e.envName) && real.has(e.modelName)) skipped.add(i);
  }
  return skipped;
}

// 佔位部署跳過規則（lib/placeholder-pool.ts）的驗證。規則要與 scripts/litellm-entry.py 一致。
// 執行（Node 22.18 以上）：  node scripts/test-placeholder-pool.mjs
import assert from "node:assert/strict";
import { skippedPlaceholderIndexes } from "../lib/placeholder-pool.ts";

let pass = 0;
const ok = (n) => { pass += 1; console.log(`  通過  ${n}`); };
const e = (modelName, envName, isWildcard = false) => ({ modelName, envName, isWildcard });
const gem = [1, 2, 3, 4, 5].map((i) => e("gemini-flash-free", `GEMINI_FREE_KEY_${i}`));
const entries = [...gem, e("groq-large", "GROQ_KEY_1"), e("groq-large", "GROQ_KEY_2"), e("vertex", null), e("openrouter-*", "OPENROUTER_API_KEY", true)];
const real = (set) => (name) => !set.has(name);

// 只填第 1 把
let s = skippedPlaceholderIndexes(entries, (n) => n !== "GEMINI_FREE_KEY_1");
assert.deepEqual([...s].sort((a, b) => a - b), [1, 2, 3, 4]);
ok("只填第 1 把：跳過第 2 到 5 個條目（索引 1 到 4），Groq 兩把都沒填則不跳過");

// 填第 2 把與第 4 把
s = skippedPlaceholderIndexes(entries, (n) => !["GEMINI_FREE_KEY_2", "GEMINI_FREE_KEY_4"].includes(n));
assert.deepEqual([...s].sort((a, b) => a - b), [0, 2, 4]);
ok("填第 2、4 把：跳過第 1、3、5 個條目");

// 填滿
s = skippedPlaceholderIndexes(entries, () => false);
assert.equal(s.size, 0);
ok("全部是真金鑰：不跳過任何條目");

// 全部佔位：一個都不跳過（與閘道一致，沒有真金鑰的模型維持原狀）
s = skippedPlaceholderIndexes(entries, () => true);
assert.equal(s.size, 0);
ok("整組都是佔位：不跳過（與閘道的行為一致）");

// Groq 填第 2 把
s = skippedPlaceholderIndexes(entries, (n) => n !== "GROQ_KEY_2" && n !== "GEMINI_FREE_KEY_1");
assert.ok(s.has(5) && !s.has(6));
ok("Groq 只填第 2 把：跳過第 1 把的條目");

console.log(`\n全部通過（${pass} 組）`);

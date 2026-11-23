// 本機安裝模式判斷的單元驗證。執行（Node 22.18 以上）：  node scripts/test-local-mode.mjs
import assert from "node:assert/strict";
import { isLocalMode, LOCAL_KEY_NOTICE, LOCAL_KEY_STEPS, LOCAL_REMOVE_KEY_STEPS } from "../lib/mode.ts";

for (const v of ["local", "LOCAL", " local "]) assert.equal(isLocalMode({ COSTSCALE_MODE: v }), true, v);
for (const v of [undefined, "", "vps", "locally", "0", "1"]) assert.equal(isLocalMode(v === undefined ? {} : { COSTSCALE_MODE: v }), false, String(v));
assert.ok(LOCAL_KEY_STEPS.some((s) => s.includes("docker compose -f docker-compose.setup.yml run --rm setup")));
assert.ok(LOCAL_KEY_STEPS.some((s) => s.includes("docker compose up -d")));
assert.ok(!/也許|可能|大概|通常/.test(LOCAL_KEY_NOTICE + LOCAL_KEY_STEPS.join("")), "不得有模糊詞");
assert.ok(LOCAL_REMOVE_KEY_STEPS.some((s) => s.includes("移除 AI 金鑰")));
assert.ok(LOCAL_REMOVE_KEY_STEPS.some((s) => s.includes("docker compose up -d")));
assert.ok(!/也許|可能|大概|通常/.test(LOCAL_REMOVE_KEY_STEPS.join("")), "不得有模糊詞");
console.log("全部通過（本機模式判斷、說明文字）");

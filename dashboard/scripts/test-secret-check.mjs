// 祕密欄位「是不是真的設過」判斷函式的測試（lib/secret-check.ts）。
// 執行（Node 22.18 以上可直接讀 .ts）：  node scripts/test-secret-check.mjs
//
// 範本值直接從 .env.example 讀，範本日後改了也會跟著測，不會寫死一份過期的清單。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authSecretProblem, secretProblem, tokenUnset, MIN_AUTH_SECRET_LENGTH } from "../lib/secret-check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = fs.readFileSync(path.resolve(here, "../../.env.example"), "utf8").replaceAll("\r\n", "\n");
const tpl = (key) => {
  const m = new RegExp("^" + key + "=(.*)$", "m").exec(example);
  assert.ok(m, ".env.example 找不到 " + key);
  return m[1];
};

let pass = 0;
const ok = (name) => {
  pass += 1;
  console.log(`  通過  ${name}`);
};

// 1. .env.example 裡每個「祕密欄位」的範本值都要被判為未設定
const secretKeys = ["AUTH_SECRET", "ALERT_CRON_TOKEN", "OTEL_INGEST_TOKEN", "BRIDGE_TOKEN", "DB_PASSWORD", "LITELLM_MASTER_KEY"];
for (const k of secretKeys) {
  const v = tpl(k);
  assert.notEqual(secretProblem(v), null, k + " 的範本值 " + v + " 必須被判為未設定");
  assert.equal(tokenUnset(v), true, k + " 的範本值作為 token 必須被拒絕");
}
assert.notEqual(authSecretProblem({ AUTH_SECRET: tpl("AUTH_SECRET") }), null);
ok(`.env.example 的 ${secretKeys.length} 個祕密欄位範本值都被判為未設定`);

// 2. 空值、空白、placeholder、大小寫變化
for (const v of [undefined, null, "", "   ", "\t\n", "placeholder", "PLACEHOLDER", " Placeholder ", "change-me", "Change-Me-Xyz", "CHANGE-ME-AUTHJS-SECRET", "sk-change-me", "sk-change-me-123"]) {
  assert.notEqual(secretProblem(v), null, "應判為未設定：" + JSON.stringify(v));
  assert.equal(tokenUnset(v), true);
}
assert.equal(secretProblem(""), "empty");
assert.equal(secretProblem("change-me-x"), "template");
ok("空值、空白、placeholder、change-me 開頭（不分大小寫）都判為未設定");

// 3. AUTH_SECRET 的長度門檻
const ok32 = "a1b2c3d4".repeat(4);
assert.equal(ok32.length, MIN_AUTH_SECRET_LENGTH);
assert.equal(authSecretProblem({ AUTH_SECRET: ok32 }), null, "剛好 32 個字元可用");
assert.equal(authSecretProblem({ AUTH_SECRET: ok32.slice(1) }), "short", "31 個字元太短");
assert.equal(authSecretProblem({ AUTH_SECRET: "x".repeat(40) + "  " }), null, "前後空白不算長度但夠長");
assert.equal(authSecretProblem({ AUTH_SECRET: " ".repeat(10) + "a".repeat(20) + " ".repeat(10) }), "short", "空白不算在長度裡");
assert.equal(authSecretProblem({}), "empty");
assert.equal(authSecretProblem({ AUTH_SECRET: "a".repeat(64) }), null, "openssl rand -hex 32 的長度可用");
ok("AUTH_SECRET：32 個字元可用、31 個太短、前後空白不算長度");

// 4. 一般的真值不被誤判；token 沒有長度門檻
for (const v of ["8f3a9c1d5e7b2a4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e", "abc", "sk-8f3a9c1d5e7b2a4c", "my-change-me-token"]) {
  assert.equal(tokenUnset(v), false, "真值不得被誤判：" + v);
}
ok("真值不被誤判（含中間才出現 change-me 的值）");

console.log(`\n全部通過（${pass} 組）`);

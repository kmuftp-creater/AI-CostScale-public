// 共用 token 比對（lib/token-compare.ts）驗證，並掃描 API 路由確認沒有人用 !== 或 === 直接比 token。
// 執行（Node 22.18 以上）：  node scripts/test-token-compare.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeTokenEqual } from "../lib/token-compare.ts";

let pass = 0;
const ok = (n) => { pass += 1; console.log(`  通過  ${n}`); };

assert.equal(safeTokenEqual("abc123", "abc123"), true);
assert.equal(safeTokenEqual("", ""), true);
assert.equal(safeTokenEqual("abc123", "abc124"), false);
assert.equal(safeTokenEqual("abc123", "abc1234"), false);
assert.equal(safeTokenEqual("abc1234", "abc123"), false);
assert.equal(safeTokenEqual("", "abc"), false);
assert.equal(safeTokenEqual("中文token", "中文token"), true);
assert.equal(safeTokenEqual("中文token", "中文tokeN"), false);
ok("相同、相異、長度不同、空字串、非 ASCII 的判斷正確");

// 掃描：app/api 底下不得出現「token 變數直接用 === 或 !== 比對」的寫法
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../app/api");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "route.ts") files.push(p);
  }
})(apiDir);
const bad = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;
    if (/\b(token|expected|cronToken|got)\s*[!=]==\s*(token|expected|cronToken|got)\b/.test(ln) || /auth\s*===\s*`Bearer/.test(ln)) {
      bad.push(`${path.relative(apiDir, f)}:${i + 1}  ${ln.trim()}`);
    }
  });
}
assert.deepEqual(bad, [], "這些地方直接比對 token：\n" + bad.join("\n"));
ok(`掃描 ${files.length} 支 API 路由：沒有直接用 ===／!== 比對 token`);

console.log(`\n全部通過（${pass} 組）`);

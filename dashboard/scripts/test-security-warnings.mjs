// 安全警告（lib/security-warnings.ts、lib/secret-check.ts 的 dbPasswordProblem）的單元驗證。
// 執行（Node 22.18 以上）：  node scripts/test-security-warnings.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSecurityWarnings, PassLogGate } from "../lib/security-warnings.ts";
import { dbPasswordProblem } from "../lib/secret-check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = fs.readFileSync(path.resolve(here, "../../.env.example"), "utf8").replaceAll("\r\n", "\n");
const tpl = (key) => new RegExp("^" + key + "=(.*)$", "m").exec(example)[1];

let pass = 0;
const ok = (n) => { pass += 1; console.log(`  通過  ${n}`); };
const none = { authDisabled: false, masterKeyTemplate: false, dbPasswordTemplate: false };
const all = { authDisabled: true, masterKeyTemplate: true, dbPasswordTemplate: true };

// 1. 沒有問題：沒有任何警告
assert.deepEqual(buildSecurityWarnings(none, false), []);
assert.deepEqual(buildSecurityWarnings(none, true), []);
ok("沒有問題時不產生警告");

// 2. 三種旗標各自對應一則警告，並且內容完整
for (const local of [false, true]) {
  const w = buildSecurityWarnings(all, local);
  assert.deepEqual(w.map((x) => x.id), ["auth-disabled", "master-key-template", "db-password-template"]);
  for (const x of w) {
    assert.ok(x.tag.length > 0 && x.summary.length > 20 && x.fix.length >= 1, x.id);
    assert.ok(!/也許|可能|大概|通常/.test(x.tag + x.summary + x.fix.join("")), "不得有模糊詞：" + x.id);
  }
}
ok("三種警告都有標籤、說明與修正步驟，且沒有模糊詞");

// 3. 登入關閉的說明要講白話風險與改回的做法；本機版與 VPS 版指令不同
const authLocal = buildSecurityWarnings({ ...none, authDisabled: true }, true)[0];
const authVps = buildSecurityWarnings({ ...none, authDisabled: true }, false)[0];
assert.match(authLocal.summary, /任何連得到這個網址的人/);
assert.match(authLocal.summary, /看到全部花費/);
assert.match(authLocal.summary, /發金鑰/);
assert.ok(authLocal.fix.join("\n").includes("AUTH_DISABLED"));
assert.ok(authLocal.fix.join("\n").includes("docker compose up -d dashboard"));
assert.ok(!authLocal.fix.join("\n").includes("/opt/costscale"), "本機版不得提 /opt/costscale");
assert.ok(authVps.fix.join("\n").includes("/opt/costscale"));
assert.ok(authVps.fix.join("\n").includes("docker-compose.vps.yml"));
ok("登入關閉的警告：白話風險、改回做法、本機與 VPS 指令分開");

// 4. DATABASE_URL 取密碼
const tplDb = tpl("DB_PASSWORD");
assert.notEqual(dbPasswordProblem(`postgresql://costscale:${tplDb}@db:5432/costscale`), null, "範本密碼要被抓到");
assert.notEqual(dbPasswordProblem("postgresql://costscale:CHANGE-ME-x@db:5432/costscale"), null);
assert.notEqual(dbPasswordProblem("postgresql://costscale:@db:5432/costscale"), null, "空密碼");
assert.equal(dbPasswordProblem("postgresql://costscale:7f3a9c1e5b2d4a60@db:5432/costscale"), null);
assert.equal(dbPasswordProblem(undefined), null);
assert.equal(dbPasswordProblem(""), null);
assert.equal(dbPasswordProblem("不是網址"), null);
ok("DATABASE_URL 的密碼：範本值與空值被抓到，亂數值與讀不出來的值不誤報");

// 5. 放行 log 節流：第一次印，5 分鐘內不印，期間次數在下一行回報
const gate = new PassLogGate(5 * 60 * 1000);
const t0 = 1_000_000;
const first = gate.note(t0);
assert.ok(first && first.includes("AUTH_DISABLED=1") && first.includes("放行"));
assert.equal(gate.note(t0 + 1000), null);
assert.equal(gate.note(t0 + 60_000), null);
assert.equal(gate.note(t0 + 299_000), null);
const again = gate.note(t0 + 300_000);
assert.ok(again && again.includes("另有 3 次放行"), again);
assert.equal(gate.note(t0 + 300_001), null);
ok("放行 log 每 5 分鐘最多一行，並回報期間放行次數");

// 6. 洗版壓力：10000 次放行（跨 4 分鐘）只印 1 行
const g2 = new PassLogGate();
let lines = 0;
for (let i = 0; i < 10000; i++) if (g2.note(2_000_000 + i * 20) !== null) lines += 1;
assert.equal(lines, 1);
ok("10000 次放行只印 1 行");

console.log(`\n全部通過（${pass} 組）`);

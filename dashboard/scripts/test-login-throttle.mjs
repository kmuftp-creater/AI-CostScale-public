// 登入鎖定的來源 IP 正規化與計數驗證（lib/login-throttle.ts）。
// 執行（Node 22.18 以上）：  node scripts/test-login-throttle.mjs
import assert from "node:assert/strict";
import { clientIp, resetThrottle, reserveAttempt, lockedMinutes, UNKNOWN_IP, IP_MAX_FAILS } from "../lib/login-throttle.ts";

let pass = 0;
const ok = (n) => { pass += 1; console.log(`  通過  ${n}`); };
const proxied = { TRUST_PROXY: "1" };
const ipOf = (xff) => clientIp(new Headers({ "x-forwarded-for": xff }), proxied);

// 1. 沒有信任代理：不讀標頭，一律同一桶
assert.equal(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }), {}), UNKNOWN_IP);
assert.equal(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }), { TRUST_PROXY: "0" }), UNKNOWN_IP);
ok("TRUST_PROXY 不是 1：不讀 X-Forwarded-For");

// 2. 一般 IPv4、IPv6 寫法
assert.equal(ipOf("10.5.5.5"), "10.5.5.5");
assert.equal(ipOf("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
assert.equal(ipOf("2001:0db8::0001"), "2001:db8::1");
assert.equal(ipOf("2001:db8::1%eth0"), UNKNOWN_IP);
assert.equal(ipOf("garbage"), UNKNOWN_IP);
ok("IPv4 與 IPv6 的不同寫法正規化成同一個字串");

// 3. IPv4-mapped IPv6 與 IPv4 同一個來源（V-06）
assert.equal(ipOf("::ffff:10.5.5.5"), "10.5.5.5");
assert.equal(ipOf("::FFFF:10.5.5.5"), "10.5.5.5");
assert.equal(ipOf("0:0:0:0:0:ffff:10.5.5.5"), "10.5.5.5");
assert.equal(ipOf("::ffff:a05:505"), "10.5.5.5");
assert.equal(ipOf("::ffff:192.168.1.20"), "192.168.1.20");
assert.equal(ipOf("::ffff:255.255.255.255"), "255.255.255.255");
assert.equal(ipOf("::ffff:0.0.0.1"), "0.0.0.1");
assert.equal(ipOf("::1"), "::1", "迴圈位址不是 mapped，維持原樣");
assert.equal(ipOf("2001:db8::ffff:1"), "2001:db8::ffff:1", "不是 ::ffff: 開頭的位址不受影響");
ok("::ffff:a.b.c.d 的各種寫法都對到同一個 IPv4");

// 4. 實際鎖定：用 mapped 寫法輸錯，再用純 IPv4 寫法也被鎖（同一桶）
resetThrottle();
const now = Date.now();
for (let i = 0; i < IP_MAX_FAILS; i++) reserveAttempt(ipOf("::ffff:10.5.5.5"), now);
assert.ok(lockedMinutes(ipOf("10.5.5.5"), now) > 0, "IPv4 寫法應被同一個鎖定擋住");
assert.equal(lockedMinutes(ipOf("10.5.5.6"), now), 0, "不同位址不受影響");
ok("mapped 寫法輸錯 5 次，純 IPv4 寫法同樣被鎖；別的位址不受影響");

console.log(`\n全部通過（${pass} 組）`);

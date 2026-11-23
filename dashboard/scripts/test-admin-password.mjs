// 跨語言測試：scripts/set-admin-password.sh（python3 hashlib.scrypt）產生的雜湊，
// 要能被 dashboard/lib/admin-password.ts（node:crypto scrypt）驗證通過。
// 另外測雜湊格式防呆與 lib/login-throttle.ts 的鎖定規則。
//
// 執行（要有 Node 22.18 以上、bash、python3；在專案的 dashboard 資料夾裡）：
//   node scripts/test-admin-password.mjs
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../../scripts/set-admin-password.sh");

// 這份測試驗的是「信任代理標頭」時的行為（雲端主機模式），所以先開 TRUST_PROXY；不信任的行為在檔案最後另外測。
process.env.TRUST_PROXY = "1";

const { getAdminConfig, parseHash, verifyAdminLogin, inputWithinLimits, ADMIN_USER_PATTERN } = await import("../lib/admin-password.ts");
const throttle = await import("../lib/login-throttle.ts");

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  通過  ${name}`);
}

function pyHash(password) {
  // 密碼走環境變數傳進 bash，再由函式經 stdin 交給 python；不經過命令列參數
  return execFileSync(
    "bash",
    ["-c", `source "${script}"; admin_make_hash "$CS_TEST_PW"`],
    { env: { ...process.env, CS_TEST_PW: password }, encoding: "utf8", windowsHide: true },
  ).trim();
}

// 1. python 產生、node 驗證
const passwords = ["Correct-Horse-9", "密碼Pass123!測試", "a$b\"c'd\\e f`g", "x".repeat(256)];
for (const pw of passwords) {
  const h = pyHash(pw);
  assert.match(h, /^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(!h.includes("$"), "雜湊不得含 $");
  const cfg = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h });
  assert.ok(cfg, "python 產生的雜湊要被接受");
  assert.equal(await verifyAdminLogin(cfg, "admin", pw), true, "正確密碼要通過");
  assert.equal(await verifyAdminLogin(cfg, "admin", pw + "x"), false, "錯誤密碼不得通過");
  assert.equal(await verifyAdminLogin(cfg, "Admin", pw), false, "帳號大小寫不同不得通過");
  assert.equal(await verifyAdminLogin(cfg, "other", pw), false, "帳號錯不得通過");
}
ok("python 產生的雜湊 node 驗證通過（4 組密碼，含中文、特殊字元、256 字元）；錯誤密碼與錯誤帳號不通過");

const h1 = pyHash("Correct-Horse-9");
const h2 = pyHash("Correct-Horse-9");
assert.notEqual(h1, h2, "同一個密碼每次的 salt 要不同");
ok("同一個密碼兩次產生的雜湊不同（salt 亂數）");

const cfg = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h1 });
for (const bad of [undefined, null, 123, {}, [], ""]) {
  assert.equal(await verifyAdminLogin(cfg, "admin", bad), false);
  assert.equal(await verifyAdminLogin(cfg, bad, "Correct-Horse-9"), false);
}
assert.equal(await verifyAdminLogin(cfg, "admin", "p".repeat(1025)), false);
assert.equal(await verifyAdminLogin(cfg, "a".repeat(65), "Correct-Horse-9"), false);
ok("非字串、空字串、超長輸入一律不通過，不丟例外");

// 2. 格式壞掉的雜湊視為未設定，不丟例外，警告不含雜湊內容
const good = h1.split(":");
const variants = {
  空字串: "",
  亂碼: "garbage",
  欄位太少: "scrypt:16384:8:1:" + good[4],
  欄位太多: h1 + ":extra",
  前綴不對: "bcrypt" + h1.slice(6),
  N不是2的次方: `scrypt:16385:8:1:${good[4]}:${good[5]}`,
  N太小: `scrypt:1024:8:1:${good[4]}:${good[5]}`,
  N太大: `scrypt:1048576:8:1:${good[4]}:${good[5]}`,
  r是0: `scrypt:16384:0:1:${good[4]}:${good[5]}`,
  r太大: `scrypt:16384:64:1:${good[4]}:${good[5]}`,
  p太大: `scrypt:16384:8:99:${good[4]}:${good[5]}`,
  salt太短: `scrypt:16384:8:1:abcd:${good[5]}`,
  salt奇數長度: `scrypt:16384:8:1:${good[4]}0:${good[5]}`,
  雜湊太短: `scrypt:16384:8:1:${good[4]}:${good[5].slice(2)}`,
  雜湊含非十六進位: `scrypt:16384:8:1:${good[4]}:${"zz" + good[5].slice(2)}`,
  含美元符號: `scrypt:16384:8:1:${good[4]}:$${good[5].slice(1)}`,
  數字含負號: `scrypt:-16384:8:1:${good[4]}:${good[5]}`,
};
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(" "));
try {
  for (const [name, v] of Object.entries(variants)) {
    assert.equal(parseHash(v), null, `parseHash 應拒絕：${name}`);
    assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: v }), null, `應視為未設定：${name}`);
  }
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "admin" }), null);
  assert.equal(getAdminConfig({ AUTH_ADMIN_PASSWORD_HASH: h1 }), null);
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "ab", AUTH_ADMIN_PASSWORD_HASH: h1 }), null, "帳號太短");
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "a".repeat(33), AUTH_ADMIN_PASSWORD_HASH: h1 }), null, "帳號太長");
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "ad min", AUTH_ADMIN_PASSWORD_HASH: h1 }), null, "帳號含空白");
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "ad$min", AUTH_ADMIN_PASSWORD_HASH: h1 }), null, "帳號含特殊字元");
  assert.equal(getAdminConfig({}), null);
  assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "", AUTH_ADMIN_PASSWORD_HASH: "" }), null);
} finally {
  console.warn = origWarn;
}
assert.ok(warns.length >= 1, "格式不對時要在 log 印警告");
for (const w of warns) {
  assert.ok(!w.includes(good[5]) && !w.includes(good[4]), "警告不得含雜湊或 salt");
}
ok(`格式壞掉的雜湊與帳號（${Object.keys(variants).length + 6} 種）都視為未設定、不丟例外，警告 ${warns.length} 則且不含雜湊內容`);

// 3. 指紋：換密碼後指紋不同
const cfgA = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h1 });
const cfgB = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h2 });
assert.notEqual(cfgA.fingerprint, cfgB.fingerprint);
assert.ok(!h1.includes(cfgA.fingerprint));
ok("換密碼後 session 指紋不同（舊登入會失效）");

// 4. 鎖定規則
const T = 1_000_000_000_000;
throttle.resetThrottle();
for (let i = 0; i < 4; i++) throttle.recordFailure("1.1.1.1", T + i * 1000);
assert.equal(throttle.lockedMinutes("1.1.1.1", T + 5000), 0, "4 次失敗還沒鎖");
throttle.recordFailure("1.1.1.1", T + 5000);
assert.equal(throttle.lockedMinutes("1.1.1.1", T + 6000), 15, "第 5 次失敗後鎖 15 分鐘（取整到分鐘）");
assert.equal(throttle.lockedMinutes("1.1.1.1", T + 5000 + 14 * 60000 + 30000), 1, "剩 30 秒顯示 1 分鐘");
assert.equal(throttle.lockedMinutes("1.1.1.1", T + 5000 + 15 * 60000), 0, "15 分鐘後解鎖");
assert.equal(throttle.lockedMinutes("2.2.2.2", T + 6000), 0, "另一個 IP 不受影響");
ok("同一 IP 5 次失敗鎖 15 分鐘；另一個 IP 不受影響；時間到解鎖");

throttle.resetThrottle();
for (let i = 0; i < 4; i++) throttle.recordFailure("3.3.3.3", T + i * 1000);
throttle.recordFailure("3.3.3.3", T + 16 * 60000); // 前 4 次已超過 15 分鐘視窗
assert.equal(throttle.lockedMinutes("3.3.3.3", T + 16 * 60000 + 1000), 0, "舊的失敗滑出視窗後不累計");
ok("超過 15 分鐘的舊失敗不累計");

throttle.resetThrottle();
for (let i = 0; i < 30; i++) throttle.recordFailure(`10.0.0.${i}`, T + i * 1000);
assert.equal(throttle.globalDelayMs(T + 40000), 0, "全站 30 次還不延遲（要超過 30）");
throttle.recordFailure("10.0.1.1", T + 41000);
assert.equal(throttle.globalDelayMs(T + 42000), 2000, "全站超過 30 次後固定延遲 2 秒");
assert.equal(throttle.lockedMinutes("10.0.5.5", T + 42000), 0, "延遲不會把其他 IP 鎖住");
assert.equal(throttle.globalDelayMs(T + 16 * 60000 + 41000), 0, "視窗過後恢復");
ok("全站超過 30 次失敗後每次延遲 2 秒；不鎖其他 IP；視窗過後恢復");

throttle.resetThrottle();
throttle.recordFailure("4.4.4.4", T);
throttle.recordSuccess("4.4.4.4");
for (let i = 0; i < 4; i++) throttle.recordFailure("4.4.4.4", T + 1000 + i);
assert.equal(throttle.lockedMinutes("4.4.4.4", T + 2000), 0, "成功登入會清掉該 IP 的失敗計數");
ok("成功登入清掉該 IP 的失敗計數");

const H = (o) => new Headers(o);
assert.equal(throttle.clientIp(H({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
assert.equal(throttle.clientIp(H({ "x-forwarded-for": "2001:DB8::1" })), "2001:db8::1");
assert.equal(throttle.clientIp(H({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
assert.equal(throttle.clientIp(H({ "x-forwarded-for": "<script>" })), "unknown");
assert.equal(throttle.clientIp(H({})), "unknown");
ok("來源 IP 取 X-Forwarded-For 最左邊一個；不像 IP 的內容一律歸 unknown");

// 5. 先佔額度：突發併發也只會進行 5 次驗證（P-05）
{
  const cfgC = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h1 });
  // 與 auth.ts authorize 同樣的順序：先 reserveAttempt（同步），通過才 await 驗證
  async function attemptNew(ip) {
    const locked = throttle.reserveAttempt(ip);
    if (locked > 0) return { verified: false };
    const okLogin = await verifyAdminLogin(cfgC, "admin", "wrong-password-1");
    if (!okLogin) throttle.confirmFailure();
    return { verified: true };
  }
  throttle.resetThrottle();
  const burst = await Promise.all(Array.from({ length: 400 }, () => attemptNew("9.9.9.9")));
  const verified = burst.filter((r) => r.verified).length;
  assert.equal(verified, 5, "同一來源 400 個同時到達的請求，鎖定前最多進行 5 次驗證，實際 " + verified);
  assert.ok(throttle.lockedMinutes("9.9.9.9") > 0, "5 次額度用完後鎖定");
  assert.equal(throttle.lockedMinutes("9.9.9.10"), 0, "另一個來源不受影響");

  // 對照組：舊寫法（先檢查鎖定、await 驗證、事後才計數）在同樣的突發下會多驗證很多次，證明上面的測試抓得到問題
  throttle.resetThrottle();
  async function attemptOld(ip) {
    if (throttle.lockedMinutes(ip) > 0) return { verified: false };
    await verifyAdminLogin(cfgC, "admin", "wrong-password-1");
    throttle.recordFailure(ip);
    return { verified: true };
  }
  const oldBurst = await Promise.all(Array.from({ length: 60 }, () => attemptOld("9.9.9.9")));
  const oldVerified = oldBurst.filter((r) => r.verified).length;
  assert.ok(oldVerified > 5, "對照組（舊寫法）應該超過 5 次，實際 " + oldVerified);

  // 成功要退回額度
  throttle.resetThrottle();
  for (let i = 0; i < 4; i++) throttle.reserveAttempt("9.9.9.11");
  throttle.recordSuccess("9.9.9.11");
  for (let i = 0; i < 4; i++) assert.equal(throttle.reserveAttempt("9.9.9.11"), 0);
  assert.equal(throttle.lockedMinutes("9.9.9.11"), 0, "成功退回額度後，後續失敗從 0 開始算");
  ok(`併發：400 個同時請求只進行 5 次驗證（對照組舊寫法 60 個同時請求進行了 ${oldVerified} 次）；成功退回額度`);
}

// 6. 追蹤清單達上限時，淘汰不得先丟掉鎖定中的項目（P-09）
{
  throttle.resetThrottle();
  const T2 = 2_000_000_000_000;
  for (let i = 0; i < 5; i++) throttle.reserveAttempt("7.7.7.7", T2 + i);
  assert.ok(throttle.lockedMinutes("7.7.7.7", T2 + 10) > 0, "7.7.7.7 已鎖定");
  for (let i = 0; i < throttle.MAX_TRACKED_IPS + 1500; i++) {
    throttle.reserveAttempt(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, T2 + 1000 + i);
  }
  assert.ok(throttle.lockedMinutes("7.7.7.7", T2 + 5000) > 0, "灌滿追蹤清單後，鎖定中的項目仍然在");
  ok("灌入 6500 個不同來源後，鎖定中的項目沒有被淘汰");
}

// 7. clientIp 只收合法 IP（P-09）
for (const bad of ["abc", "..", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.4:80", "fe80::1%eth0", "::::", "0x7f.1", " "]) {
  assert.equal(throttle.clientIp(H({ "x-forwarded-for": bad })), "unknown", "不合法的來源要歸 unknown：" + JSON.stringify(bad));
}
assert.equal(throttle.clientIp(H({ "x-forwarded-for": "0:0:0:0:0:0:0:1" })), "::1", "IPv6 不同寫法要正規化成同一個 key");
assert.equal(throttle.clientIp(H({ "x-forwarded-for": "abc", "x-real-ip": "198.51.100.8" })), "198.51.100.8", "第一個不合法時退回 X-Real-IP");
ok("clientIp 只收合法 IPv4 與 IPv6，其餘歸 unknown；IPv6 正規化");

// 8. 帳號必須以英數開頭（P-13）、輸入長度檢查（P-08）
for (const u of ["-rf", "...", "_abc", ".abc", "-abc"]) assert.equal(ADMIN_USER_PATTERN.test(u), false, "不得接受：" + u);
for (const u of ["admin", "a.b", "a_b-c", "A1b", "0day"]) assert.equal(ADMIN_USER_PATTERN.test(u), true, "應接受：" + u);
assert.equal(getAdminConfig({ AUTH_ADMIN_USER: "-rf", AUTH_ADMIN_PASSWORD_HASH: h1 }), null, "全符號帳號視為未設定");
assert.equal(inputWithinLimits("a".repeat(64), "p".repeat(1024)), true);
assert.equal(inputWithinLimits("a".repeat(65), "p"), false);
assert.equal(inputWithinLimits("a", "p".repeat(1025)), false);
assert.equal(inputWithinLimits("a", ""), false);
assert.equal(inputWithinLimits("a", 5), false);
assert.equal(inputWithinLimits(undefined, "x"), false);
ok("帳號要英數開頭；帳號 64、密碼 1024 字元的上限檢查");

// 9. TRUST_PROXY：不信任代理標頭時（預設、本機安裝模式），偽造的 X-Forwarded-For 不能換來源
{
  const spoof = (ip) => H({ "x-forwarded-for": ip, "x-real-ip": ip });
  for (const v of [undefined, "", "0", "true", "yes", "2"]) {
    const env = v === undefined ? {} : { TRUST_PROXY: v };
    assert.equal(throttle.clientIp(spoof("203.0.113.9"), env), "unknown", "TRUST_PROXY=" + JSON.stringify(v) + " 時不得讀標頭");
  }
  assert.equal(throttle.clientIp(spoof("203.0.113.9"), { TRUST_PROXY: "1" }), "203.0.113.9");
  assert.equal(throttle.clientIp(spoof("203.0.113.9"), { TRUST_PROXY: " 1 " }), "203.0.113.9", "前後空白忽略");
  // 不信任時，每次換一個偽造來源仍落在同一個 key，5 次失敗後鎖定
  throttle.resetThrottle();
  const T3 = 2_000_000_000_000;
  const env0 = {};
  for (let i = 0; i < 5; i++) {
    const ip = throttle.clientIp(spoof("198.51.100." + (10 + i)), env0);
    assert.equal(throttle.reserveAttempt(ip, T3 + i), 0);
  }
  const ipNext = throttle.clientIp(spoof("198.51.100.200"), env0);
  assert.ok(throttle.reserveAttempt(ipNext, T3 + 10) > 0, "換偽造來源不能繞過鎖定");
  // 信任時（雲端主機）：不同來源各自計數，行為與改動前相同
  throttle.resetThrottle();
  const env1 = { TRUST_PROXY: "1" };
  for (let i = 0; i < 5; i++) assert.equal(throttle.reserveAttempt(throttle.clientIp(spoof("198.51.100.1"), env1), T3 + i), 0);
  assert.ok(throttle.reserveAttempt(throttle.clientIp(spoof("198.51.100.1"), env1), T3 + 10) > 0, "同一來源第 6 次被鎖");
  assert.equal(throttle.reserveAttempt(throttle.clientIp(spoof("198.51.100.2"), env1), T3 + 11), 0, "信任代理時其他來源不受影響");
  ok("TRUST_PROXY 不是 1 時不讀標頭、偽造來源不能繞過鎖定；是 1 時與原行為相同");
}


// 10. 本機安裝模式的設定工具（scripts/local-setup.py）算的雜湊，要與 set-admin-password.sh 同格式，且儀表板驗證通過
{
  const localSetup = path.resolve(here, "../../scripts/local-setup.py");
  const pyLocal = (pw) =>
    execFileSync("python3", ["-I", localSetup, "--hash-stdin"], { input: pw, encoding: "utf8", windowsHide: true }).trim();
  for (const pw of ["Local-Setup-Pass-1", "中文密碼也要能用-12345", "p".repeat(256), "a b\tc  'q' \"d\" $x `y`"]) {
    const h = pyLocal(pw);
    const parsed = parseHash(h);
    assert.ok(parsed, "local-setup.py 的雜湊格式要被儀表板接受");
    assert.deepEqual([parsed.n, parsed.r, parsed.p, parsed.salt.length, parsed.hash.length], [16384, 8, 1, 16, 32], "參數要與 set-admin-password.sh 相同");
    assert.ok(!h.includes("$"), "雜湊不得含 $");
    const cfg = getAdminConfig({ AUTH_ADMIN_USER: "admin", AUTH_ADMIN_PASSWORD_HASH: h });
    assert.ok(cfg);
    assert.equal(await verifyAdminLogin(cfg, "admin", pw), true, "正確密碼要通過");
    assert.equal(await verifyAdminLogin(cfg, "admin", pw + "x"), false, "錯誤密碼不得通過");
  }
  // 兩支腳本各算一次，格式與參數完全相同（salt 與雜湊值當然不同）
  const a = parseHash(pyLocal("Same-Password-1"));
  const b = parseHash(pyHash("Same-Password-1"));
  assert.deepEqual([a.n, a.r, a.p, a.salt.length, a.hash.length], [b.n, b.r, b.p, b.salt.length, b.hash.length]);
  ok("local-setup.py 的雜湊與 set-admin-password.sh 同格式同參數，儀表板驗證通過（含中文、特殊字元、256 字元）");
}


console.log(`\n全部通過（${pass} 組）`);

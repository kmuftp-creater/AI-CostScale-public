// 偽造 session 的實測：用指定的密鑰，以 next-auth 簽發 session 的方式（@auth/core/jwt 的 encode）
// 自己簽一個 token，帶去打執行中的儀表板，看它收不收。
//
// 用途：驗證「AUTH_SECRET 是範本值、空值或太短時，儀表板不接受任何 session」。
//   - 密鑰沒設好（範本值）：用範本值簽的偽造 token 必須被拒（expect = reject）。
//   - 密鑰正常：用真密鑰簽的 token 必須被收（expect = accept），這是對照組，
//     證明偽造的方法（cookie 名稱、salt、格式）是對的，所以上面那個「被拒」不是因為簽錯了。
//
// next-auth 依「請求是不是 https」決定讀哪個 cookie 名稱：https 用帶前綴的 __Secure-authjs.session-token，
// http（例如本機安裝模式，網址是 http://localhost）用不帶前綴的 authjs.session-token。
// token 的 salt 就是 cookie 名稱，所以兩種名稱各簽一份、各測一次，不會漏掉真正會被讀取的那一個
// （2026-11-23 修正：先前只測帶前綴的名稱，http 部署實際讀的是另一個，測不到真正生效的 cookie）。
//
// 執行（簽 token 要能 import @auth/core，例如 dashboard 資料夾；儀表板容器裡沒有它，見 --print）：
//   node scripts/test-forged-session.mjs <儀表板網址> <reject|accept>
//   FORGE_SECRET=<密鑰> node scripts/test-forged-session.mjs --print        只印出兩種名稱各一份簽好的 token
//   FORGED_TOKEN_SECURE=<token> FORGED_TOKEN_PLAIN=<token> node test-forged-session.mjs <儀表板網址> <reject|accept>
//                                                                           用現成的 token 打伺服器
//   （舊的 FORGED_TOKEN 仍可用，等同 FORGED_TOKEN_SECURE）
// 簽名用的密鑰取自環境變數 FORGE_SECRET，沒有就用 AUTH_SECRET（在儀表板容器裡就是它自己的值）。
// 密鑰不會印出來。測試只送「空內容」的 POST，不會建立任何資料。
//
// 退出碼：全部符合預期為 0，否則為 1。
// accept 模式：伺服器一次只讀其中一種名稱，所以只要求至少一種名稱被完整接受。

const args = process.argv.filter((a) => a !== "--print");
const base = (args[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const expect = args[3] === "accept" ? "accept" : "reject";
const secret = process.env.FORGE_SECRET ?? process.env.AUTH_SECRET ?? "";

const VARIANTS = [
  { cookie: "__Secure-authjs.session-token", proto: "https", envToken: "FORGED_TOKEN_SECURE", legacyEnv: "FORGED_TOKEN" },
  { cookie: "authjs.session-token", proto: "http", envToken: "FORGED_TOKEN_PLAIN", legacyEnv: null },
];

async function forge(sec, salt) {
  const { encode } = await import("@auth/core/jwt");
  return encode({ token: { name: "forged-user", sub: "forged-user" }, secret: sec, salt, maxAge: 3600 });
}

// 只印 token（不打伺服器）：儀表板的容器裡沒有 @auth/core（已被打包進伺服器程式），
// 這時在有 node_modules 的機器上用 --print 產生兩種 cookie 名稱各一份 token，
// 再用環境變數 FORGED_TOKEN_SECURE、FORGED_TOKEN_PLAIN 帶進容器裡跑檢查。
if (process.argv.includes("--print")) {
  for (const v of VARIANTS) console.log(`${v.envToken}=${await forge(secret, v.cookie)}`);
  process.exit(0);
}

let fail = 0;
function check(name, okCond, detail) {
  console.log(`  ${okCond ? "通過" : "未通過"}  ${name}（${detail}）`);
  if (!okCond) fail += 1;
}

const results = [];
for (const v of VARIANTS) {
  const token = process.env[v.envToken] || (v.legacyEnv && process.env[v.legacyEnv]) || (await forge(secret, v.cookie));
  const headers = { cookie: `${v.cookie}=${token}`, "x-forwarded-proto": v.proto, "x-forwarded-for": "198.51.100.77" };
  console.log(`\n[cookie 名稱 ${v.cookie}]`);

  const home = await fetch(`${base}/`, { headers, redirect: "manual" });
  const loc = home.headers.get("location") ?? "";
  const api = await fetch(`${base}/api/apps`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  const sess = await fetch(`${base}/api/auth/session`, { headers });
  const hasUser = (await sess.text()).includes("forged-user");

  if (expect === "reject") {
    check("首頁帶偽造 token：被導去登入頁", home.status >= 300 && home.status < 400 && loc.includes("/login"), `status=${home.status} location=${loc}`);
    check("POST /api/apps 帶偽造 token：401", api.status === 401, `status=${api.status}`);
    check("/api/auth/session 看不到偽造的使用者", !hasUser, `status=${sess.status} 內容含偽造帳號=${hasUser}`);
  } else {
    const r = {
      cookie: v.cookie,
      ok: home.status === 200 && api.status !== 401 && hasUser,
      detail: `首頁 ${home.status}、/api/apps ${api.status}（空內容會回 400）、session 含帳號=${hasUser}`,
    };
    results.push(r);
    console.log(`  結果：${r.detail}`);
  }
}

if (expect === "accept") {
  const good = results.find((r) => r.ok);
  check(
    "真密鑰簽的 token：至少一種 cookie 名稱被完整接受",
    Boolean(good),
    good ? `被接受的是 ${good.cookie}` : results.map((r) => `${r.cookie}：${r.detail}`).join("；"),
  );
}

console.log(fail === 0 ? `\n全部符合預期（${expect}）` : `\n有 ${fail} 項不符合預期（${expect}）`);
process.exit(fail === 0 ? 0 : 1);

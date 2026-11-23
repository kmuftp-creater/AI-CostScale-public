import { isIP } from "node:net";

/**
 * 帳密登入的防暴力破解。計數放在行程記憶體（單一容器），重啟歸零。
 *
 * 規則：
 *   1. 同一個來源 IP，15 分鐘內失敗 5 次，鎖定 15 分鐘。鎖定中即使密碼正確也一律拒絕。
 *      計數採「先佔額度」：進 scrypt 驗證之前先用 reserveAttempt 記一次嘗試（第 5 次的額度被佔走時
 *      立刻鎖定），驗證成功再用 recordSuccess 退回。檢查與計數是同一個同步函式，中間沒有 await，
 *      所以同一來源在鎖定前最多只會進行 5 次驗證，不會因為同時到達的請求而多出十幾次。
 *   2. 全站 15 分鐘內失敗超過 30 次，之後每次嘗試固定延遲 2 秒（換 IP 狂試會被拖慢，
 *      也不會因此把管理員整個鎖在外面）。
 *
 * 來源 IP 取 X-Forwarded-For 最左邊一個，沒有就退回 X-Real-IP。這兩個標頭只有在反向代理
 * 會「覆寫」它們時才可信，所以只有環境變數 TRUST_PROXY=1 時才讀（docker-compose.vps.yml 設為 1）。
 * 沒設或不是 1（預設，例如本機安裝模式：前面沒有 nginx，用戶端可以任意填這兩個標頭）時一律不讀，
 * 所有來源算同一個 key（"unknown"）：本機只有自己在用，可以接受；代價是輸錯 5 次整個登入都鎖 15 分鐘。
 * 讀標頭時：INSTALL.md 的 nginx 設定把 X-Forwarded-For 設成 $remote_addr，
 * 用戶端自己帶的值會被丟掉。直接連 127.0.0.1:3300 繞過 nginx 的人可以偽造，但那只有主機上的人做得到。
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const IP_MAX_FAILS = 5;
export const GLOBAL_DELAY_THRESHOLD = 30;
export const GLOBAL_DELAY_MS = 2000;
export const MAX_TRACKED_IPS = 5000;

type IpState = { fails: number[]; lockedUntil: number };
type Store = { ips: Map<string, IpState>; global: number[] };

const g = globalThis as unknown as { __csLoginThrottle?: Store };
function store(): Store {
  if (!g.__csLoginThrottle) g.__csLoginThrottle = { ips: new Map(), global: [] };
  return g.__csLoginThrottle;
}

/** 測試用：清空全部計數。 */
export function resetThrottle(): void {
  g.__csLoginThrottle = { ips: new Map(), global: [] };
}

/** 來源無法辨識時共用的固定 key。 */
export const UNKNOWN_IP = "unknown";

/** 只收合法的 IPv4 或 IPv6 字串（不含 zone、埠號），回傳正規化後的寫法；不合法回 null。 */
function normalizeIp(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.length < 2 || v.length > 45) return null;
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind === 6 && !v.includes("%")) {
    try {
      // 交給 URL 正規化，同一個位址的不同寫法（::1、0:0:0:0:0:0:0:1）才會落在同一個 key
      return new URL(`http://[${v}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

/** 從請求標頭取來源 IP（TRUST_PROXY=1 才讀標頭）。只收合法的 IP，其餘一律歸成固定的 "unknown"（同一桶）。 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  if ((env.TRUST_PROXY ?? "").trim() !== "1") return UNKNOWN_IP;
  const cand = [headers.get("x-forwarded-for")?.split(",")[0], headers.get("x-real-ip")];
  for (const c of cand) {
    const v = normalizeIp(c ?? "");
    if (v) return v;
  }
  return UNKNOWN_IP;
}

function prune(now: number): void {
  const s = store();
  const cutoff = now - WINDOW_MS;
  while (s.global.length > 0 && s.global[0] <= cutoff) s.global.shift();
  if (s.ips.size > MAX_TRACKED_IPS / 2) {
    for (const [ip, st] of s.ips) {
      st.fails = st.fails.filter((t) => t > cutoff);
      if (st.fails.length === 0 && st.lockedUntil <= now) s.ips.delete(ip);
    }
  }
}

/**
 * 追蹤清單已達上限時，為新的來源騰出一個位置。先丟最舊的「沒在鎖定」項目；
 * 全部都在鎖定中（只有偽造標頭灌 5000 個以上的來源才會發生）才丟最舊的鎖定項目。
 */
function makeRoom(now: number): void {
  const s = store();
  while (s.ips.size >= MAX_TRACKED_IPS) {
    let victim: string | undefined;
    for (const [ip, st] of s.ips) {
      if (st.lockedUntil <= now) {
        victim = ip;
        break;
      }
    }
    if (victim === undefined) victim = s.ips.keys().next().value;
    if (victim === undefined) break;
    s.ips.delete(victim);
  }
}

/** 這個 IP 還要被鎖幾分鐘（無條件進位到分鐘）；沒被鎖回 0。 */
export function lockedMinutes(ip: string, now: number = Date.now()): number {
  const st = store().ips.get(ip);
  if (!st || st.lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((st.lockedUntil - now) / 60000));
}

/** 全站失敗數是否超過門檻，要不要延遲。 */
export function globalDelayMs(now: number = Date.now()): number {
  prune(now);
  return store().global.length > GLOBAL_DELAY_THRESHOLD ? GLOBAL_DELAY_MS : 0;
}

/**
 * 進驗證之前先佔一次嘗試額度。回傳 0 代表可以驗證（額度已佔）；回傳大於 0 是這個 IP 還要被鎖幾分鐘，
 * 不得進驗證。佔到第 IP_MAX_FAILS 次額度時立刻開始鎖定。
 * 這個函式是同步的：檢查與計數之間沒有 await，同時到達的請求會依序排隊取額度。
 */
export function reserveAttempt(ip: string, now: number = Date.now()): number {
  prune(now);
  const s = store();
  let st = s.ips.get(ip);
  if (st && st.lockedUntil > now) return Math.max(1, Math.ceil((st.lockedUntil - now) / 60000));
  if (!st) {
    makeRoom(now);
    st = { fails: [], lockedUntil: 0 };
    s.ips.set(ip, st);
  }
  st.lockedUntil = 0;
  const cutoff = now - WINDOW_MS;
  st.fails = st.fails.filter((t) => t > cutoff);
  st.fails.push(now);
  if (st.fails.length >= IP_MAX_FAILS) {
    st.lockedUntil = now + LOCK_MS;
    st.fails = [];
  }
  return 0;
}

/** 驗證確定失敗時呼叫：計入全站失敗數（該 IP 的次數在 reserveAttempt 已經記過）。 */
export function confirmFailure(now: number = Date.now()): void {
  prune(now);
  const s = store();
  s.global.push(now);
  if (s.global.length > 1000) s.global.splice(0, s.global.length - 1000);
}

/** 佔額度並確認失敗，一次做完（單元測試與不需要併發保護的呼叫端用）。 */
export function recordFailure(ip: string, now: number = Date.now()): void {
  reserveAttempt(ip, now);
  confirmFailure(now);
}

/** 驗證成功：退回這個 IP 佔掉的額度（連同失敗計數與鎖定一併清掉）。 */
export function recordSuccess(ip: string): void {
  store().ips.delete(ip);
}

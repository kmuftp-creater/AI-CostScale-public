/**
 * 帳密登入的防暴力破解。計數放在行程記憶體（單一容器），重啟歸零。
 *
 * 規則：
 *   1. 同一個來源 IP，15 分鐘內失敗 5 次，鎖定 15 分鐘。鎖定中即使密碼正確也一律拒絕。
 *   2. 全站 15 分鐘內失敗超過 30 次，之後每次嘗試固定延遲 2 秒（換 IP 狂試會被拖慢，
 *      也不會因此把管理員整個鎖在外面）。
 *
 * 來源 IP 取 X-Forwarded-For 最左邊一個，沒有就退回 X-Real-IP。這兩個標頭只有在反向代理
 * 會「覆寫」它們時才可信：INSTALL.md 的 nginx 設定把 X-Forwarded-For 設成 $remote_addr，
 * 用戶端自己帶的值會被丟掉。直接連 127.0.0.1:3300 繞過 nginx 的人可以偽造，但那只有主機上的人做得到。
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const IP_MAX_FAILS = 5;
export const GLOBAL_DELAY_THRESHOLD = 30;
export const GLOBAL_DELAY_MS = 2000;
const MAX_TRACKED_IPS = 5000;

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

/** 從請求標頭取來源 IP。只收看起來像 IP 的字串，其餘一律當 "unknown"（同一桶）。 */
export function clientIp(headers: Headers): string {
  const cand = [headers.get("x-forwarded-for")?.split(",")[0], headers.get("x-real-ip")];
  for (const c of cand) {
    const v = (c ?? "").trim().toLowerCase();
    if (v.length >= 2 && v.length <= 45 && /^[0-9a-f.:]+$/.test(v)) return v;
  }
  return "unknown";
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
  // 仍然太多（有人亂換標頭灌記憶體）：丟掉最舊的
  while (s.ips.size > MAX_TRACKED_IPS) {
    const first = s.ips.keys().next().value;
    if (first === undefined) break;
    s.ips.delete(first);
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

export function recordFailure(ip: string, now: number = Date.now()): void {
  prune(now);
  const s = store();
  s.global.push(now);
  if (s.global.length > 1000) s.global.splice(0, s.global.length - 1000);
  let st = s.ips.get(ip);
  if (!st) {
    st = { fails: [], lockedUntil: 0 };
    s.ips.set(ip, st);
  }
  if (st.lockedUntil <= now) {
    st.lockedUntil = 0;
    const cutoff = now - WINDOW_MS;
    st.fails = st.fails.filter((t) => t > cutoff);
    st.fails.push(now);
    if (st.fails.length >= IP_MAX_FAILS) {
      st.lockedUntil = now + LOCK_MS;
      st.fails = [];
    }
  }
}

export function recordSuccess(ip: string): void {
  store().ips.delete(ip);
}

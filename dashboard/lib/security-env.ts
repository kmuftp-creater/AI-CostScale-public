import { dbPasswordProblem, secretProblem } from "@/lib/secret-check";
import { isLocalMode } from "@/lib/mode";
import { buildSecurityWarnings, PassLogGate, type SecurityWarning } from "@/lib/security-warnings";

/** 依目前的環境變數算出要顯示的安全警告。每次請求都重算（只讀環境變數，幾乎沒有成本）。 */
export function currentSecurityWarnings(env: Record<string, string | undefined> = process.env): SecurityWarning[] {
  return buildSecurityWarnings(
    {
      authDisabled: env.AUTH_DISABLED === "1",
      masterKeyTemplate: secretProblem(env.LITELLM_MASTER_KEY) !== null,
      dbPasswordTemplate: dbPasswordProblem(env.DATABASE_URL) !== null,
    },
    isLocalMode(env),
  );
}

/** 儀表板啟動時呼叫一次（instrumentation.ts）：每一項警告各留一行 log。 */
export function logStartupSecurityWarnings(): void {
  for (const w of currentSecurityWarnings()) {
    console.warn(`[security] 警告：${w.tag}。${w.summary}`);
    for (const line of w.fix) console.warn(`[security]   修正：${line}`);
  }
}

const g = globalThis as unknown as { __csAuthDisabledGate?: PassLogGate };

/** AUTH_DISABLED=1 放行請求時呼叫。log 有節流，不會每個請求都印。 */
export function noteAuthDisabledPass(): void {
  if (!g.__csAuthDisabledGate) g.__csAuthDisabledGate = new PassLogGate();
  const msg = g.__csAuthDisabledGate.note();
  if (msg) console.warn(msg);
}

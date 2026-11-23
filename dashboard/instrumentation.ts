/**
 * Next.js 在伺服器啟動時呼叫 register() 一次。這裡只做一件事：把安全警告（AUTH_DISABLED=1、
 * 主金鑰或資料庫密碼是範本值）寫進 log，讓看 log 的人在啟動當下就看到。不阻擋啟動。
 * 建置階段不印（建置時的環境變數不是執行時的）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { logStartupSecurityWarnings } = await import("@/lib/security-env");
  logStartupSecurityWarnings();
}

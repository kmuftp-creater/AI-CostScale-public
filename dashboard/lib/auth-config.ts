import { getAdminConfig } from "@/lib/admin-password";
import { authSecretProblem, type SecretProblem } from "@/lib/secret-check";

/** .env 的值是否還沒填：空、placeholder、範本裡的 change-me。 */
function unset(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "" || s === "placeholder" || s.startsWith("change-me");
}

/** Google 登入只有在 ID 與密鑰都是真值時才啟用，範本預設值不算。 */
export function googleEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !unset(env.AUTH_GOOGLE_ID) && !unset(env.AUTH_GOOGLE_SECRET);
}

/** 帳密登入是否啟用（帳號與雜湊都有效）。 */
export function passwordEnabled(): boolean {
  return getAdminConfig() !== null;
}

/**
 * 登入頁用：目前有哪些登入方式。兩個都是 false 時，沒有任何人能登入。
 * secretProblem 不是 null 代表 AUTH_SECRET 沒設好，這時所有登入方式都停用（password、google 一律 false）。
 */
export function loginMethods(): { password: boolean; google: boolean; secretProblem: SecretProblem | null } {
  const secretProblem = authSecretProblem();
  if (secretProblem !== null) return { password: false, google: false, secretProblem };
  return { password: passwordEnabled(), google: googleEnabled(), secretProblem: null };
}

import { auth } from "@/auth";
import AppShell from "@/components/AppShell";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = process.env.AUTH_DISABLED === "1" ? null : await auth();
  // Google 登入有信箱；帳密登入沒有信箱，改顯示帳號。
  const userEmail = session?.user?.email ?? session?.user?.name ?? null;

  return <AppShell userEmail={userEmail}>{children}</AppShell>;
}

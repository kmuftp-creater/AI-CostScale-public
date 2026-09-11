import { auth } from "@/auth";
import AppShell from "@/components/AppShell";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const session = process.env.AUTH_DISABLED === "1" ? null : await auth();
  const userEmail = session?.user?.email ?? null;

  return <AppShell userEmail={userEmail}>{children}</AppShell>;
}

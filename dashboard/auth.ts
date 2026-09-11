import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

function allowedEmails(): string[] {
  return (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [Google],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const allow = allowedEmails();
      // 白名單為空時，出於安全考量一律拒絕（不能因為忘了設變數就對所有人開放）。
      if (allow.length === 0) return false;
      return allow.includes(email);
    },
    async session({ session }) {
      return session;
    },
  },
});

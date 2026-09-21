import { Suspense } from "react";
import Image from "next/image";
import { signOut } from "@/auth";
import NavRail from "./NavRail";
import ThemeToggle from "./ThemeToggle";
import BigScreenLink from "./BigScreenLink";
import DateRangeSeg from "./DateRangeSeg";
import BudgetBanner from "./BudgetBanner";
import ReminderBanner from "./ReminderBanner";
import ModelExpiryBanner from "./ModelExpiryBanner";

async function doSignOut() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default function AppShell({
  children,
  userEmail,
}: {
  children: React.ReactNode;
  userEmail: string | null;
}) {
  const initial = userEmail ? userEmail.charAt(0).toUpperCase() : "D";

  return (
    <div className="wrap">
      <header>
        <div className="masthead">
          <Image
            className="brandmark"
            src="/logo.png"
            alt="AI CostScale"
            width={30}
            height={30}
            priority
          />
          <div>
            <div className="brand-name">AI CostScale</div>
          </div>
          <span className="brand-sub">AI 用量與成本管理中心</span>
          <div className="masthead-tools">
            <Suspense fallback={null}>
              <DateRangeSeg />
            </Suspense>
            {/* 大屏在儀表板外框之外，按「返回儀表板」之後要能再回去（2026-09-12 User 回報）。
                按一下換下一種大屏風格，所以是按鈕不是連結，見 BigScreenLink.tsx。 */}
            <BigScreenLink />
            <ThemeToggle />
            <div className="who">
              <div className="avatar" title={userEmail ?? "開發模式"}>
                {initial}
              </div>
              <form action={doSignOut}>
                <button className="btn-ghost" style={{ border: "none", padding: "0.4rem 0.3rem" }} type="submit">
                  登出
                </button>
              </form>
            </div>
          </div>
        </div>
        <nav>
          <NavRail />
        </nav>
      </header>

      <main>
        {/* 預算超標時全站可見；資料庫不通或無預算時這裡什麼都不會渲染 */}
        <Suspense fallback={null}>
          <BudgetBanner />
        </Suspense>
        {/* 與預算橫幅分開：預算是正在發生的事，提醒是即將要做的決定 */}
        <Suspense fallback={null}>
          <ReminderBanner />
        </Suspense>
        {/* 閘道在用的模型十天內要停用（2026-09-21）。單獨一條是因為它的處理方式
            跟前兩者不同：要換模型、重測、重部署，不是去改一個設定值。 */}
        <Suspense fallback={null}>
          <ModelExpiryBanner />
        </Suspense>
        {children}
      </main>

      <footer>
        <span>v0.1</span>
        <span className="sep">/</span>
        <span>
          AI CostScale · 開源自架版
        </span>
      </footer>
    </div>
  );
}

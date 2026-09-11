import Link from "next/link";
import { evaluateBudgets } from "@/lib/db";
import { monthRange, formatUsd } from "@/lib/format";

/**
 * 全站橫幅：本月有預算超標或接近上限時顯示。
 *
 * 刻意放在 AppShell 而非個別頁面——超標是「不管你在看哪一頁都該知道」的事。
 * 資料庫不通時 evaluateBudgets 回空陣列，橫幅就不顯示，不會讓整站 500。
 */
export default async function BudgetBanner() {
  const range = monthRange(0);
  const statuses = await evaluateBudgets(new Date(range.from), new Date(range.to));
  const hits = statuses.filter((s) => s.enabled && s.level !== "ok");
  if (hits.length === 0) return null;

  const over = hits.filter((s) => s.level === "over");
  const critical = hits.filter((s) => s.level === "critical");
  const warn = hits.filter((s) => s.level === "warn");
  const worst = over.length > 0 ? "over" : critical.length > 0 ? "critical" : "warn";
  const TAG: Record<string, string> = { over: "超標", critical: "嚴重", warn: "接近上限" };

  const describe = (s: (typeof hits)[number]) => {
    const name =
      s.label ?? (s.scope === "global" ? "全域" : (s.app_name ?? "（軟體已刪除）"));
    return `${name} ${s.pct.toFixed(0)}%（US$${formatUsd(s.spend)} / US$${formatUsd(s.monthly_limit)}）`;
  };

  return (
    <div className={`budget-banner ${worst}`} role="status">
      <span className="budget-banner-tag">{TAG[worst]}</span>
      <span className="budget-banner-body">
        {[
          over.length > 0 ? `已超標：${over.map(describe).join("、")}` : null,
          critical.length > 0 ? `嚴重：${critical.map(describe).join("、")}` : null,
          warn.length > 0 ? `接近上限：${warn.map(describe).join("、")}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <Link className="budget-banner-link" href="/budgets">
        查看預算
      </Link>
    </div>
  );
}

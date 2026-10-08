import Link from "next/link";
import { evaluateCreditPools } from "@/lib/db";

/**
 * 「GCP 贈金快用完了，該換帳號」橫幅（2026-10-08）。預估餘額跌破警示線時出現。
 *
 * 信只寄一次，橫幅則一直掛到校正或補記贈金為止——
 * 信可能被當成垃圾信、可能沒人看，畫面上的紅字是最後一道。
 *
 * 字面上一定要寫「預估」：這個數字是錨點往下扣出來的，沒補記的新贈金不在裡面，
 * 寫成「剩 NT$40」會被當成控制台上的真實餘額。
 */
export default async function CreditBanner() {
  const pools = (await evaluateCreditPools()).filter(
    (p) => p.enabled && (p.level === "low" || p.level === "empty")
  );
  if (pools.length === 0) return null;

  const worst = pools.some((p) => p.level === "empty") ? "over" : "critical";
  const describe = (p: (typeof pools)[number]) =>
    p.level === "empty"
      ? `${p.label} 預估已用完（帳單資料到 ${p.dataThrough ?? "未知"}）`
      : `${p.label} 預估只剩 NT$${(p.estimateTwd as number).toFixed(0)}（警示線 NT$${p.warnBelowTwd.toFixed(0)}）`;

  return (
    <div className={`budget-banner ${worst}`} role="status">
      <span className="budget-banner-tag">{worst === "over" ? "贈金用完" : "贈金快用完"}</span>
      <span className="budget-banner-body">
        {pools.map(describe).join("、")}。先到控制台核對實際餘額，真的不夠就換帳號。
      </span>
      <Link className="budget-banner-link" href="/billing#credits">
        看餘額
      </Link>
    </div>
  );
}

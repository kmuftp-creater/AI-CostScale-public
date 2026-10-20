import Link from "next/link";
import { evaluateSpikes } from "@/lib/db";
import { formatUsd } from "@/lib/format";

/**
 * 「某個軟體今天花費暴增」橫幅（2026-10-21）。
 *
 * 信一天只寄一封，橫幅則整天都在——暴衝是「正在發生」的事，
 * 打開儀表板第一眼就要看到是哪個軟體，而不是去翻信箱。
 * 隔天（台北時間）自動消失；如果隔天還在暴衝，會重新判定、重新出現。
 */
export default async function SpikeBanner() {
  const status = await evaluateSpikes();
  const hits = status.rows.filter((r) => r.spiking);
  if (hits.length === 0) return null;

  const describe = (r: (typeof hits)[number]) =>
    r.ratio !== null
      ? `${r.name} 今天 US$${formatUsd(r.todayUsd)}，是平常的 ${r.ratio.toFixed(1)} 倍`
      : `${r.name} 今天 US$${formatUsd(r.todayUsd)}，前 7 天幾乎沒花錢`;

  return (
    <div className="budget-banner critical" role="status">
      <span className="budget-banner-tag">花費暴增</span>
      <span className="budget-banner-body">{hits.map(describe).join("、")}</span>
      <Link className="budget-banner-link" href="/budgets#spike">
        看明細
      </Link>
    </div>
  );
}

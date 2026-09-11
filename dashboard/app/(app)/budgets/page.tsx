import { evaluateBudgets, listApps, listRecentAlerts, getFxRate } from "@/lib/db";
import { monthRange } from "@/lib/format";
import BudgetsClient from "./BudgetsClient";

export const metadata = { title: "預算與告警 · AI CostScale" };
export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const range = monthRange(0);
  const [statuses, apps, alerts, fxRate] = await Promise.all([
    evaluateBudgets(new Date(range.from), new Date(range.to)),
    listApps(),
    listRecentAlerts(20),
    getFxRate(),
  ]);

  return (
    <BudgetsClient
      initial={statuses}
      apps={apps.map((a) => ({ id: a.id, name: a.name }))}
      alerts={alerts}
      fx={fxRate.rate}
    />
  );
}

import { evaluateBudgets, listApps, listRecentAlerts, getFxRate, evaluateSpikes } from "@/lib/db";
import { monthRange } from "@/lib/format";
import BudgetsClient from "./BudgetsClient";
import SpikePanel from "./SpikePanel";

export const metadata = { title: "預算與告警 · AI CostScale" };
export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const range = monthRange(0);
  const [statuses, apps, alerts, fxRate, spikes] = await Promise.all([
    evaluateBudgets(new Date(range.from), new Date(range.to)),
    listApps(),
    listRecentAlerts(20),
    getFxRate(),
    evaluateSpikes(),
  ]);

  return (
    <>
      <BudgetsClient
        initial={statuses}
        apps={apps.map((a) => ({ id: a.id, name: a.name }))}
        alerts={alerts}
        fx={fxRate.rate}
      />
      {/* 月預算看的是「這個月會不會超」，暴增看的是「今天是不是出事了」，分開放 */}
      <SpikePanel status={JSON.parse(JSON.stringify(spikes))} fx={fxRate.rate} />
    </>
  );
}

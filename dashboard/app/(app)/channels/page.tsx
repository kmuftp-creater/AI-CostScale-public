import { resolveRange } from "@/lib/range";
import RoutingSection from "./RoutingSection";
import TelemetrySection from "./TelemetrySection";

export const metadata = { title: "通道與用量 · AI CostScale" };
export const dynamic = "force-dynamic";

/**
 * 通道與用量（D-7，2026-08-25 由「路由與橋接」與「遙測」合併）。
 *
 * 為什麼合併：路由回答「有哪些路」、遙測回答「那些路跑了多少」，
 * 是同一件事的兩半。分成兩頁的結果是要判斷「某條通道現在有沒有問題」
 * 得在兩頁之間來回——而那正是 2026-08-23 橋接斷了 83 分鐘沒人發現的處境。
 *
 * 上半是通道現況（現場問，不讀設定檔副本），下半是那些通道實際的用量。
 */
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  // 這一頁原本只讀 range=last，from／to 是被忽略的：按「自訂」之後按鈕會亮、
  // 網址會變，數字仍是本月而微標仍寫「本月」。日期選單把這一頁列進
  // RANGE_AWARE，就得真的吃得下三種模式（2026-08-26 修）。
  const range = resolveRange(params);

  return (
    <>
      <section className="block">
        <div className="panel-head" style={{ marginTop: "var(--space-lg)" }}>
          <span className="panel-title">通道現況</span>
          <span className="microlabel">有哪些路 · 每次開頁重新現場問</span>
        </div>
      </section>
      <RoutingSection />

      <section className="block">
        <div className="panel-head" style={{ marginTop: "var(--space-lg)" }}>
          <span className="panel-title">通道用量</span>
          <span className="microlabel">
            那些路跑了多少 · 訂閱制 CLI · {range.label}
          </span>
        </div>
      </section>
      <TelemetrySection from={range.from} to={range.to} />
    </>
  );
}

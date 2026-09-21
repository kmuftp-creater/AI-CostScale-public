import { listSubscriptions, listSubscriptionCharges, getFxRate, getSettings } from "@/lib/db";
import SubscriptionsClient from "./SubscriptionsClient";
import FxSettingsClient from "./FxSettingsClient";

export const metadata = { title: "訂閱 · AI CostScale" };
export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const [subscriptions, charges, fxRate, settings] = await Promise.all([
    listSubscriptions(),
    listSubscriptionCharges(),
    getFxRate(),
    getSettings(),
  ]);

  // Server Component 傳給 Client Component 前先序列化，避免 Date 等型別無法跨界
  return (
    <>
      <SubscriptionsClient
        initial={JSON.parse(JSON.stringify(subscriptions))}
        charges={JSON.parse(JSON.stringify(charges))}
        fx={fxRate.rate}
        // 現在的牌告匯率（未加手續費）。扣款歷史要拿它跟凍結值比，
        // 所以不能用上面那個已經含手續費的 fxRate.rate。
        fxBase={fxRate.baseRate}
        // 台幣計價的海外訂閱要單獨乘服務費——它沒有匯率可以夾帶（db/init/32）。
        markupPct={fxRate.markupPct}
        fxDay={fxRate.day}
        fxStale={fxRate.stale}
      />

      {/* 匯率設定（D-6，2026-08-25 從設定頁搬來）。
          放頁尾是刻意的：這一頁上面每一個台幣金額都是它換算出來的，
          設定值離它的用途太遠時，改的人不知道自己在影響什麼。 */}
      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">匯率與手續費</span>
            <span className="microlabel">USD / TWD，每日自動抓取</span>
          </div>
          <FxSettingsClient
            initialFx={settings.fx_usd_twd ?? "32.5"}
            initialMarkup={settings.fx_markup_pct ?? "1.5"}
            fxInfo={JSON.parse(JSON.stringify(fxRate))}
          />
        </div>
      </section>
    </>
  );
}

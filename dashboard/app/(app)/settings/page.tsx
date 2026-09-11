import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "設定 · AI CostScale" };

/**
 * 設定頁（D-6，2026-08-25 起留空）。
 *
 * 原本這裡有兩塊：「匯率設定」與「免費額度上限」。兩塊都搬走了，
 * 理由是同一件事在兩個地方各講一半——
 * 免費額度的**消耗**畫在金鑰管理頁、**上限**卻只能在這裡改；
 * 匯率的**用途**全在訂閱頁、**數值**卻在這裡填。
 *
 * **頁面刻意保留、不移除**（User 裁決）：未來還是會有功能設在這裡，
 * 導覽項目留著，之後加東西不必再動路由與導覽。
 */
export default function SettingsPage() {
  return (
    <section className="block">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">設定</span>
          <span className="microlabel">目前沒有設在這一頁的項目</span>
        </div>
        <div className="empty-state">
          <span className="microlabel">Empty</span>
          這一頁目前是空的。
        </div>
        <div className="panel-foot">
          原本在這裡的兩塊已經搬到它們實際被用到的地方，
          避免「看得到的地方改不了、改得到的地方看不到」：
          <br />
          <strong>免費額度上限</strong>搬到<Link href="/keys">金鑰管理</Link>，
          跟今日消耗量並排，改完立刻看得到進度條的變化。
          <br />
          <strong>匯率與國外交易手續費</strong>搬到<Link href="/subscriptions">訂閱</Link>頁尾，
          就在被它換算的那些金額下面。
          <br />
          這一頁保留著，之後新增的設定項目會放回這裡。
        </div>
      </div>
    </section>
  );
}

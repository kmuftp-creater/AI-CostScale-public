import Link from "next/link";
import { listReminders } from "@/lib/db";

/**
 * 到期前一週的提醒橫幅。
 *
 * 兩種來源：軟體的訂閱設定複查日、年繳訂閱的續約日。
 * 兩者的共通點是「錯過就有代價」——前者是訂閱在不該用的地方持續被消耗，
 * 後者是再被綁一年。所以它們該提前提醒，而不是事後才發現。
 *
 * 刻意與預算橫幅分開：預算是「現在正在發生的事」，提醒是「即將要做的決定」，
 * 兩者的處理方式不同，混在一起會讓人失去對紅字的敏感度。
 */
export default async function ReminderBanner() {
  const items = await listReminders(7);
  if (items.length === 0) return null;

  const overdue = items.filter((i) => i.days < 0);
  const worst = overdue.length > 0 ? "over" : "warn";

  const describe = (i: (typeof items)[number]) => {
    const when =
      i.days < 0 ? `已過 ${-i.days} 天` : i.days === 0 ? "就是今天" : `剩 ${i.days} 天`;
    return `${i.name}（${i.detail}，${when}）`;
  };

  return (
    <div className={`budget-banner ${worst}`} role="status">
      <span className="budget-banner-tag">{overdue.length > 0 ? "已逾期" : "即將到期"}</span>
      <span className="budget-banner-body">{items.map(describe).join("、")}</span>
      <Link className="budget-banner-link" href="/apps">
        前往設定
      </Link>
    </div>
  );
}

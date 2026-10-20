import Link from "next/link";
import { listExpiringGatewayModels } from "@/lib/upstream-models";
import { countRecentCalls } from "@/lib/db";

/** 想改提前幾天，設 MODEL_EXPIRY_WARN_DAYS。不設就是十天。 */
function warnDays(): number {
  const n = Number(process.env.MODEL_EXPIRY_WARN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * 「閘道在用的模型快到期了」橫幅（2026-09-21，User：「到期前 10 天通知就好」）。
 *
 * 為什麼是十天而不是更早：模型到期這件事，供應商大多不會講
 * （實測只有 OpenRouter 有 expiration_date），能拿到日期的本來就少；
 * 太早提醒會變成長期掛在畫面上的一行字，人會習慣性略過它。
 * 十天足夠換模型、重測、重部署，又短到看見時還會動手。
 *
 * 與金鑰管理頁那個「快到期」的分工：那裡是清單，給人查；
 * 這裡是通知，只講**閘道真的在用**而且**十天內**的那幾支。
 *
 * 日期的來源一定要寫出來。交叉參考來的日期是 OpenRouter 對它自己平台的宣告，
 * 不是 Google 的公告——不講清楚的話，這行字會被當成原廠通知。
 */
export default async function ModelExpiryBanner() {
  const items = await listExpiringGatewayModels(warnDays());
  if (items.length === 0) return null;
  // 2026-10-21：沒人在用的模型也會一直掛在這裡，看的人會以為要趕著換模型。
  // 橫幅看的是「設定檔裡還留著這個部署」，不是「有沒有人在用」。把用量寫出來，
  // 0 次的人一看就知道該做的是移除部署，而不是趕著換模型。
  const calls = await countRecentCalls(items.map((i) => i.modelName), 30);

  const overdue = items.filter((i) => i.days < 0);
  const worst = overdue.length > 0 ? "over" : "warn";

  const describe = (i: (typeof items)[number]) => {
    const when = i.days < 0 ? `已過期 ${-i.days} 天` : i.days === 0 ? "就是今天" : `剩 ${i.days} 天`;
    // OpenRouter 的日期是它自己平台的宣告；部署若接的是別家（例如 Vertex），那邊不一定同一天停。
    const who =
      i.expiresFrom === "openrouter"
        ? i.backendModel.startsWith("openrouter/")
          ? "OpenRouter 宣告"
          : "OpenRouter 對它自己平台的宣告，這個部署接的是別家，不一定同一天停"
        : "供應商宣告";
    const used = calls === null ? "" : `，最近 30 天經閘道 ${calls[i.modelName] ?? 0} 次`;
    return `${i.modelName}（${i.backendModel}，${who} ${i.expires} 停用，${when}${used}）`;
  };
  const allIdle = calls !== null && items.every((i) => (calls[i.modelName] ?? 0) === 0);

  return (
    <div className={`budget-banner ${worst}`} role="status">
      <span className="budget-banner-tag">{overdue.length > 0 ? "模型已停用" : "模型快停用"}</span>
      <span className="budget-banner-body">
        {items.map(describe).join("、")}
        {/* 介面目前只有「換掉」沒有「移除」。以模型命名的部署（gemini-2.5-flash 這種）
            到期後應該移除而不是換掉——換掉之後名字會說謊（2026-09-21 踩過）。 */}
        {allIdle
          ? "。最近都沒人在用：該做的是把部署從閘道拿掉（介面還沒有移除按鈕，要從主機設定檔移除），拿掉後這條就會消失。"
          : "。還有人在用：先在金鑰管理頁按「換掉」改成別的模型；以模型命名的部署則請專案改送別的名字，再把它移除。"}
      </span>
      <Link className="budget-banner-link" href="/keys">
        看可用模型
      </Link>
    </div>
  );
}

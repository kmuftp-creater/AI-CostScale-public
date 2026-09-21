import Link from "next/link";
import { listExpiringGatewayModels } from "@/lib/upstream-models";

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

  const overdue = items.filter((i) => i.days < 0);
  const worst = overdue.length > 0 ? "over" : "warn";

  const describe = (i: (typeof items)[number]) => {
    const when = i.days < 0 ? `已過期 ${-i.days} 天` : i.days === 0 ? "就是今天" : `剩 ${i.days} 天`;
    const who = i.expiresFrom === "openrouter" ? "OpenRouter 宣告" : "供應商宣告";
    return `${i.modelName}（${i.backendModel}，${who} ${i.expires} 停用，${when}）`;
  };

  return (
    <div className={`budget-banner ${worst}`} role="status">
      <span className="budget-banner-tag">{overdue.length > 0 ? "模型已停用" : "模型快停用"}</span>
      <span className="budget-banner-body">{items.map(describe).join("、")}</span>
      <Link className="budget-banner-link" href="/keys">
        看可用模型
      </Link>
    </div>
  );
}

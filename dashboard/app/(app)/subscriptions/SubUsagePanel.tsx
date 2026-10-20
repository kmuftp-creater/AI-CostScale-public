import type { SubQuotaRecommendation, SubQuotaRow, SubQuotaStatus } from "@/lib/db";

const REC_TEXT: Record<SubQuotaRecommendation, string> = {
  insufficient: "資料不足",
  "never-used": "這 30 天完全沒用到",
  "hit-limit": "曾經用滿，降級會不夠用",
  downgrade: "用不到三成，可以考慮降級",
  moderate: "使用量適中",
  "five-hour-only": "只有 5 小時視窗，無對應的週視窗",
};

function pct(n: number | null): string {
  return n === null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

function taipei(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function name(r: SubQuotaRow): string {
  return `${r.provider} · ${r.windowLabel}${r.plan ? `（${r.plan}）` : ""}`;
}

/**
 * 額度使用率（過去 30 天）（2026-10-21）。
 *
 * 以 provider＋視窗名稱為單位，不歸到某一筆訂閱：閘道只抓得到一個 Claude 帳號，
 * 訂閱表與 provider 之間也沒有對應關係。
 */
export default function SubUsagePanel({ status }: { status: SubQuotaStatus }) {
  return (
    <section className="block tight" id="sub-usage">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">額度使用率（過去 30 天）</span>
          <span className="microlabel">方案額度實際用到幾成，該不該降級</span>
        </div>

        {status.error ? (
          <div className="form-error">算不出來：{status.error}。這不代表沒有使用資料。</div>
        ) : status.rows.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            過去 30 天沒有訂閱額度的使用紀錄。
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {status.rows.map((r) => {
                const flagged = r.recommendation === "hit-limit" || r.recommendation === "downgrade" || r.recommendation === "never-used";
                const weekly = r.recommendation !== "five-hour-only";
                return (
                  <tr key={`${r.provider}|${r.windowLabel}`} className={flagged ? "row-flagged" : undefined}>
                    <td className="t-name">
                      {name(r)}
                      <small>
                        {weekly
                          ? `已結束 ${r.endedCycles} 週 · 本週目前 ${pct(r.currentUsed)}，${taipei(r.currentResetAt)} 重置（台北時間）`
                          : "沒有對應的週視窗，單獨列出"}
                      </small>
                    </td>
                    <td className="t-kind">
                      {weekly ? `平均 ${pct(r.avgPeak)} · 最高 ${pct(r.maxPeak)}` : "—"}
                    </td>
                    <td className="t-amt">
                      {weekly ? `用滿 ${r.fullCycles} 週` : "—"}
                      <small>
                        {r.fiveHourFull === null
                          ? "5 小時視窗：無對應"
                          : `${r.fiveHourLabel} 用滿 ${r.fiveHourFull} 次`}
                      </small>
                    </td>
                    <td className="t-act">
                      <span className="microlabel">{REC_TEXT[r.recommendation]}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="panel-foot">
          建議依過去 30 天，僅供參考。用的是每週視窗「每個週期的峰值」，不是 15 分鐘樣本的平均：
          視窗的數值是累計的，一重置就掉回低值，取平均會被重置後的低值拉低。已結束少於 2 週的資料不足，不給建議。
          資料只留 30 天。閘道只看得到一個 Claude 帳號，無法自動對應到你的哪一筆 Claude 訂閱，
          所以這裡不歸到訂閱列，請自己對照。
        </div>
      </div>
    </section>
  );
}

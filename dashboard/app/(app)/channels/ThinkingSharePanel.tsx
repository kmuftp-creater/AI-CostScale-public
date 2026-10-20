import type { AppModelUsage } from "@/lib/db";

type Line = {
  key: string;
  appName: string;
  model: string;
  names: string[];
  completion: number;
  reasoning: number;
  reportedCalls: number;
  reasoningCostUsd: number;
  appSpendUsd: number;
};

const FLAG_SHARE = 0.5;
const FLAG_COST_USD = 0.1;

function usd(n: number): string {
  return `US$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

function nt(n: number, fx: number): string {
  return `NT$${(n * fx).toFixed(n * fx > 0 && n * fx < 1 ? 2 : 0)}`;
}

function tok(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 同一軟體同一實際模型的不同部署名合併成一列；只留 30 天內有輸出的。 */
function buildLines(usage: AppModelUsage): Line[] {
  const appSpend = new Map<number, number>();
  for (const r of usage.rows) appSpend.set(r.appId, (appSpend.get(r.appId) ?? 0) + r.spendUsd);

  const map = new Map<string, Line>();
  for (const r of usage.rows) {
    const key = `${r.appId}|${r.model}`;
    let l = map.get(key);
    if (!l) {
      l = {
        key,
        appName: r.appName,
        model: r.model,
        names: [],
        completion: 0,
        reasoning: 0,
        reportedCalls: 0,
        reasoningCostUsd: 0,
        appSpendUsd: appSpend.get(r.appId) ?? 0,
      };
      map.set(key, l);
    }
    if (r.modelGroup && !l.names.includes(r.modelGroup)) l.names.push(r.modelGroup);
    l.completion += r.completionTokens;
    l.reasoning += r.reasoningTokens;
    l.reportedCalls += r.reasoningReportedCalls;
    l.reasoningCostUsd += r.reasoningCostUsd;
  }
  return [...map.values()]
    .filter((l) => l.completion > 0)
    .sort((a, b) => b.reasoningCostUsd - a.reasoningCostUsd || b.completion - a.completion);
}

/**
 * 思考 token 佔比（2026-10-21）。
 *
 * 純顯示元件，用量由頁面取好傳進來（與換模型試算共用同一次查詢）。
 * 查詢失敗寫「算不出來」，與「沒有資料」分開。
 * 「沒有回報思考量」（reasoningReportedCalls 為 0）與「回報了、值為 0」是兩個分支，不可混成 0%。
 */
export default function ThinkingSharePanel({ usage, fx }: { usage: AppModelUsage; fx: number }) {
  const lines = usage.error ? [] : buildLines(usage);

  return (
    <section className="block tight" id="thinking-share">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">思考 token 佔比</span>
          <span className="microlabel">過去 {usage.days} 天 · 輸出裡有多少是模型自己在想</span>
        </div>

        {usage.error ? (
          <div className="form-error">算不出來：{usage.error}。這不代表模型沒有在思考。</div>
        ) : lines.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            過去 {usage.days} 天沒有任何軟體經閘道產生輸出。
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {lines.map((l) => {
                const reported = l.reportedCalls > 0;
                const share = l.completion > 0 ? l.reasoning / l.completion : 0;
                const flagged = reported && share >= FLAG_SHARE && l.reasoningCostUsd >= FLAG_COST_USD;
                const appShare = l.appSpendUsd > 0 ? l.reasoningCostUsd / l.appSpendUsd : 0;
                return (
                  <tr key={l.key} className={flagged ? "row-flagged" : undefined}>
                    <td className="t-name">
                      {l.appName} · {l.model.replace(/^[^/]+\//, "")}
                      <small>部署名：{l.names.length > 0 ? l.names.join("、") : "（未記錄）"}</small>
                    </td>
                    {reported ? (
                      <>
                        <td className="t-kind">
                          思考 {pct(share)}
                          <small>
                            輸出 {tok(l.completion)} · 思考 {tok(l.reasoning)} · 可見 {tok(Math.max(l.completion - l.reasoning, 0))}
                          </small>
                        </td>
                        <td className="t-amt">
                          {usd(l.reasoningCostUsd)}
                          <small>（約 {nt(l.reasoningCostUsd, fx)}）</small>
                        </td>
                        <td className="t-act">
                          <span className="microlabel">占該軟體 {pct(appShare)}</span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="t-kind">
                          這支模型沒有回報思考量
                          <small>輸出 {tok(l.completion)}</small>
                        </td>
                        <td className="t-amt">—</td>
                        <td className="t-act">
                          <span className="microlabel">無法計算</span>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="panel-foot">
          思考 token 是模型在回答之前自己推理用的，計費跟輸出一樣，但不會出現在回答裡。
          這裡的數字取自閘道記帳，依思考花費由高到低排列；同一軟體同一模型的多個部署名合併成一列。
          「沒有回報」只代表閘道沒有記到思考量，不等於模型沒思考。
          思考佔比 ≥ 50% 且思考花費 ≥ US$0.10 的列會標色。
          Gemini 原生格式送 thinkingConfig.thinkingBudget: 0 實測可以關掉思考（同一句話成本差約 40 倍），
          但 OpenAI 相容格式的 reasoning_effort: none 對 gemini-3.8-flash 會回 400。
          關掉思考會影響回答品質，要逐個用途評估。
        </div>
      </div>
    </section>
  );
}

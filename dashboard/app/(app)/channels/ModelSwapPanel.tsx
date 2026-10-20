import type { AppModelUsage, AppModelUsageRow } from "@/lib/db";
import type { LiveDeployment } from "@/lib/keys";

/**
 * configNames＝設定檔裡明寫的部署名。閘道的 /model/info 會把萬用規則（gemini-*）展開成
 * LiteLLM 知道的每一支型號，那些多半是這個 GCP 專案沒開通的，不能當候選（同 keys.ts 的處理）。
 */
export type ModelSwapGateway = { live: LiveDeployment[]; configNames: string[]; error: string | null };

type Candidate = {
  backendModel: string;
  names: string[];
  inPerM: number;
  outPerM: number;
  cachePerM: number;
};

type Estimate = Candidate & { low: number; high: number; current: boolean };

type AppSummary = {
  appId: number;
  name: string;
  actual: number;
  models: { model: string; spend: number }[];
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
};

function usd(n: number): string {
  return `US$${n.toFixed(2)}`;
}

function pct(n: number): string {
  const v = Math.round(n * 100);
  return `${v > 0 ? "+" : ""}${v}%`;
}

function isExcludedName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    !name ||
    n.startsWith("sub-") ||
    name.includes("*") ||
    n === "gemini-flash-free" ||
    n.includes("image") ||
    n.includes("embedding") ||
    n === "openrouter-auto"
  );
}

/** 把閘道的部署合併成「一個底層模型一列」，排除免費、生圖、嵌入、單價不固定與拿不到單價的。 */
function buildCandidates(live: LiveDeployment[], configNames: string[]): Candidate[] {
  const configured = new Set(configNames);
  const byModel = new Map<string, Candidate>();
  for (const d of live) {
    if (!configured.has(d.modelName) || isExcludedName(d.modelName) || !d.backendModel) continue;
    const bm = d.backendModel.toLowerCase();
    if (bm.includes("image") || bm.includes("embedding") || bm.includes("sub-")) continue;
    if (!(d.effInputPerMTok > 0) || !(d.effOutputPerMTok > 0)) continue;
    const hit = byModel.get(d.backendModel);
    if (hit) {
      if (!hit.names.includes(d.modelName)) hit.names.push(d.modelName);
      continue;
    }
    byModel.set(d.backendModel, {
      backendModel: d.backendModel,
      names: [d.modelName],
      inPerM: d.effInputPerMTok,
      outPerM: d.effOutputPerMTok,
      cachePerM: d.cacheReadPerMTok != null && d.cacheReadPerMTok >= 0 ? d.cacheReadPerMTok : d.effInputPerMTok,
    });
  }
  return [...byModel.values()];
}

function summarize(rows: AppModelUsageRow[]): AppSummary[] {
  const map = new Map<number, AppSummary>();
  for (const r of rows) {
    // 訂閱通道不按 token 計費，不納入「如果換成付費模型」的基準
    if (r.modelGroup.toLowerCase().startsWith("sub-") || r.model.toLowerCase().includes("sub-")) continue;
    let s = map.get(r.appId);
    if (!s) {
      s = { appId: r.appId, name: r.appName, actual: 0, models: [], prompt: 0, cached: 0, completion: 0, reasoning: 0 };
      map.set(r.appId, s);
    }
    s.actual += r.spendUsd;
    s.prompt += r.promptTokens;
    s.cached += r.cachedPromptTokens;
    s.completion += r.completionTokens;
    s.reasoning += r.reasoningTokens;
    const m = s.models.find((x) => x.model === r.model);
    if (m) m.spend += r.spendUsd;
    else s.models.push({ model: r.model, spend: r.spendUsd });
  }
  return [...map.values()].filter((s) => s.actual > 0).sort((a, b) => b.actual - a.actual);
}

function estimate(s: AppSummary, c: Candidate): { low: number; high: number } {
  const cached = Math.min(s.cached, s.prompt);
  const inputCost = ((s.prompt - cached) * c.inPerM + cached * c.cachePerM) / 1_000_000;
  const high = inputCost + (s.completion * c.outPerM) / 1_000_000;
  const low = inputCost + (Math.max(s.completion - s.reasoning, 0) * c.outPerM) / 1_000_000;
  return { low, high };
}

/**
 * 換模型試算（2026-10-21）。
 *
 * 用過去 30 天每個軟體實際送出的 token 套上其他模型的單價。純顯示元件：
 * 用量與單價都由頁面取好傳進來，查詢失敗時整個面板寫「算不出來」，不補一份看起來正常的空表。
 */
export default function ModelSwapPanel({
  usage,
  gateway,
  fx,
}: {
  usage: AppModelUsage;
  gateway: ModelSwapGateway;
  fx: number;
}) {
  const error = usage.error ?? gateway.error;
  const candidates = error ? [] : buildCandidates(gateway.live, gateway.configNames);
  const apps = error ? [] : summarize(usage.rows);

  return (
    <section className="block tight" id="model-swap">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">換模型試算</span>
          <span className="microlabel">過去 {usage.days} 天 · 每個軟體改用別的模型要花多少</span>
        </div>

        {error ? (
          <div className="form-error">算不出來：{error}。這不代表換模型不會有差別。</div>
        ) : apps.length === 0 || candidates.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            {apps.length === 0
              ? `過去 ${usage.days} 天沒有任何軟體經閘道花錢。`
              : "閘道上沒有拿得到單價的付費模型可以比。"}
          </div>
        ) : (
          apps.map((s) => {
            const all: Estimate[] = candidates.map((c) => ({
              ...c,
              ...estimate(s, c),
              current: s.models.some((m) => m.model === c.backendModel),
            }));
            const others = all.filter((e) => !e.current).sort((a, b) => a.high - b.high);
            const cheapest = others[0];
            const shown = [
              ...all.filter((e) => e.current).sort((a, b) => b.high - a.high),
              ...others.slice(0, 7),
            ];
            return (
              <div key={s.appId}>
                <div className="panel-head">
                  <span className="panel-title">{s.name}</span>
                  <span className="microlabel">
                    實際 {usd(s.actual)}（約 NT${(s.actual * fx).toFixed(0)}）·{" "}
                    {[...s.models]
                      .filter((m) => m.spend > 0)
                      .sort((a, b) => b.spend - a.spend)
                      .map((m) => m.model.replace(/^[^/]+\//, ""))
                      .join("、")}
                  </span>
                </div>
                <table className="ledger">
                  <tbody>
                    {shown.map((e) => {
                      const flagged = cheapest !== undefined && e.backendModel === cheapest.backendModel;
                      return (
                        <tr key={e.backendModel} className={flagged ? "row-flagged" : undefined}>
                          <td className="t-name">
                            {e.backendModel.replace(/^[^/]+\//, "")}
                            <small>部署名：{e.names.join("、")}</small>
                          </td>
                          <td className="t-kind">{e.current ? "〔目前〕" : flagged ? "〔最便宜〕" : "〔候選〕"}</td>
                          <td className="t-amt">
                            約 {usd(e.low)}～{usd(e.high)}
                            <small>（約 NT${(e.low * fx).toFixed(0)}～{(e.high * fx).toFixed(0)}）</small>
                          </td>
                          <td className="t-act">
                            <span className="microlabel">
                              {`${pct((e.low - s.actual) / s.actual)}～${pct((e.high - s.actual) / s.actual)}`}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })
        )}

        <div className="panel-foot">
          這是把過去 {usage.days} 天實際送出的 token（快取命中的輸入按快取價）套上各模型目前的單價所得的估算，不是帳單。
          範圍是因為換模型後思考量不同：下限假設新模型完全不思考，上限假設思考量跟現在一樣。
          只比錢，沒有考慮回答品質，便宜的不一定夠用。
          免費層、訂閱通道、生圖、嵌入、單價不固定的自動路由不列；同一個底層模型的多個部署名合併成一列。
          增減是相對於該軟體過去 {usage.days} 天的實際花費。
        </div>
      </div>
    </section>
  );
}

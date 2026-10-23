import Link from "next/link";
import {
  getFeatureUsage,
  getRequestLog,
  sanitizeRequestFilters,
  type RequestFilters,
} from "@/lib/db";
import { formatTaipei } from "@/lib/format";
import { resolveRange } from "@/lib/range";

export const metadata = { title: "請求紀錄 · AI CostScale" };
export const dynamic = "force-dynamic";

type SP = {
  range?: string;
  from?: string;
  to?: string;
  app?: string;
  tag?: string;
  status?: string;
  page?: string;
};

function usd(n: number): string {
  return `US$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

function nt(n: number, fx: number): string {
  const v = n * fx;
  return `NT$${v.toFixed(v > 0 && v < 1 ? 2 : 0)}`;
}

function tok(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 保留頁首日期區間參數，再疊上這一頁自己的篩選。 */
function buildHref(base: SP, filters: Partial<RequestFilters>): string {
  const q = new URLSearchParams();
  if (base.range) q.set("range", base.range);
  if (base.from) q.set("from", base.from);
  if (base.to) q.set("to", base.to);
  if (filters.app && filters.app !== "all") q.set("app", filters.app);
  if (filters.tag) q.set("tag", filters.tag);
  if (filters.status && filters.status !== "all") q.set("status", filters.status);
  if (filters.page && filters.page > 1) q.set("page", String(filters.page));
  const s = q.toString();
  return `/requests${s ? `?${s}` : ""}`;
}

export default async function RequestsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const params = await searchParams;
  const range = resolveRange(params);
  const filters = sanitizeRequestFilters(params);
  const from = new Date(range.from);
  const to = new Date(range.to);
  const [features, log] = await Promise.all([getFeatureUsage(from, to), getRequestLog(from, to, filters)]);

  const totalPages = Math.max(Math.ceil(log.total / log.pageSize), 1);
  const tagOptions =
    filters.tag && !log.tagOptions.includes(filters.tag) ? [filters.tag, ...log.tagOptions] : log.tagOptions;
  const firstNo = log.total === 0 ? 0 : (log.page - 1) * log.pageSize + 1;
  const lastNo = (log.page - 1) * log.pageSize + log.rows.length;

  return (
    <>
      <section className="block tight" id="by-feature">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">依 feature 加總</span>
            <span className="microlabel">
              {range.fromDay} ～ {range.toDay} · 台北時間
            </span>
          </div>

          {features.error ? (
            <div className="form-error">算不出來：{features.error}。這不代表這段期間沒有請求。</div>
          ) : features.rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              這段期間沒有任何請求。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {features.rows.map((f) => (
                  <tr key={f.feature} className={f.failures > 0 ? "row-flagged" : undefined}>
                    <td className="t-name">
                      {f.tagged ? (
                        <Link href={buildHref(params, { tag: f.feature })}>{f.feature}</Link>
                      ) : (
                        f.feature
                      )}
                      <small>軟體：{f.apps.join("、")}</small>
                    </td>
                    <td className="t-kind">
                      {f.calls.toLocaleString("en-US")} 次
                      <small>
                        失敗 {f.failures.toLocaleString("en-US")} · 最近 {formatTaipei(f.lastAt, true)}
                      </small>
                    </td>
                    <td className="t-kind">
                      輸入 {tok(f.promptTokens)}
                      <small>輸出 {tok(f.completionTokens)}</small>
                    </td>
                    <td className="t-amt">
                      {usd(f.spendUsd)}
                      <small>（約 {nt(f.spendUsd, features.fxRate)}）</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="panel-foot">
            一筆請求帶多個 feature 標籤時，每個 feature 各算一次，所以各列次數與花費相加會大於實際總量。
            沒有 feature 標籤的請求歸在「（未標示 feature）」。依花費由高到低；有失敗請求的列會標色。
            點 feature 名稱會在下方篩出它的逐筆紀錄。
          </div>
        </div>
      </section>

      <section className="block tight" id="request-log">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">逐筆紀錄</span>
            <span className="microlabel">
              共 {log.total.toLocaleString("en-US")} 筆 · 每頁 {log.pageSize} 筆
            </span>
          </div>

          <form method="get" action="/requests" className="sub-form">
            {params.range ? <input type="hidden" name="range" value={params.range} /> : null}
            {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
            {params.to ? <input type="hidden" name="to" value={params.to} /> : null}
            <label>
              軟體
              <select name="app" defaultValue={filters.app}>
                <option value="all">全部</option>
                <option value="none">未歸戶</option>
                {log.appOptions.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                    {a.status === "active" ? "" : "（已封存）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              標籤
              <select name="tag" defaultValue={filters.tag}>
                <option value="">全部</option>
                {tagOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              狀態
              <select name="status" defaultValue={filters.status}>
                <option value="all">全部</option>
                <option value="success">成功</option>
                <option value="failure">失敗</option>
              </select>
            </label>
            <button type="submit" className="btn-primary">
              套用篩選
            </button>
          </form>

          {log.error ? (
            <div className="form-error">算不出來：{log.error}。這不代表沒有符合的請求。</div>
          ) : log.rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              這段期間沒有符合篩選的請求。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {log.rows.map((r) => (
                  <tr key={r.requestId} className={r.status === "failure" ? "row-flagged" : undefined}>
                    <td className="t-name">
                      {formatTaipei(r.at, true)}
                      <small>{r.appName}</small>
                    </td>
                    <td className="t-kind">
                      {r.modelGroup || "（未記錄部署名）"}
                      <small>{r.model.replace(/^[^/]+\//, "")}</small>
                    </td>
                    <td className="t-kind">
                      {r.status === "success" ? "成功" : r.status === "failure" ? "失敗" : r.status || "—"}
                      <small>
                        輸入 {tok(r.promptTokens)} · 輸出 {tok(r.completionTokens)} · 思考{" "}
                        {r.reasoningTokens === null ? "—" : tok(r.reasoningTokens)}
                      </small>
                    </td>
                    <td className="t-amt">{usd(r.spendUsd)}</td>
                    <td className="t-kind">
                      {r.tags.length > 0 ? r.tags.join("、") : "（無標籤）"}
                      {r.userAgent.length > 0 ? (
                        <small>
                          <span className="microlabel">{r.userAgent.join("、")}</span>
                        </small>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!log.error && log.total > 0 ? (
            <div className="panel-foot">
              第 {log.page} / {totalPages} 頁 · 第 {firstNo}～{lastNo} 筆，共 {log.total.toLocaleString("en-US")} 筆
              {log.page > 1 ? (
                <>
                  {" · "}
                  <Link href={buildHref(params, { ...filters, page: log.page - 1 })}>上一頁</Link>
                </>
              ) : null}
              {log.page < totalPages ? (
                <>
                  {" · "}
                  <Link href={buildHref(params, { ...filters, page: log.page + 1 })}>下一頁</Link>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="panel-foot">
            這一頁只讀計量資料，不顯示也不讀取對話內容。標籤由呼叫端在請求裡帶，時間為台北時間。
          </div>
        </div>
      </section>
    </>
  );
}

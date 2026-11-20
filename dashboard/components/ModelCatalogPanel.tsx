import { Fragment } from "react";
import { getModelCatalog, PRICING_TEXT, type ModelCatalogRow } from "@/lib/model-catalog";
import { KIND_HINT } from "@/lib/model-kind";

/**
 * 模型對照表（2026-11-20）。
 *
 * 回答一個問題：「專案裡填的這個名稱，到底是哪個模型、走哪條通道、錢記在哪個帳號」。
 * 資料來源與設計理由見 lib/model-catalog.ts。
 *
 * 最後一欄是最近 7 天的實際呼叫結果，不是設定檔的宣告——設定檔寫了不代表打得通。
 */
function callsText(r: ModelCatalogRow): { text: string; bad: boolean } {
  if (r.isWildcard) return { text: "—", bad: false };
  if (!r.calls) return { text: "查不到", bad: false };
  const { ok, fail } = r.calls;
  if (ok === 0 && fail === 0) return { text: "沒有人用", bad: false };
  if (ok === 0) return { text: `全部失敗（${fail} 次）`, bad: true };
  if (fail === 0) return { text: `成功 ${ok.toLocaleString("en-US")} 次`, bad: false };
  return { text: `成功 ${ok.toLocaleString("en-US")} · 失敗 ${fail.toLocaleString("en-US")}`, bad: fail > ok };
}

export default async function ModelCatalogPanel() {
  const catalog = await getModelCatalog();

  return (
    <section className="block tight" id="models">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">模型對照表</span>
          <span className="microlabel">專案裡填的名稱，實際是哪個模型、誰付錢</span>
        </div>

        {catalog.error ? <div className="form-error">{catalog.error}</div> : null}

        {catalog.rows.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            讀不到閘道設定檔，列不出模型。
          </div>
        ) : (
          <div className="table-scroll">
            <table className="ledger model-catalog">
              <thead>
                <tr>
                  <th>專案裡填的名稱</th>
                  <th>實際模型</th>
                  <th>通道</th>
                  <th>付費帳號</th>
                  <th>計費</th>
                  <th>最近 7 天</th>
                </tr>
              </thead>
              <tbody>
                {catalog.groups.map((g) => (
                  <Fragment key={g.kind}>
                    <tr className="mc-group">
                      <td colSpan={6}>
                        {g.kind}
                        <span>{KIND_HINT[g.kind]}</span>
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const c = callsText(r);
                      return (
                        <tr key={r.name}>
                          <td className="t-name">
                            <code>{r.name}</code>
                            {r.sameAs.length > 0 ? (
                              <small>
                                與 {r.sameAs.map((n, i) => (
                                  <Fragment key={n}>
                                    {i > 0 ? "、" : ""}
                                    <code>{n}</code>
                                  </Fragment>
                                ))}{" "}
                                完全相同
                              </small>
                            ) : null}
                            {r.isWildcard ? <small>萬用規則：名稱符合這個樣式、上面又沒列出的，都走這一條</small> : null}
                          </td>
                          <td>
                            {r.provider === "訂閱橋接" ? (
                              <span className="microlabel">由訂閱帳號決定</span>
                            ) : (
                              <code>{r.backend}</code>
                            )}
                          </td>
                          <td>{r.provider}</td>
                          <td>{r.account}</td>
                          <td className={`mc-pricing mc-${r.pricing}`}>{PRICING_TEXT[r.pricing]}</td>
                          <td className={c.bad ? "mc-bad" : "mc-calls"}>{c.text}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="panel-foot">
          同一個模型會有好幾個名稱，差別在<strong>走哪條通道、錢記在哪個帳號</strong>。
          選名稱時先看「通道」和「付費帳號」兩欄。名稱不能改——各專案已經在用，改了會斷線。
          「最近 7 天」是實際呼叫結果：顯示「全部失敗」的名稱，設定檔裡有，但現在打不通。
          這張表直接讀閘道設定檔，新增或調整模型後會自動更新。
        </div>
      </div>
    </section>
  );
}

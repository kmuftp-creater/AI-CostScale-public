import Link from "next/link";
import { getBillingSummary, getVertexReconciliation } from "@/lib/db";
import { formatTwd, formatTokens, formatUsd } from "@/lib/format";
import { resolveRange } from "@/lib/range";
import TrendChart from "@/components/TrendChart";

export const metadata = { title: "GCP 帳單 · AI CostScale" };
export const dynamic = "force-dynamic";

/**
 * 對帳面板專用的台幣格式：保留兩位小數。
 *
 * 頁面其他地方用 formatTwd 取整數，那是給「看水位」用的；
 * 這一格要讓人拿帳單金額跟閘道牌價逐位核對，取整會把 0.01% 的吻合度整個抹掉。
 */
function twd2(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SOURCE_LABEL: Record<string, string> = {
  vertex: "Vertex",
  aistudio: "AI Studio",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const range = resolveRange(params);
  const [billing, vertex] = await Promise.all([
    getBillingSummary(new Date(range.from), new Date(range.to)),
    getVertexReconciliation(new Date(range.from), new Date(range.to)),
  ]);
  const directTotal = vertex.direct.reduce((s, d) => s + d.gross, 0);

  // 落後超過兩天就示警。帳單匯出本來就有一到兩天的延遲，
  // 但它同時也是「回填中」或「匯出斷了」的症狀，分不出來時一律提醒。
  const laggy = billing.states.filter((s) => s.lagDays !== null && s.lagDays > 2);
  const mixedCurrency = billing.currencies.filter((c) => c !== "TWD");

  return (
    <>
      {laggy.length > 0 ? (
        <section className="block">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">資料尚未補齊</span>
              <span className="microlabel">Watermark</span>
            </div>
            <div className="ledger-note">
              {laggy.map((s) => (
                <div key={s.source}>
                  <strong>{SOURCE_LABEL[s.source] ?? s.source}</strong>
                  ：費用資料只到 <strong>{s.maxUsageDay}</strong>
                  （落後 {s.lagDays} 天）。
                </div>
              ))}
              <div style={{ marginTop: "0.5rem" }}>
                這一天之後的費用<strong>還沒進來</strong>，不是沒花錢。
                下面的合計因此會偏低，不要拿它跟信用卡帳單對。
                帳單匯出是往回補的，等它追上就會正確。
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="block">
        <div className="ledger-strip">
          <div className="ledger-cell">
            <span className="microlabel">原價合計 · Gross</span>
            <div className="hero-figure">
              <span className="unit">NT$ </span>
              {formatTwd(billing.totalGross)}
            </div>
            <div className="ledger-note">
              Google 的計價結果，未扣抵免額。帳單匯出直接以台幣計價，不經換匯。
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">抵免 · Credit</span>
            <div className="stat-figure">
              <span className="unit">NT$ </span>
              {formatTwd(billing.totalCredit)}
            </div>
            <div className="ledger-note">試用額度與折扣，負值</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">實付淨額 · Net</span>
            <div className="stat-figure">
              <span className="unit">NT$ </span>
              {formatTwd(billing.totalNet)}
            </div>
            <div className="ledger-note">
              抵免期間會是零。只看這個數字會以為沒花錢，所以兩種都列
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">資料補到</span>
            {billing.states.length > 0 ? (
              <>
                <div className="stat-figure">
                  {billing.states
                    .map((s) => s.maxUsageDay ?? "—")
                    .sort()[0]}
                </div>
                <div className="ledger-note">
                  {billing.states
                    .map((s) => `${SOURCE_LABEL[s.source] ?? s.source} ${s.maxUsageDay ?? "—"}`)
                    .join("　")}
                </div>
              </>
            ) : (
              <>
                <div className="stat-figure dash">—</div>
                <div className="ledger-note">尚未執行過抓取</div>
              </>
            )}
          </div>
        </div>
      </section>

      {mixedCurrency.length > 0 ? (
        <section className="block tight">
          <div className="panel">
            <div className="ledger-note">
              出現非台幣的幣別（{mixedCurrency.join("、")}）。
              上方合計是把不同幣別直接相加的結果，<strong>不可採用</strong>，需先分幣別再看。
            </div>
          </div>
        </section>
      ) : null}

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">每日費用趨勢</span>
            <span className="microlabel">原價 Gross · {range.label}</span>
          </div>
          {billing.daily.length > 1 ? (
            <>
              <TrendChart
                daily={billing.daily.map((d) => ({ date: d.date, spend: d.gross }))}
                unit="NT$"
              />
              <div className="panel-foot">
                畫的是<strong>原價 gross</strong>，不是實付：抵免期間 net 整條貼零，
                看不出用量在漲還是在跌，而這張圖要回答的是後者。
                尾端的下滑不一定是省了錢——資料補到哪一天看上方水位，
                還沒補進來的日子在這裡是零。
              </div>
            </>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              本月尚無兩天以上的帳單資料，補齊後這裡會出現趨勢圖。
            </div>
          )}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">依軟體歸戶</span>
            <span className="microlabel">{range.label}</span>
          </div>
          {billing.byClient.length > 0 ? (
            <table className="ledger">
              <tbody>
                {billing.byClient.map((c) => (
                  <tr key={`${c.source}-${c.clientId}`}>
                    <td className="t-name">
                      {c.clientId}
                      <span className="microlabel"> {SOURCE_LABEL[c.source] ?? c.source}</span>
                    </td>
                    <td className="t-num">NT$ {formatTwd(c.gross)}</td>
                    <td className="t-num">NT$ {formatTwd(c.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              本期尚無帳單資料。需先執行 <code>run-billing-fetch.sh</code>。
            </div>
          )}
          <div className="panel-foot">
            歸戶是<strong>兩套規則</strong>，不是一套。
            Vertex 那本帳的每一列帶 <code>client_id</code> 標籤，照標籤歸；
            AI Studio 那本帳沒有自訂標籤（那是 Vertex 專屬的），只能照
            <code>project.id</code> 歸，所以那邊看到的是專案代號不是軟體名。
            取不到的一律標成「(未標示)」，不猜也不丟掉。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Vertex 對帳：閘道與直連</span>
            <span className="microlabel">
              {vertex.windowFrom} 至 {vertex.windowTo}
            </span>
          </div>
          {vertex.empty ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              本期尚無 Vertex 帳單資料。
            </div>
          ) : (
            <>
              <table className="ledger">
                <tbody>
                  <tr>
                    <td className="t-name">
                      經過閘道
                      <span className="microlabel"> 帳單上未帶 client_id 標籤的部分</span>
                    </td>
                    <td className="t-num">NT$ {twd2(vertex.billUnlabeled)}</td>
                    <td className="t-num">{formatTokens(vertex.gatewayTokens)} tok</td>
                  </tr>
                  {vertex.direct.map((d) => (
                    <tr key={d.clientId}>
                      <td className="t-name">
                        {d.clientId}
                        <span className="microlabel"> 直連，未經閘道</span>
                      </td>
                      <td className="t-num">NT$ {twd2(d.gross)}</td>
                      <td className="t-num dash">—</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="t-name">
                      <strong>Vertex AI 原價合計</strong>
                      <span className="microlabel"> 抵免 NT$ {twd2(vertex.billCredit)}／實付 NT$ {twd2(vertex.billNet)}</span>
                    </td>
                    <td className="t-num">
                      <strong>NT$ {twd2(vertex.billGross)}</strong>
                    </td>
                    <td className="t-num">{formatTokens(vertex.vertexTokens)} tok</td>
                  </tr>
                </tbody>
              </table>
              <div className="ledger-strip" style={{ marginTop: "0.75rem" }}>
                <div className="ledger-cell">
                  <span className="microlabel">閘道牌價 · LiteLLM</span>
                  <div className="stat-figure">
                    <span className="unit">US$ </span>
                    {formatUsd(vertex.gatewayUsd, 4)}
                  </div>
                  <div className="ledger-note">同期，只算 vertex_ai 那條</div>
                </div>
                <div className="ledger-cell">
                  <span className="microlabel">反推 GCP 換匯率</span>
                  <div className="stat-figure">
                    {vertex.impliedFx !== null ? vertex.impliedFx.toFixed(3) : <span className="dash">—</span>}
                  </div>
                  <div className="ledger-note">
                    帳單未標示 ÷ 閘道牌價，
                    {vertex.fxWindowFrom
                      ? `只算 ${vertex.fxWindowFrom} 至 ${vertex.fxWindowTo}`
                      : "本期沒有可對帳的日子"}
                  </div>
                </div>
                <div className="ledger-cell">
                  <span className="microlabel">閘道涵蓋率</span>
                  <div className="stat-figure">
                    {vertex.gatewayTokenShare !== null
                      ? `${(vertex.gatewayTokenShare * 100).toFixed(1)}%`
                      : <span className="dash">—</span>}
                  </div>
                  <div className="ledger-note">
                    {vertex.gatewayTokenShare !== null
                      ? `${formatTokens(vertex.fxWindowGatewayTokens)} ÷ ${formatTokens(vertex.fxWindowVertexTokens)}，其餘是直連`
                      : "同上，對帳視窗內才算得出來"}
                  </div>
                </div>
                <div className="ledger-cell">
                  <span className="microlabel">直連原價</span>
                  <div className="stat-figure">
                    <span className="unit">NT$ </span>
                    {twd2(directTotal)}
                  </div>
                  <div className="ledger-note">
                    {vertex.direct.length > 0
                      ? `${vertex.direct.length} 個 client 有標籤`
                      : "本期沒有直連"}
                  </div>
                </div>
              </div>
            </>
          )}
          <div className="panel-foot">
            這一格是把<strong>三套彼此獨立的成本數字接起來</strong>：
            GCP 帳單、閘道自己算的牌價、Cloud Monitoring 的 token 計量。
            <br />
            對帳關係（2026-08-25 實測，連續四天誤差 0.01%）：
            <code>帳單未標示 ÷ 閘道牌價 = 32.375</code>。
            也就是說<strong>閘道牌價不是帳單的估計值，它就是帳單的 gross</strong>，
            差別只在抵免。帳單上帶 <code>client_id</code> 標籤的那些是**沒走閘道的直連**——
            閘道目前不貼標籤，所以它自己落在「未標示」。
            <br />
            期間的訖日已被帳單水位裁切到 <strong>{vertex.windowTo}</strong>
            （帳單補到 {vertex.billThroughDay ?? "—"}）。
            不裁切的話會拿補到一半的帳單比完整的閘道紀錄，得到「閘道比帳單貴」的假結論。
            <br />
            上面的表是<strong>整個期間</strong>的歸戶；右邊兩格只算
            {vertex.fxWindowFrom ? ` ${vertex.fxWindowFrom} 至 ${vertex.fxWindowTo}` : "可對帳的日子"}——
            閘道 2026-08-18 才開始記 Vertex，在那之前帳單上的「未標示」是還沒貼標籤的直連，
            不是閘道。整個期間一起除會反推出 54 這種不存在的匯率。
            <br />
            兩個已知的不準：產圖的 SKU 按張計價不按 token，閘道牌價那條看不到它；
            實付 net 在試用抵免期間是零，所以<strong>任何「便宜幾倍」的結論</strong>
            講的都是抵免用完之後的狀態，不是現在。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">依服務與計價項目</span>
            <span className="microlabel">Top 12 · 用量／原價／抵免後</span>
          </div>
          {billing.bySku.length > 0 ? (
            <table className="ledger">
              <tbody>
                {billing.bySku.map((s) => (
                  <tr key={`${s.service}-${s.sku}`}>
                    <td className="t-name">
                      {s.sku}
                      <span className="microlabel"> {s.service}</span>
                    </td>
                    <td className="t-num">
                      {s.usageAmount > 0 ? formatTokens(s.usageAmount) : "—"}
                    </td>
                    <td className="t-num">NT$ {formatTwd(s.gross)}</td>
                    <td className="t-num">NT$ {formatTwd(s.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              本期尚無資料
            </div>
          )}
          <div className="panel-foot">
            中間那一欄是<strong>帳單自己記的用量</strong>。對 token 類的計價項目它就是
            token 數——雖然 GCP 把單位字面上寫成 <code>requests</code>，
            那是它對「可計費單位個數」的統稱，不是請求次數
            （實測：Gemini 3.1 Flash Lite 文字輸入 30 天 1,140 萬，
            而同期實際請求只有一千多次）。
            <br />
            這一欄是<strong>AI Studio 那本帳唯一拿得到 token 數的地方</strong>：
            它沒有 Vertex 那種 <code>aiplatform</code> 監控指標，服務帳戶也只在
            Vertex 專案裡有監控權限。但**只涵蓋有計費的用量**——
            AI Studio 免費層不進帳單匯出，那五把免費金鑰的 token 在這裡看不到，
            要看<Link href="/keys">金鑰管理</Link>（那是閘道自己記的）。
            <br />
            已排除 <code>service = Invoice</code> 那類發票層級的列
            （帳單調整與稅金）。那與明細列是同一筆錢的兩種表示，
            一起加會讓總額灌水。排除的金額記在
            <code>billing_export_state.excluded_gross</code>。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">匯出狀態</span>
            <span className="microlabel">Export state</span>
          </div>
          {billing.states.length > 0 ? (
            <table className="ledger">
              <tbody>
                {billing.states.map((s) => (
                  <tr key={s.source}>
                    <td className="t-name">{SOURCE_LABEL[s.source] ?? s.source}</td>
                    <td className="t-num">{s.rowsSeen.toLocaleString("zh-TW")} 列</td>
                    <td className="t-num">
                      {s.maxExportTime
                        ? s.maxExportTime.toLocaleString("zh-TW")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚未執行過抓取
            </div>
          )}
          <div className="panel-foot">
            中間那欄是匯出端最後一次寫入的時間。<strong>它停止前進就代表匯出斷了</strong>，
            而不是沒有花費——這兩者在總額上看起來一模一樣，只能靠這裡分辨。
          </div>
        </div>
      </section>
    </>
  );
}

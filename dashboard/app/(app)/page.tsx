import Link from "next/link";
import {
  getUsageSummary,
  listApps,
  listSubscriptions,
  getFxRate,
  listSubUsage,
  getGcpUsage,
  listQuotaPools,
  getSpendTrend,
  getUnitEconomics,
  getOtelSummary,
  getCliUsageSummary,
  combineAllSourceTokens,
  getSubscriptionSavings,
} from "@/lib/db";
import {
  formatUsd,
  formatTwd,
  formatTokens,
  formatTokensZh,
  last4,
  monthlyEquivalent,
} from "@/lib/format";
import { resolveRange } from "@/lib/range";
import { listQuotaPoolsLive } from "@/lib/keys";
import TrendChart from "@/components/TrendChart";

export const dynamic = "force-dynamic";

/**
 * 訂閱來源的顯示名稱。資料庫存的是機器名（codex、antigravity、claude），
 * 直接印在面板上看不出那是哪一個訂閱帳號。
 *
 * claude 的資料來源與另外兩家不同：不是用量端點（那需要 user:profile 範圍，
 * 橋接的長效權杖沒有），而是每次推論回應都帶的
 * anthropic-ratelimit-unified-{5h,7d}-utilization 表頭。
 * 橋接查一次額度＝打一次 max_tokens=1 的極小請求，詳見全紀錄第三十五節。
 */
const SUB_PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex（ChatGPT 訂閱）",
  antigravity: "Antigravity（Google 訂閱）",
  claude: "Claude Code（Claude 訂閱）",
};

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const range = resolveRange(params);
  // 匯出連結要帶的查詢字串：自訂就帶 from／to，否則帶 range。
  const exportQs =
    range.mode === "custom"
      ? `from=${range.fromDay}&to=${range.toDay}`
      : `range=${range.mode}`;

  // 匯率要先拿到——趨勢與單位成本都要用它把 USD 折成台幣。
  // 多一次往返，但那是本機資料庫的單筆查詢，代價可以忽略。
  const fxRate = await getFxRate();
  const [summary, apps, subscriptions, gcp, quotaPools, subUsage, trend, unitEcon, otel, cliUsage, savings] =
    await Promise.all([
      getUsageSummary(new Date(range.from), new Date(range.to)),
      listApps(),
      listSubscriptions(),
      getGcpUsage(new Date(range.from), new Date(range.to)),
      listQuotaPoolsLive(),
      listSubUsage(),
      getSpendTrend(new Date(range.from), new Date(range.to), fxRate.rate),
      getUnitEconomics(fxRate.rate),
      // 「總 Token」那格要算的是 User 所有的使用量，不是只有經過閘道的那一小塊。
      // 閘道的量在這個月是 284 萬，而 Claude Code 與 Codex 直接用掉的是幾十億——
      // 只顯示前者會讓那格看起來永遠不動（2026-08-29 User 回報）。
      getOtelSummary(new Date(range.from), new Date(range.to)),
      getCliUsageSummary(new Date(range.from), new Date(range.to)),
      // 「訂閱省下多少」：實際用掉的 token × 官方 API 價目 − 月費。
      getSubscriptionSavings(new Date(range.from), new Date(range.to), fxRate.rate),
    ]);
  const allTokens = combineAllSourceTokens(summary.totalTokens, otel, cliUsage);

  // 免費額度：只看有設上限的池，沒設上限的算不出剩餘量。
  const freePools = quotaPools.filter((p) => p.enabled);
  const measurable = freePools.filter((p) => p.poolLimitRpd != null);
  const freeUsedToday = freePools.reduce((s, p) => s + p.usedRequests, 0);
  // 失敗的請求不算進消耗（多數根本沒送到供應商），但要讓人看得到——
  // 只顯示「今天用了 3 次」會讓幾十次打不出去的狀況看起來一切正常（2026-08-27）。
  const freeFailedToday = freePools.reduce((s, p) => s + p.failedRequests, 0);
  const freeLimitTotal = measurable.reduce((s, p) => s + (p.poolLimitRpd ?? 0), 0);
  const freeUsedMeasurable = measurable.reduce((s, p) => s + p.usedRequests, 0);
  const freeRemaining = freeLimitTotal - freeUsedMeasurable;

  const fx = fxRate.rate;
  const costTwd = summary.totalSpend * fx;

  const activeSubs = subscriptions.filter((s) => s.status === "active");
  // 年繳的 fee 是年費，先換算成每月等值再加總，否則一筆年繳會被當成十二倍。
  const subTotalTwd = activeSubs.reduce((sum, s) => {
    const perMonth = monthlyEquivalent(Number(s.fee) || 0, s.billing_cycle);
    return sum + (s.currency === "TWD" ? perMonth : perMonth * fx);
  }, 0);

  // 金鑰→軟體的對照表**要含換過的舊金鑰**（2026-08-30 修）。
  // 只比 vkey_id 的話，換過鑰的軟體整批對不回來、掉進最後那列「開發測試」。
  // app-a 就是這樣消失的：它八月的 86 筆全在一把已退休的金鑰上，
  // 而它其實是本月第一名（US$0.7563）。同型缺陷 8/26 在
  // getSpendByProject 與 getUnattributedUsage 修過，這一頁漏了。
  const appsByVkey = new Map<string, (typeof apps)[number]>();
  for (const a of apps) {
    if (a.vkey_id) appsByVkey.set(a.vkey_id, a);
    for (const old of a.retired_vkey_ids ?? []) appsByVkey.set(old, a);
  }

  // 未登記在 costscale.apps 的金鑰（開發過程留下的一次性測試鑰）併成一列。
  // 不併的話它們會各佔一個名次：測試鑰有 20 把、其中一把花費還高於所有真專案，
  // 排行只取前 8 名，結果就是真專案全被擠掉（2026-08-20）。
  // **依軟體彙總，不是依金鑰。** 對照表含退休金鑰之後，同一個軟體會有
  // 現用鑰與每一把舊鑰各一列；不併的話 app-a 會在排行上出現兩次，
  // 而兩列的數字誰也不等於它真正花了多少。
  type RankRow = {
    apiKey: string;
    spend: number;
    tokens: number;
    app: ReturnType<typeof appsByVkey.get>;
  };
  const byApp = new Map<number, RankRow>();
  let untrackedSpend = 0;
  let untrackedTokens = 0;
  let untrackedCount = 0;
  for (const row of summary.byApiKey) {
    const app = appsByVkey.get(row.apiKey);
    if (app) {
      const cur = byApp.get(app.id);
      if (cur) {
        cur.spend += row.spend;
        cur.tokens += row.tokens;
      } else {
        byApp.set(app.id, { apiKey: app.vkey_id ?? row.apiKey, spend: row.spend, tokens: row.tokens, app });
      }
    } else {
      untrackedSpend += row.spend;
      untrackedTokens += row.tokens;
      untrackedCount += 1;
    }
  }
  const registered: RankRow[] = [...byApp.values()];
  // 已封存的軟體不參加排行（2026-08-30）。
  //
  // 排行回答的是「現在哪個軟體花最多」，而封存的多半是實測用的拋棄式軟體
  // ——User 看到 `app-c` 與 `app-c-probe` 並排時的第一句話是
  // 「這兩筆有什麼差別？不是同一套？」。後者是我開的測試軟體，
  // 名字又像，並排在真專案旁邊只會製造誤會。
  //
  // 但**不能整批藏掉**：藏掉之後排行的總和就對不上這期的實際花費。
  // 比照「未歸戶」那一列的做法，併成一列放在最後，數字仍然看得到。
  const activeRegistered = registered.filter((r) => r.app?.status === "active");
  const archivedRegistered = registered.filter((r) => r.app && r.app.status !== "active");
  const ranking = [...activeRegistered].sort((a, b) => b.spend - a.spend).slice(0, 8);
  const archivedRoll =
    archivedRegistered.length > 0
      ? {
          spend: archivedRegistered.reduce((n, r) => n + r.spend, 0),
          tokens: archivedRegistered.reduce((n, r) => n + r.tokens, 0),
          count: archivedRegistered.length,
          names: archivedRegistered.map((r) => r.app?.name ?? "?"),
        }
      : null;
  const untracked =
    untrackedCount > 0
      ? { apiKey: "__untracked__", spend: untrackedSpend, tokens: untrackedTokens, count: untrackedCount }
      : null;
  const maxRankSpend = Math.max(
    ...ranking.map((r) => r.spend),
    untracked?.spend ?? 0,
    archivedRoll?.spend ?? 0,
    0.0001
  );

  return (
    <>
      <div className="ledger-strip">
        <div className="ledger-cell">
          {/* 微標一定要跟著區間走。寫死「本月」的話，選了上月或自訂之後
              金額會換、字不會換——那比「按了沒反應」更糟，因為它會讓人
              把別的期間的數字當成本月的（2026-08-26 修，同型缺陷見專案看板）。 */}
          <span className="microlabel">{range.label} API 成本 · Billed</span>
          {summary.available ? (
            <>
              <div className="hero-figure">
                <span className="unit">US$</span>
                {formatUsd(summary.totalSpend)}
              </div>
              {/* 變化與推估（2026-08-25，D-4／D-5）。
                  絕對值回答「花了多少」，這兩列回答「跟上次比如何」與
                  「照這個速度會到哪」——後兩者才是能提早行動的訊號。

                  2026-08-29 從三行連續句子改成兩欄清單。原本的寫法讓這一格
                  右側空掉三分之一：中文句子斷在字詞邊界，右緣一定是參差的，
                  而這一格的句子都很短。改成「標籤靠左、數字靠右」之後
                  右緣是對齊的，解釋性的文字收到最底下那一行。 */}
              <dl className="note-rows">
                <dt>折台幣</dt>
                <dd>NT$ {formatTwd(costTwd)}</dd>
                <dt>較上一期</dt>
                <dd>
                  {trend.deltaPct === null
                    ? "—"
                    : `${trend.deltaPct >= 0 ? "＋" : "－"}${Math.abs(trend.deltaPct).toFixed(0)}%`}
                </dd>
                {trend.projectedTwd !== null && (
                  <>
                    <dt className="sep">整期預估</dt>
                    <dd className="sep">NT$ {formatTwd(trend.projectedTwd)}</dd>
                  </>
                )}
              </dl>
              <div className="note-foot">
                匯率 {fx}
                {trend.deltaPct === null
                  ? "・上一期沒有花費，無從比較"
                  : `・上期 NT$ ${formatTwd(trend.previousTwd)}`}
                {trend.projectedTwd !== null
                  ? `・已過 ${trend.daysElapsed}／${trend.daysTotal} 天，線性外推`
                  : ""}
              </div>
            </>
          ) : (
            <>
              <div className="hero-figure dash">—</div>
              <div className="ledger-note">尚無法讀取 LiteLLM 支出紀錄，容器啟動並開始計費後會出現數字</div>
            </>
          )}
        </div>
        <div className="ledger-cell">
          <span className="microlabel">本月訂閱月費 · Fixed</span>
          {activeSubs.length > 0 ? (
            <>
              <div className="stat-figure">
                <span className="unit">NT$ </span>
                {formatTwd(subTotalTwd)}
              </div>
              <div className="ledger-note">{activeSubs.map((s) => s.service).join(" ＋ ")}</div>
            </>
          ) : (
            <>
              <div className="stat-figure dash">—</div>
              <div className="ledger-note">尚未登記訂閱帳號，請至「訂閱」頁新增</div>
            </>
          )}
        </div>
        <div className="ledger-cell">
          <span className="microlabel">總 Token · 全部來源</span>
          {allTokens.all > 0 ? (
            <>
              {/* 中文大、英文小（2026-08-29 User 裁決）：`5.44B` 對中文讀者要先
                  在腦裡換一次算，`54.4 億` 不用。教學時要的是一眼看懂多大。 */}
              <div className="stat-figure">
                {formatTokensZh(allTokens.all)}
                <span className="unit"> {formatTokens(allTokens.all)}</span>
              </div>
              {/* 底下改成兩欄小清單，不要寫成一整句話——這一格只有四分之一版面寬，
                  連續句子會斷在句中，出現「⋯是快取重／讀」這種孤字（2026-08-29）。 */}
              <dl className="note-rows">
                <dt>實際新內容</dt>
                <dd>
                  {formatTokensZh(allTokens.fresh)}
                  <span className="sub">{formatTokens(allTokens.fresh)}</span>
                </dd>
                <dt>快取重讀</dt>
                <dd>{allTokens.cachedPct.toFixed(1)}%</dd>
                <dt className="sep">閘道</dt>
                <dd className="sep">{formatTokensZh(allTokens.gateway)}</dd>
                <dt>Claude Code</dt>
                <dd>{formatTokensZh(allTokens.claudeAll)}</dd>
                <dt>Codex</dt>
                <dd>{formatTokensZh(allTokens.codexAll)}</dd>
              </dl>
            </>
          ) : (
            <>
              <div className="stat-figure dash">—</div>
              <div className="ledger-note">本期尚無用量資料</div>
            </>
          )}
        </div>
        <div className="ledger-cell">
          <span className="microlabel">免費額度剩餘 · 估算</span>
          {measurable.length > 0 ? (
            <>
              <div className="stat-figure">
                {freeRemaining.toLocaleString("zh-TW")}
                <span className="unit"> 次</span>
              </div>
              {/* 同第一格：原本是一整段話，在四分之一版面裡右緣參差。
                  數字進清單、說明進 note-foot（2026-08-29）。 */}
              <dl className="note-rows">
                <dt>今日已用</dt>
                <dd>
                  {freeUsedMeasurable.toLocaleString("zh-TW")} ／{" "}
                  {freeLimitTotal.toLocaleString("zh-TW")} 次
                </dd>
                {freeFailedToday > 0 && (
                  <>
                    <dt>失敗</dt>
                    <dd>{freeFailedToday.toLocaleString("zh-TW")} 次</dd>
                  </>
                )}
              </dl>
              <div className="note-foot">
                只計經閘道成功的量，日界線為台北時間
                {measurable.length < freePools.length
                  ? `・另有 ${freePools.length - measurable.length} 池未設上限`
                  : ""}
                {freeFailedToday > 0 ? "・失敗未計入消耗" : ""}
              </div>
            </>
          ) : (
            <>
              <div className="stat-figure dash">—</div>
              <div className="ledger-note">
                今日經閘道用掉 {freeUsedToday.toLocaleString("zh-TW")} 次。
                到「設定」填入各池的每日上限後，這裡才算得出剩餘量
              </div>
            </>
          )}
        </div>
      </div>

      {/* 單位成本比較（2026-08-25，D-3）。
          在此之前系統只知道「API 花了多少錢」與「訂閱月費多少」，
          兩者沒有共同的分母，所以無法回答「訂閱划不划算」——
          而那正是這套軟體存在的理由。 */}
      <section className="block">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">每百萬 token 的等效成本</span>
            <span className="microlabel">
              {/* 兩端帶時分、天數帶一位小數，三個數字要能互相驗算。
                  只印日期的話「07-28 至 08-26」看起來是 30 天，
                  旁邊卻寫 28 天——差在跨距不是整數（2026-08-26 修）。 */}
              {unitEcon.windowFrom
                ? `${unitEcon.windowFrom} 至 ${unitEcon.windowTo}（台北）· ${unitEcon.windowDays.toFixed(1)} 天`
                : "尚無資料"}
            </span>
          </div>
          {unitEcon.rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              {"還沒有 CLI 用量資料，算不出單位成本。收集器開始回報之後就會出現。"}
            </div>
          ) : (
            <>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>通道</th>
                    {/* 2026-09-07 加這一欄：每一列的視窗不一樣了。
                        加進 Claude Code 本機紀錄之後，兩條訂閱的資料涵蓋期間差了兩個月，
                        共用一個表頭視窗會讓「該期間成本」看起來像同一段期間算出來的。 */}
                    <th>資料期間</th>
                    <th>該期間成本</th>
                    <th>Token</th>
                    <th>每百萬 token</th>
                  </tr>
                </thead>
                <tbody>
                  {unitEcon.rows.map((r) => (
                    <tr key={r.label}>
                      <td className="t-name">{r.label}</td>
                      <td>
                        {r.windowFrom ? (
                          <span className="microlabel">
                            {r.windowFrom} 至 {r.windowTo}
                            {r.windowDays > 0 ? ` · ${r.windowDays.toFixed(1)} 天` : ""}
                          </span>
                        ) : (
                          <span className="microlabel">—</span>
                        )}
                      </td>
                      <td>NT$ {formatTwd(r.costTwd)}</td>
                      <td>{r.tokens === null ? "—" : formatTokens(r.tokens)}</td>
                      <td>
                        {r.twdPerMTok === null ? (
                          <span className="microlabel">{r.note}</span>
                        ) : (
                          <>
                            <span className="num">NT$ {r.twdPerMTok.toFixed(2)}</span>
                            {r.note ? (
                              <span className="microlabel"> · {r.note}</span>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="panel-foot">
                {"月費按視窗天數等比例折算（30 天為一個月）。**每一條訂閱用自己的資料期間**，" +
                  "不是共用一個——兩條訂閱的涵蓋期間差了兩個月，共用會讓其中一條的單位成本被灌水。" +
                  "視窗用的是用量資料實際涵蓋的期間，" +
                  "不是日曆月——session 的 token 是累計值且會跨月，硬切成「本月」會重複計算。" +
                  "對照組的分子分母都是閘道實際量到的，不是牌價。" +
                  "要提醒的是 token 數含大量快取讀取，API 那側快取也比較便宜，" +
                  "所以這個比較偏向對訂閱有利——它回答的是「同樣的 token 量」，不是「同樣的錢買到的價值」。" +
                  "快取到底佔多少、扣掉之後單價變多少，見下方「快取的實際影響」。" +
                  "兩條訂閱的 token 都來自收集器讀本機的 session 紀錄：" +
                  "Codex 讀 ~/.codex 的 rollout 檔，Claude Code 讀 ~/.claude/projects 的會話檔。" +
                  "Claude Code 2026-09-07 從遙測換成本機紀錄——遙測那條同期只收到約四成。" +
                  "最後一列用它自己的視窗（閘道 2026-08-18 才開始記錄），而且那是 LiteLLM 的牌價不是帳單——" +
                  "目前 Vertex 全額被試用抵免、實付為零，所以「訂閱比 API 便宜幾倍」在現在的計費狀態下不成立，" +
                  "它回答的是「試用額度用完之後會變成怎樣」。" +
                  "另外要知道：同期未經閘道的 Vertex 直連用量是閘道的 2.31 倍" +
                  "（8/18 至 8/24 實測，閘道涵蓋率 30.2%），這一列沒有涵蓋那一塊。" +
                  "先前這裡寫的「四倍」是錯的——分子拿了閘道全部供應商的量、" +
                  "分母拿了含閘道在內的 Vertex 總量，兩端都不對。逐日拆解見 GCP 帳單頁的對帳面板。"}
              </div>
            </>
          )}
        </div>
      </section>

      {/* 快取的實際影響（2026-08-27）。規劃書 Phase 4 有這一項但一直沒做。
          上面那張表的單價是用「含快取的總 token」算的，而兩條訂閱通道
          九成以上的 token 都是快取讀取——那個單價沒有算錯，但它回答的
          不是「這個訂閱幫我做了多少事」。這裡把兩個邊界並排：
          含快取是樂觀值，只算新內容是悲觀值，真實價值在兩者之間。
          只給其中一個，等於替使用者做了結論。 */}
      {unitEcon.rows.some((r) => r.cachedTokens !== null && r.cachedTokens > 0) && (
        <section className="block">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">快取的實際影響</span>
              <span className="microlabel">
                {unitEcon.windowFrom
                  ? `${unitEcon.windowFrom} 至 ${unitEcon.windowTo}（台北）· ${unitEcon.windowDays.toFixed(1)} 天`
                  : "尚無資料"}
              </span>
            </div>
            <table className="ledger">
              <thead>
                <tr>
                  <th>通道</th>
                  <th>快取讀取佔比</th>
                  <th>新內容 Token</th>
                  <th>每百萬 · 含快取</th>
                  <th>每百萬 · 只算新內容</th>
                </tr>
              </thead>
              <tbody>
                {unitEcon.rows
                  .filter((r) => r.tokens !== null && r.tokens > 0)
                  .map((r) => {
                    const pct =
                      r.tokens && r.cachedTokens !== null
                        ? (r.cachedTokens / r.tokens) * 100
                        : null;
                    return (
                      <tr key={r.label}>
                        <td className="t-name">{r.label}</td>
                        <td>
                          {pct === null ? (
                            "—"
                          ) : pct === 0 ? (
                            <>
                              <span className="num">0%</span>
                              <span className="microlabel"> 沒有快取可扣</span>
                            </>
                          ) : (
                            <span className="num">{pct.toFixed(1)}%</span>
                          )}
                        </td>
                        <td>{r.freshTokens === null ? "—" : formatTokens(r.freshTokens)}</td>
                        <td>
                          {r.twdPerMTok === null ? "—" : `NT$ ${r.twdPerMTok.toFixed(2)}`}
                        </td>
                        <td>
                          {r.twdPerMTokFresh === null ? (
                            "—"
                          ) : (
                            <span className="num">NT$ {r.twdPerMTokFresh.toFixed(2)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            <div className="panel-foot">
              {"「快取讀取」是同一段內容被重複送進模型，不是新產出的工作量。" +
                "扣掉之後的單價是悲觀邊界，含快取的是樂觀邊界，真實價值在兩者之間——" +
                "因為快取讀取確實省下了重算，但它不代表模型多做了事。" +
                "兩條訂閱的來源不同：Codex 讀 session 檔的 cached_input_tokens，" +
                "Claude Code 讀遙測事件的 cache_read。" +
                "閘道那一列的快取是 0，那不是漏算——LiteLLM 自己的回應快取沒有啟用，" +
                "上游也沒有回報 prompt cache（2026-08-27 實查 552 筆，cache_hit 全是 False 或空，" +
                "additional_usage_values 裡的 cached_tokens 與 cache_read_input_tokens 也都是 null）。" +
                "最後一欄拿去跟閘道比要小心：閘道的量以 Gemini、Groq 這類便宜模型為主，" +
                "跟 Opus 等級的工作不是同一種東西，數字可比、工作內容不可比。"}
            </div>
          </div>
        </section>
      )}

      {/* 訂閱省下多少（2026-08-29）。
          User：「之前不是說要設計省了多少錢，那是在哪裡？沒看到」。
          上面那張「快取的實際影響」回答的是單價，不是金額；
          這一張才是「省了多少錢」——實際用掉的 token × 官方 API 價目 − 月費。
          比價基準由 User 指定：Claude 一律 Opus 5、ChatGPT 是 terra 與 luna。
          基準會決定答案，所以每一個假設都寫在頁尾，不能只給一個漂亮數字。 */}
      {savings.length > 0 && (
        <section className="block">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">訂閱省下多少</span>
              <span className="microlabel">
                以官方 API 價目換算 · Claude 查價 2026-09-10 · OpenAI 查價 2026-08-29（短脈絡）
              </span>
            </div>
            <table className="ledger">
              <thead>
                <tr>
                  <th>訂閱</th>
                  <th>若走 API 需付</th>
                  <th>月費</th>
                  <th>省下</th>
                </tr>
              </thead>
              <tbody>
                {savings.map((s) => {
                  if (s.noDataReason) {
                    // 有月費、沒有 token 的訂閱。列出來但不給假數字——
                    // 整列消失會讓合計看起來像涵蓋了全部訂閱。
                    return (
                      <tr key={s.provider} className="row-nodata">
                        <td className="t-name">
                          {s.provider}
                          <small>{s.noDataReason}</small>
                        </td>
                        <td className="t-num">—</td>
                        <td className="t-num">NT$ {formatTwd(s.feeTwd)}</td>
                        <td className="t-amt">—</td>
                      </tr>
                    );
                  }
                  const saved = s.apiTwd - s.feeTwd;
                  const ratio = s.feeTwd > 0 ? s.apiTwd / s.feeTwd : null;
                  return (
                    <tr key={s.provider}>
                      <td className="t-name">
                        {s.provider}
                        <small>
                          這期 {formatTokensZh(s.tokens)} token
                          {s.fallbackPricedAs
                            ? `・其中 ${formatTokensZh(s.fallbackTokens)} 缺型號，按 ${s.fallbackPricedAs} 補算`
                            : ""}
                        </small>
                      </td>
                      <td className="t-num">NT$ {formatTwd(s.apiTwd)}</td>
                      <td className="t-num">NT$ {formatTwd(s.feeTwd)}</td>
                      <td className="t-amt">
                        NT$ {formatTwd(saved)}
                        {ratio !== null && <small>{ratio.toFixed(1)} 倍</small>}
                      </td>
                    </tr>
                  );
                })}
                <tr className="row-total">
                  <td className="t-name">合計</td>
                  <td className="t-num">
                    NT$ {formatTwd(savings.reduce((n, s) => n + s.apiTwd, 0))}
                  </td>
                  <td className="t-num">
                    NT$ {formatTwd(savings.reduce((n, s) => n + s.feeTwd, 0))}
                  </td>
                  <td className="t-amt">
                    NT$ {formatTwd(savings.reduce((n, s) => n + s.apiTwd - s.feeTwd, 0))}
                    <small>月費含算不出來的那幾筆，所以偏保守</small>
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="panel-foot">
              {`實際用到的型號：${savings.filter((s) => !s.noDataReason).map((s) => `${s.provider} ${s.models.join("、") || "（未標示）"}`).join("；")}。` +
                "這個數字完全由比價基準決定，所以基準寫在這裡：" +
                "Claude 按 Anthropic 官方價目（Opus 5／4.8 每百萬輸入 US$5、輸出 US$25；" +
                "Fable 5／5.1 輸入 US$10、輸出 US$50；快取讀 0.1 倍（Fable 5.1 是 0.025 倍），" +
                "快取寫分兩種：5 分鐘 1.25 倍、1 小時 2 倍——Claude Code 的寫入在 Opus 與 Fable 上" +
                "九成九是 1 小時的），ChatGPT 按 OpenAI 官方價目" +
                "（terra US$2／US$12、luna US$0.20／US$1.20、sol US$4／US$20）。" +
                "三個刻意的取捨：" +
                "一、OpenAI 用短脈絡價目，長脈絡是兩倍——往低估的方向錯比較安全；" +
                "Claude 4.6 之後官方整個 1M 上下文都是標準價，沒有這個問題。" +
                "還沒更新收集器的電腦回報的列，缺 1 小時快取的資料，那一段按 5 分鐘價算，也是往低估的方向。" +
                "所以真正省下的只會比這裡多、不會更少。" +
                "二、對不到型號的那些 session，按 User 指定的一支補算——" +
                "Claude 補 Opus 5、Codex 補地球 terra——並在左欄標出補了多少 token。" +
                "補算不是猜：那些是 session 檔缺 model 欄，不是新的模型；" +
                "但它終究是補的，所以要看得見。" +
                "三、Codex 的 input_tokens 已經含 cached_input_tokens，這裡有相減，" +
                "不然那一段會被按全價算兩次。" +
                "還有一件要知道：這是「同樣的 token 量走 API 要多少錢」，" +
                "不是「不用訂閱你就會花這麼多」——沒有訂閱的用法一定會比較節制。" +
                "標成「—」的訂閱是拿不到 token，不是沒在用；合計的月費把它們算進去了，所以「省下」是保守值。"}
            </div>
          </div>
        </section>
      )}

      <section className="block">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">訂閱額度剩餘</span>
            <span className="microlabel">上游回報，不需手填上限</span>
          </div>
          {subUsage.length > 0 ? (
            <div className="quota-strip">
              {subUsage.map((u) => {
                return (
                  <div className="ledger-cell" key={`${u.provider}-${u.windowLabel}`}>
                    <span className="microlabel">
                      {SUB_PROVIDER_LABEL[u.provider] ?? u.provider} · {u.windowLabel}
                      {u.plan ? ` · ${u.plan}` : ""}
                    </span>
                    <div className={`stat-figure${u.limitReached ? " dash" : ""}`}>
                      {Math.round(u.remainingPercent)}
                      <span className="unit"> %</span>
                    </div>
                    <div className="ledger-note">
                      已用 {Math.round(u.usedPercent)}%
                      {u.resetAt
                        ? `　${u.resetAt.toLocaleDateString("zh-TW")} 重置`
                        : ""}
                      {/* 燃燒速率與預測（D-3）。算不出來就不顯示，不補 0——
                          「速率為零」與「還不知道」是兩回事。 */}
                      {u.burnPerDay !== null && u.burnPerDay >= 0.5
                        ? `　近 24h 約 +${u.burnPerDay.toFixed(0)}%／天`
                        : ""}
                      {u.projectedAtReset !== null && u.burnPerDay !== null && u.burnPerDay >= 0.5
                        ? u.projectedAtReset >= 100
                          ? "　照此速率重置前會用完"
                          : `　照此速率重置前約到 ${Math.round(u.projectedAtReset)}%`
                        : ""}
                      {u.limitReached ? "　已達上限" : ""}
                      {u.stale
                        ? `　資料為 ${u.ageMinutes} 分鐘前，橋接可能未運作`
                        : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚無訂閱額度資料。需家用主機的橋接運作中，且 VPS 已排程
              <code>run-sub-usage-fetch.sh</code>。
            </div>
          )}
          <div className="panel-foot">
            Antigravity 的「Claude+GPT」是它自己附的第三方模型額度，
            <strong>與 Claude Code 訂閱是兩回事</strong>——<code>sub-claude</code> 的餘額
            看「Claude Code」那幾格。Claude Code 的數字取自推論回應的
            rate-limit 表頭，每次刷新會花一次 max_tokens=1 的極小請求。
          </div>
        </div>
      </section>

      <section className="block">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">每日成本趨勢</span>
            <span className="microlabel">{range.label}</span>
          </div>
          {summary.available && summary.daily.length > 0 ? (
            <TrendChart daily={summary.daily} />
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚無用量資料，新增軟體並發出第一筆請求後這裡會出現趨勢圖。
            </div>
          )}
        </div>
      </section>

      <section className="block tight">
        <div className="cols">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">軟體費用排行</span>
              <span className="microlabel">依虛擬金鑰歸屬</span>
              {/* 一般連結即可，不需 JS。
                  區間參數原樣帶過去，匯出的內容才會跟畫面上看到的一致——
                  自訂區間時尤其重要，否則會拿到本月的 CSV 卻以為是自訂區間的。 */}
              <a
                className="btn-ghost"
                href={`/api/usage/export?${exportQs}`}
                download
              >
                匯出 CSV
              </a>
            </div>
            {ranking.length > 0 || untracked || archivedRoll ? (
              <table className="ledger">
                <tbody>
                  {ranking.map((row) => (
                    <tr key={row.apiKey}>
                      <td className="t-name">
                        {row.app?.name ?? `未對應軟體（金鑰末四碼 ${last4(row.apiKey)}）`}
                        <small>
                          {formatTokens(row.tokens)} tokens
                        </small>
                        <div className="rankbar">
                          <i style={{ width: `${(row.spend / maxRankSpend) * 100}%`, background: "var(--accent)" }} />
                        </div>
                      </td>
                      <td className="t-kind k-paid">〔付費〕</td>
                      <td className="t-amt">US${formatUsd(row.spend)}</td>
                    </tr>
                  ))}
                  {archivedRoll ? (
                    <tr className="row-muted">
                      <td className="t-name">
                        已封存的測試軟體
                        <small>
                          {formatTokens(archivedRoll.tokens)} tokens · {archivedRoll.count} 個
                          ，完整清單見下方「已封存明細」
                        </small>
                        <div className="rankbar">
                          <i
                            className="bar-untracked"
                            style={{ width: `${(archivedRoll.spend / maxRankSpend) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="t-kind k-paid">〔已封存〕</td>
                      <td className="t-amt">US${formatUsd(archivedRoll.spend)}</td>
                    </tr>
                  ) : null}
                  {untracked ? (
                    <tr key={untracked.apiKey} className="row-muted">
                      <td className="t-name">
                        開發測試
                        <small>
                          {formatTokens(untracked.tokens)} tokens · {untracked.count} 把未登記金鑰
                        </small>
                        <div className="rankbar">
                          <i
                            className="bar-untracked"
                            style={{ width: `${(untracked.spend / maxRankSpend) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="t-kind k-paid">〔測試〕</td>
                      <td className="t-amt">US${formatUsd(untracked.spend)}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">
                <span className="microlabel">Empty</span>
                尚無任何軟體的用量紀錄。
              </div>
            )}
            {/* 完整清單收在展開區（2026-08-30 User 裁決）：
                「可以在細節裡面再顯示完整的就好，這樣看起來就不會很亂」。
                併成一列是為了讓排行只回答「現在哪個軟體花最多」，
                但被併掉的東西一定要找得到，否則就是藏資料。 */}
            {archivedRoll ? (
              <details className="foot-details">
                <summary>已封存明細（{archivedRoll.count} 個）</summary>
                <table className="ledger">
                  <tbody>
                    {archivedRegistered
                      .sort((a, b) => b.spend - a.spend)
                      .map((r) => (
                        <tr key={r.apiKey}>
                          <td className="t-name">
                            {r.app?.name}
                            <small>{r.app?.description ?? "（無說明）"}</small>
                          </td>
                          <td className="t-num">{formatTokens(r.tokens)} tokens</td>
                          <td className="t-amt">US${formatUsd(r.spend, 4)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <span className="microlabel">
                  這些是端到端實測用的拋棄式軟體，金鑰都已撤銷。
                  刻意不刪資料列——刪掉的話它們的歷史花費會對不回任何軟體、
                  整批跑進上面的「未歸戶」。
                </span>
              </details>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">模型費用組成</span>
              <span className="microlabel">{summary.byModel.length} 種模型</span>
            </div>
            {summary.byModel.length > 0 ? (
              <ModelMix byModel={summary.byModel} />
            ) : (
              <div className="empty-state">
                <span className="microlabel">Empty</span>
                尚無模型別用量資料。
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Vertex 用量</span>
            <span className="microlabel">Cloud Monitoring · 專案總量，含經閘道</span>
            <span className="spacer" />
            <span className="microlabel">
              {gcp.lastFetched
                ? `更新於 ${gcp.lastFetched.toLocaleString("zh-TW", { hour12: false })}`
                : "尚未抓取"}
            </span>
          </div>

          {gcp.rows.length > 0 ? (
            <>
              <table className="ledger">
                <tbody>
                  {gcp.rows.map((r) => (
                    <tr key={r.model}>
                      <td className="t-name">
                        {r.model}
                        <small>{r.invocations.toLocaleString("zh-TW")} 次呼叫</small>
                      </td>
                      <td className="t-kind k-sub">〔Vertex〕</td>
                      <td className="t-amt">
                        US${formatUsd(r.estCost)}
                        <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                          {formatTokens(r.tokens)}（入 {formatTokens(r.inputTokens)}／出{" "}
                          {formatTokens(r.outputTokens)}）
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="panel-foot">
                合計 {gcp.totalInvocations.toLocaleString("zh-TW")} 次呼叫、
                {formatTokens(gcp.totalTokens)} tokens、估算 US${formatUsd(gcp.totalEstCost)}。
                資料來自 GCP Cloud Monitoring，那是<strong>專案層</strong>的計量——
                <strong>包含經過閘道的那一部分</strong>，所以<strong>不能跟上方的閘道統計相加</strong>，
                會重複計算。這一段先前寫成「未經閘道的直連」，2026-08-25 查證後更正：
                抓取程式打的是專案層指標，從來沒有扣掉閘道
                （閘道的 vertex_project 就是同一個專案）。
                要看閘道與直連各佔多少，到 <Link href="/billing">GCP 帳單</Link>頁的
                「Vertex 對帳」面板。
                金額以閘道價目表換算，屬估算值；產圖按張計價，這裡看不到。
                Vertex 目前吃 GCP 試用額度，實際帳單為零。
              </div>
            </>
          ) : (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              這段期間沒有 Vertex 用量，或抓取程式尚未執行。
            </div>
          )}
        </div>
      </section>
    </>
  );
}

const MIX_COLORS = ["var(--accent)", "var(--c-sub)", "var(--c-free)", "var(--c-4)", "var(--c-5)"];

function ModelMix({ byModel }: { byModel: { model: string; spend: number; tokens: number }[] }) {
  const total = byModel.reduce((sum, m) => sum + m.spend, 0) || 1;
  const top = byModel.slice(0, 5);
  return (
    <>
      <div className="stackbar" role="img" aria-label="模型費用占比堆疊條">
        {top.map((m, i) => (
          <i key={m.model} style={{ width: `${(m.spend / total) * 100}%`, background: MIX_COLORS[i % MIX_COLORS.length] }} />
        ))}
      </div>
      {top.map((m, i) => (
        <div className="mix-row" key={m.model}>
          <span className="dotk" style={{ background: MIX_COLORS[i % MIX_COLORS.length] }} />
          <span className="mix-name">{m.model}</span>
          <span className="mix-fill" />
          <span className="mix-pct">{((m.spend / total) * 100).toFixed(0)}%</span>
          <span className="mix-amt">US${formatUsd(m.spend)}</span>
        </div>
      ))}
    </>
  );
}

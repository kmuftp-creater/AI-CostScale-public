import { getBridgeStatus, getRoutingInfo } from "@/lib/routing";
import { formatTaipei } from "@/lib/format";


/**
 * 路由順位與橋接狀態。
 *
 * 為什麼要有這一頁：2026-08-23 橋接隧道連續失敗 83 分鐘，期間閘道所有 sub-* 不可用，
 * 而看板上沒有任何地方看得出來——是 User 看到黑窗閃才發現的。
 * 這一頁把「現在到底通不通」與「一個模型名底下實際有幾把金鑰在輪替」攤開。
 *
 * 兩邊都是現場問，不是讀設定檔的副本——副本會漂移。
 */
export default async function RoutingSection() {
  const [bridge, routing] = await Promise.all([getBridgeStatus(), getRoutingInfo()]);

  const pooled = routing.groups.filter((g) => g.deployments > 1);
  const curated = routing.groups.filter((g) => g.deployments === 1 && !g.passthrough);
  const passthrough = routing.groups.filter((g) => g.passthrough);

  return (
    <>
      {/* ── 橋接狀態 ───────────────────────────────── */}
      <section className="block">
        <div className="ledger-strip">
          <div className="ledger-cell">
            <span className="microlabel">橋接隧道</span>
            <div
              className="hero-figure"
              style={{ color: bridge.reachable ? "var(--c-free)" : "var(--c-alert, #d9534f)" }}
            >
              {bridge.reachable ? "通" : "不通"}
            </div>
            <div className="ledger-note">
              {bridge.reachable
                ? "VPS 打得到家用主機的橋接服務"
                : `sub-* 模型現在全部不可用　${bridge.error ?? ""}`}
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">執行中／排隊中</span>
            <div className="stat-figure">
              {bridge.running ?? "—"}／{bridge.queued ?? "—"}
            </div>
            <div className="ledger-note">橋接同時只跑一個請求，其餘排隊</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">訂閱通道</span>
            <div className="stat-figure">{bridge.providers.length}</div>
            <div className="ledger-note">經橋接吃訂閱額度的模型數</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">檢查時間</span>
            <div className="stat-figure" style={{ fontSize: "1rem" }}>
              {formatTaipei(bridge.checkedAt, true)}
            </div>
            <div className="ledger-note">每次開啟這一頁都重新問一次</div>
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">訂閱通道明細</span>
            <span className="microlabel">Bridge</span>
          </div>
          {bridge.providers.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Unreachable</span>
              問不到橋接，所以列不出通道。原因：{bridge.error ?? "未知"}
              <br />
              排查起點：家用主機的排程工作「CostScale Bridge」是否在跑；
              VPS 上 <code>ss -tlnp | grep 8788</code> 是否有死掉的 sshd 佔著埠。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {bridge.providers.map((p) => {
                  const pct =
                    p.rpmLimit && p.recentMinute !== null
                      ? Math.min(100, Math.round((p.recentMinute / p.rpmLimit) * 100))
                      : null;
                  return (
                    <tr key={p.name}>
                      <td className="t-name">
                        {p.name}
                        <small>由 {p.cli || "—"} CLI 代打，吃訂閱額度</small>
                      </td>
                      <td className="t-kind">
                        {p.endpoints.length > 0 ? `〔${p.endpoints.length} 個端點〕` : "〔對話〕"}
                      </td>
                      <td className="t-amt">
                        {p.recentMinute ?? "—"}／{p.rpmLimit ?? "—"}
                        <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                          本分鐘用量／每分鐘上限{pct !== null ? `（${pct}%）` : ""}
                        </small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="panel-foot">
            橋接跑在家用主機，由 Windows 排程工作「登入時」啟動——機器重開但沒人登入的話它不會起來。
          </div>
        </div>
      </section>

      {/* ── 路由順位 ───────────────────────────────── */}
      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">多金鑰輪替的模型</span>
            <span className="microlabel">
              {routing.ok ? `策略 ${routing.strategy}` : "讀不到閘道"}
            </span>
          </div>
          {!routing.ok ? (
            <div className="empty-state">
              <span className="microlabel">Error</span>
              問不到閘道：{routing.error}
            </div>
          ) : pooled.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              目前沒有任何模型名底下掛超過一個部署。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {pooled.map((g) => (
                  <tr key={g.name}>
                    <td className="t-name">
                      {g.name}
                      <small>{g.providers.join("、")}</small>
                    </td>
                    <td className="t-kind">〔輪替〕</td>
                    <td className="t-amt">
                      {g.deployments} 把
                      <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                        隨機挑一把，不分順位
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="panel-foot">
            策略是 <code>simple-shuffle</code>：同一個模型名底下的多把金鑰是<strong>隨機挑</strong>，
            沒有先後順位。所以「第一把用完才換第二把」這件事不會發生，額度是均勻消耗的。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">降級順序由呼叫端決定</span>
            <span className="microlabel">No fallbacks</span>
          </div>
          <div className="panel-foot" style={{ paddingTop: "0.75rem" }}>
            閘道<strong>刻意不設 fallbacks</strong>（見 <code>litellm-config.yaml</code> 第 210、263 行）。
            爆額（429）時它不會自動退到別家——要不要降級、退到誰，一律由呼叫端專案自己決定。
            這是為了讓每個專案能依自己的營收重要性選擇備援鏈，而不是被閘道統一決定。
            所以這一頁看不到「跨供應商的順位」，那不存在於閘道這一層。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">單一部署的模型</span>
            <span className="microlabel">
              {curated.length} 個逐一列出　＋　{passthrough.length} 個萬用字元帶進來的
            </span>
          </div>
          {curated.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              沒有資料。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {curated.map((g) => (
                  <tr key={g.name}>
                    <td className="t-name">
                      {g.name}
                      {g.viaBridge && <small>經橋接，隧道斷掉就不可用</small>}
                    </td>
                    <td className="t-kind">〔{g.providers.join("、")}〕</td>
                    <td className="t-amt">1 把</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="panel-foot">
            另外 {passthrough.length} 個是 <code>openrouter/*</code> 與 <code>vertex_ai/*</code>
            萬用字元帶進來的，沒有逐一設定，這裡不列。閘道總共載入 {routing.totalDeployments} 個部署。
          </div>
        </div>
      </section>
    </>
  );
}

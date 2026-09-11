import Link from "next/link";
import { getOtelSummary, getCliUsageSummary } from "@/lib/db";
import { formatTokens, formatTokensZh, formatTaipei } from "@/lib/format";


// 三套訂閱制 CLI 的識別字串。實際來源字串由 CLI 的 OTLP service.name 決定，
// 這裡列出常見寫法，比對時只要包含關鍵字即可。
//
// note 是「這一列為什麼是空的」。2026-08-23 逐一實測（方法見本頁最後一段），
// 不要讓人以為空白就是壞掉——其中兩列是永遠不會有資料的，原因各不相同。
const CLIS = [
  {
    key: "claude",
    label: "Claude Code",
    sub: "Claude 訂閱 CLI",
    note: "唯一會送 token 進來的一支",
  },
  {
    key: "codex",
    label: "Codex CLI",
    sub: "ChatGPT 訂閱 CLI · 0.148.0",
    note: "OTLP 匯不出 token，改讀它自己的 session 檔——排程還沒裝的機器就是空的",
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    sub: "Google AI 訂閱 CLI · 0.56.0",
    note: "OTLP 可用，但本機帳號已不得使用這支 CLI（IneligibleTierError）",
  },
];

export default async function TelemetrySection({
  from,
  to,
}: {
  /**
   * 查詢區間，由外層頁面用 resolveRange 統一解析 searchParams 後傳進來。
   * 半開區間 [from, to)——`to` 是不含的那一天，跟站上其他查詢同一個慣例。
   */
  from: string;
  to: string;
}) {
  const [otel, cli] = await Promise.all([
    getOtelSummary(new Date(from), new Date(to)),
    getCliUsageSummary(new Date(from), new Date(to)),
  ]);

  // 兩條進料路徑：OTLP（Claude Code）與 session 檔回報（Codex）。
  // 涵蓋狀態要同時看兩邊，否則 Codex 有資料了還會顯示「尚未收到」。
  const coverage = CLIS.map((c) => {
    const viaOtel = otel.sources.find((s) => s.source.toLowerCase().includes(c.key));
    const viaFile = cli.bySource.find((s) => s.source.toLowerCase().includes(c.key));
    const times = [viaOtel?.lastSeen, viaFile?.lastEventAt].filter((d): d is Date => !!d);
    return {
      ...c,
      seen: !!viaOtel || !!viaFile,
      lastSeen: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
      tokens: (viaOtel?.totalTokens ?? 0) + (viaFile?.totalTokens ?? 0),
      via: viaOtel ? "OTLP" : viaFile ? "session 檔" : null,
    };
  });

  const codex = cli.bySource.find((s) => s.source.toLowerCase().includes("codex")) ?? null;
  const cliCached = cli.bySource.reduce((n, s) => n + s.cachedInputTokens, 0);
  // OTLP 那側「全部送進去的量」＝ input＋output ＋ 快取讀 ＋ 快取寫。
  // totalTokens 只有前兩項，不加回來就會跟 session 檔那側的標準不一致。
  const otelAll = otel.totalTokens + otel.totalCacheRead + otel.totalCacheWrite;

  return (
    <>
      <section className="block">
        <div className="ledger-strip">
          <div className="ledger-cell">
            <span className="microlabel">總 Token · 訂閱制 CLI</span>
            {/* 2026-08-29 修：原本是 `otel.totalTokens + cli.totalTokens`，
                而那兩個的計法不一樣——OTLP 的 totalTokens 是 input＋output
                （不含快取），session 檔的 total_tokens 含 cached_input_tokens。
                兩個標準相加，看起來像 codex 是 claude 的 280 倍；
                對齊之後扣掉快取是 8,262 萬對 4,350 萬，不到 2 倍。
                現在兩邊都用「含快取的全部量」，與總覽那格共用 combineAllSourceTokens。 */}
            <div className="hero-figure">{formatTokensZh(otelAll + cli.totalTokens)}</div>
            <div className="ledger-note">
              <span className="num">{formatTokens(otelAll + cli.totalTokens)}</span>
              {" · OTLP "}
              {formatTokens(otelAll)}／session 檔 {formatTokens(cli.totalTokens)}
              {" · 兩邊都含快取重讀"}
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">快取讀取</span>
            <div className="stat-figure">{formatTokens(otel.totalCacheRead + cliCached)}</div>
            <div className="ledger-note">重複內容不重新計費的部分</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">已回報來源</span>
            <div className="stat-figure">{coverage.filter((c) => c.seen).length}／{CLIS.length}</div>
            <div className="ledger-note">目前真的有資料進來的 CLI 數量</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">Codex 週額度</span>
            <div
              className="stat-figure"
              style={{
                color:
                  codex?.quotaUsedPct == null
                    ? undefined
                    : codex.quotaUsedPct >= 90
                      ? "var(--crit, #d9534f)"
                      : codex.quotaUsedPct >= 70
                        ? "var(--warn, #d08a26)"
                        : "var(--c-free)",
              }}
            >
              {codex?.quotaUsedPct == null ? "—" : `${codex.quotaUsedPct.toFixed(0)}%`}
            </div>
            <div className="ledger-note">
              {codex?.quotaUsedPct == null
                ? "訂閱是固定月費，不按 token 計價，這裡放的是額度用量"
                : `${codex.planType ?? "?"} 方案，OpenAI 自己回報的用量${
                    codex.quotaResetsAt ? `，${formatTaipei(codex.quotaResetsAt)} 重設` : ""
                  }`}
            </div>
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">資料涵蓋狀態</span>
            <span className="microlabel">Coverage</span>
          </div>
          <table className="ledger">
            <tbody>
              {coverage.map((c) => (
                <tr key={c.key}>
                  <td className="t-name">
                    {c.label}
                    <small>{c.sub}</small>
                    {!c.seen && <small>{c.note}</small>}
                  </td>
                  <td className="t-kind" style={{ color: c.seen ? "var(--c-free)" : "var(--muted)" }}>
                    〔{c.seen ? `已收到 · ${c.via}` : "尚未收到"}〕
                  </td>
                  <td className="t-amt">
                    {c.seen ? formatTokens(c.tokens) : "—"}
                    {c.lastSeen && (
                      <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                        {formatTaipei(c.lastSeen)}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="panel-foot">
            只收 token 與模型名稱，不攔截登入憑證，也不保存 prompt 或原始碼。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">依來源與模型</span>
            <span className="microlabel">{otel.rows.length} 組</span>
          </div>
          {otel.rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              這段期間沒有收到遙測資料。照下方「接線設定」設好環境變數後，CLI
              下一次執行就會開始回報。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {otel.rows.map((r, i) => (
                  <tr key={`${r.source}-${r.model ?? "none"}-${i}`}>
                    <td className="t-name">
                      {r.source}
                      <small>
                        {r.model ?? "（未標示模型）"} · {r.calls.toLocaleString("zh-TW")} 筆回報
                      </small>
                    </td>
                    <td className="t-kind k-sub">
                      〔快取 {formatTokens(r.cacheRead)}〕
                    </td>
                    <td className="t-amt">
                      {formatTokens(r.inputTokens + r.outputTokens)}
                      <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                        入 {formatTokens(r.inputTokens)}／出 {formatTokens(r.outputTokens)}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Codex：逐 session 用量</span>
            <span className="microlabel">
              {codex ? `${codex.sessions} 個 session · 來自 ${codex.hosts.join("、") || "未標示主機"}` : "尚未收到"}
            </span>
          </div>
          {!codex ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              這台以外的電腦要納入統計，得在那台跑一次
              <code>scripts/install-codex-usage-task.ps1</code>（不需管理員權限）。
              Codex 的 token 拿不到 OTLP，只能讀它自己的 session 檔，原因見下一段。
            </div>
          ) : (
            <>
              <table className="ledger">
                <tbody>
                  {cli.recent.map((r) => (
                    <tr key={r.sessionId}>
                      <td className="t-name">
                        {r.model ?? "（未標示模型）"}
                        <small>
                          {r.originator ?? "?"}
                          {r.threadSource === "subagent" ? " · 子代理" : " · 自己開的"} ·{" "}
                          {r.sessionId.slice(0, 8)}
                        </small>
                      </td>
                      <td className="t-kind k-sub">
                        〔快取 {formatTokens(r.cachedInputTokens)}〕
                      </td>
                      <td className="t-amt">
                        {formatTokens(r.totalTokens)}
                        <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                          出 {formatTokens(r.outputTokens)} · {formatTaipei(r.lastEventAt)}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="panel-foot">
                最近 {cli.recent.length} 個 session，全期間合計{" "}
                {formatTokens(codex.totalTokens)} tokens，其中{" "}
                {formatTokens(codex.cachedInputTokens)} 是<strong>快取讀取</strong>——
                Codex Desktop 的子代理每一輪都重送整份上下文，所以這個比例會非常高，
                看總量會嚇到，要看的是輸出那一欄。
                <br />
                數字以 session 為單位覆寫，不是流水帳：同一個 session
                回報幾次都只算一份，session 還在跑時數字會持續長大。
              </div>
            </>
          )}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">接線設定</span>
            <span className="microlabel">每台電腦設定一次</span>
          </div>
          <p className="ledger-note" style={{ marginBottom: "1rem" }}>
            在要納入統計的電腦上設好環境變數即可。訂閱制 CLI 的用量沒有官方 API
            可查，只能靠 CLI 自己輸出的遙測資料。
          </p>

          <div className="microlabel" style={{ display: "block", marginBottom: "0.5rem" }}>
            Claude Code（PowerShell 使用者環境變數）
          </div>
          <pre className="dialog-snippet">{`setx CLAUDE_CODE_ENABLE_TELEMETRY 1
setx OTEL_METRICS_EXPORTER otlp
setx OTEL_EXPORTER_OTLP_PROTOCOL http/json
setx OTEL_EXPORTER_OTLP_ENDPOINT https://<你的儀表板網址>/api/otel
setx OTEL_EXPORTER_OTLP_HEADERS "Authorization=Bearer <遙測 token>"`}</pre>
          <div className="panel-foot">
            最後那行是必要的。接收端需要 token 才收，否則回 401——
            這支端點會寫進資料庫，不能對外開放。
            token 在 VPS 的 <code>/opt/costscale/.env</code> 的{" "}
            <code>OTEL_INGEST_TOKEN</code>。
            設完要重開終端機，<code>setx</code> 不影響已經開著的行程。
          </div>

          <div className="panel-foot">
            OTLP 匯出器會自己在網址後面接上 <code>/v1/metrics</code>，所以只填到 <code>/api/otel</code> 即可。
            設定後若仍顯示「尚未收到」，先確認該台電腦連得到你的儀表板網址。
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">另外兩支為什麼永遠是空的</span>
            <span className="microlabel">2026-08-23 實測，不是推測</span>
          </div>
          <p className="ledger-note" style={{ marginBottom: "1rem" }}>
            量法：在本機起一個 OTLP 接收樁（127.0.0.1:4318，收到什麼原樣記下來），
            把兩支 CLI 的匯出端點指過去，各跑完整一輪，再看樁收到什麼。
          </p>

          <div className="microlabel" style={{ display: "block", marginBottom: "0.5rem" }}>
            Codex CLI 0.148.0 — 支援 OTLP，但裡面沒有 token
          </div>
          <p className="ledger-note" style={{ marginBottom: "1rem" }}>
            設定方式存在且可用：<code>codex -c &apos;otel.exporter=&#123;otlp-http=&#123;endpoint=&quot;…&quot;,protocol=&quot;json&quot;&#125;&#125;&apos;</code>
            （另有 <code>otel.metrics_exporter</code>、<code>otel.trace_exporter</code>）。
            實際收到的東西是：logs 只有 <code>codex.api_request</code>、
            <code>codex.conversation_starts</code>、<code>codex.startup_phase</code>、
            <code>codex.turn_ttft</code>、<code>codex.websocket_*</code>；
            metrics 只有 <code>codex.process.start</code> 與 <code>codex.sqlite.init.count</code>；
            traces 只有 <code>auth</code> 與 <code>codex_exec</code>。
            <strong>整批 payload 裡沒有任何 token 欄位</strong>——同一次執行終端機自己印出
            「tokens used 13,474」，那個數字沒有走 OTLP 出來。
            所以這一列接上去也只會拿到空殼。
            <br />
            <strong>改走的路（已實作）</strong>：讀 Codex 自己的 session 檔
            <code> ~/.codex/sessions/年/月/日/rollout-*.jsonl</code>，
            取每一檔最後一個 <code>token_count</code> 事件的
            <code> total_token_usage</code>（input／cached_input／cache_write／output／
            reasoning_output 五欄），連同同一個事件裡的
            <code> rate_limits.primary.used_percent</code>（＝上面那個「Codex 週額度」）
            一起送到 <code>/api/cli-usage</code>。
            家用主機上每 30 分鐘跑一次
            <code> scripts/push-codex-usage.ps1</code>——用的是「登入時啟動的常駐迴圈」
            而不是工作排程器：這台機器的帳號沒有密碼，本機原則
            <code> LimitBlankPasswordUse=1</code> 會擋掉所有非互動登入，
            排程工作會回報成功卻根本不執行（2026-08-23 實測）。
            <br />
            那些檔案一天約 140 MB、單檔可達 24 MB，所以腳本只讀檔頭一行與檔尾數百行，
            不整份載入。
          </p>

          <div className="microlabel" style={{ display: "block", marginBottom: "0.5rem" }}>
            Gemini CLI 0.56.0 — OTLP 沒問題，是這支 CLI 不能用了
          </div>
          <p className="ledger-note">
            OTLP 那側是通的：用
            <code> GEMINI_TELEMETRY_ENABLED=true</code>、
            <code> GEMINI_TELEMETRY_TARGET=local</code>、
            <code> GEMINI_TELEMETRY_OTLP_PROTOCOL=http</code>、
            <code> GEMINI_TELEMETRY_OTLP_ENDPOINT=…</code>
            起動後，樁確實收到 <code>/v1/logs</code> 與 <code>/v1/metrics</code>，
            HTTP JSON，而且會帶上 <code>OTEL_EXPORTER_OTLP_HEADERS</code> 的 Authorization。
            但這台機器上的帳號執行它會直接失敗：
            <code>IneligibleTierError：This client is no longer supported for
            Gemini Code Assist for individuals</code>，要求改用 Antigravity。
            <strong>CLI 跑不起來，就不會有任何用量可送。</strong>
            <br />
            順帶更正一個容易誤會的事：橋接的 <code>sub-gemini</code> 通道實際上叫的是
            Antigravity 的 <code>agy</code>（見 <code>bridge/server.js</code> 的
            <code> CLI_SPEC.gemini</code>），不是 <code>gemini</code>。
            <code>agy</code> 1.1.19 內含 Go 版 OpenTelemetry SDK，
            但掃不到任何 <code>OTEL_EXPORTER_OTLP_*</code> 環境變數或可設定的匯出端點，
            沒有把它指向自架收集器的路。它的 token 數在 <code>--output-format json</code>
            的 <code>usage</code> 欄位，橋接本來就在讀，所以經橋接的那部分用量在
            <Link href="/">總覽</Link>看得到，這一段的遙測數字看不到。
          </p>
        </div>
      </section>
    </>
  );
}

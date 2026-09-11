"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatUsd, formatTwd } from "@/lib/format";

type Status = {
  id: number;
  scope: "global" | "app";
  app_id: number | null;
  app_name: string | null;
  label: string | null;
  monthly_limit: number;
  warn_pct: number;
  critical_pct: number;
  include_gcp: boolean;
  enabled: boolean;
  spendGateway: number;
  spendGcp: number;
  spend: number;
  pct: number;
  pctAlt: number;
  level: "ok" | "warn" | "critical" | "over";
  gcpAttributable: boolean;
};

type Alert = {
  id: number;
  scope: string;
  app_name: string | null;
  label: string | null;
  period: string;
  level: "warn" | "critical" | "over";
  spend_usd: number;
  limit_usd: number;
  pct: number;
  fired_at: string | Date;
  emailed_at: string | Date | null;
  email_error: string | null;
};

const LEVEL_TEXT: Record<Status["level"], string> = {
  ok: "正常",
  warn: "接近上限",
  critical: "嚴重",
  over: "已超標",
};

function budgetName(b: { scope: string; app_name: string | null; label: string | null }): string {
  if (b.label) return b.label;
  return b.scope === "global" ? "全域預算" : (b.app_name ?? "（軟體已刪除）");
}

// 顏色一律定義在 globals.css，元件只掛 class，不在這裡寫顏色值。
const BAR_CLASS: Record<Status["level"], string> = {
  ok: "bar-ok",
  warn: "bar-warn",
  critical: "bar-crit",
  over: "bar-over",
};
const KIND_CLASS: Record<Status["level"], string> = {
  ok: "k-paid",
  warn: "k-warn",
  critical: "k-crit",
  over: "k-over",
};
const ALERT_KIND_CLASS: Record<Alert["level"], string> = {
  warn: "k-warn",
  critical: "k-crit",
  over: "k-over",
};
const ALERT_TEXT: Record<Alert["level"], string> = {
  warn: "接近上限",
  critical: "嚴重",
  over: "已超標",
};

export default function BudgetsClient({
  initial,
  apps,
  alerts,
  fx,
}: {
  initial: Status[];
  apps: { id: number; name: string }[];
  alerts: Alert[];
  fx: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [scope, setScope] = useState<"global" | "app">("global");
  const [appId, setAppId] = useState<string>(apps[0]?.id?.toString() ?? "");
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState("");
  const [warnPct, setWarnPct] = useState("80");
  const [criticalPct, setCriticalPct] = useState("95");
  const [includeGcp, setIncludeGcp] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasGlobal = rows.some((r) => r.scope === "global");
  const budgetedAppIds = new Set(rows.filter((r) => r.scope === "app").map((r) => r.app_id));
  const availableApps = apps.filter((a) => !budgetedAppIds.has(a.id));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          appId: scope === "app" ? Number(appId) : undefined,
          label: label.trim() || undefined,
          monthlyLimit: limit,
          warnPct: Number(warnPct),
          criticalPct: Number(criticalPct),
          includeGcp: scope === "global" ? includeGcp : false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "新增失敗");
      setLabel("");
      setLimit("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增失敗");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/budgets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "更新失敗");
      return;
    }
    router.refresh();
  }

  async function remove(id: number) {
    const target = rows.find((r) => r.id === id);
    const name = target ? budgetName(target) : String(id);
    if (!confirm(`刪除「${name}」這筆預算？該筆的告警紀錄會一併刪除。`)) return;
    setError(null);
    const res = await fetch(`/api/budgets/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("刪除失敗");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
    router.refresh();
  }

  const canSubmit =
    (scope === "global" ? !hasGlobal : availableApps.length > 0) && limit.trim() !== "";

  return (
    <>
      <section className="block">
        <div className="panel-head" style={{ marginTop: "var(--space-lg)" }}>
          <span className="panel-title">預算與告警</span>
          <span className="microlabel">本月用量對照月上限</span>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">新增預算</span>
            <span className="microlabel">全域一筆，每個軟體各一筆</span>
          </div>
          <form onSubmit={create} className="sub-form">
            <label>
              範圍
              <select value={scope} onChange={(e) => setScope(e.target.value as "global" | "app")}>
                <option value="global" disabled={hasGlobal}>
                  全域{hasGlobal ? "（已設定）" : ""}
                </option>
                <option value="app" disabled={availableApps.length === 0}>
                  單一軟體{availableApps.length === 0 ? "（都已設定）" : ""}
                </option>
              </select>
            </label>
            {scope === "app" && (
              <label>
                軟體
                <select value={appId} onChange={(e) => setAppId(e.target.value)}>
                  {availableApps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              名稱（選填）
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例：本月上限"
              />
            </label>
            <label>
              月上限（US$）
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="50"
                inputMode="decimal"
              />
            </label>
            <label>
              警示門檻（%）
              <input
                value={warnPct}
                onChange={(e) => setWarnPct(e.target.value)}
                inputMode="numeric"
                placeholder="80"
              />
            </label>
            <label>
              嚴重門檻（%）
              <input
                value={criticalPct}
                onChange={(e) => setCriticalPct(e.target.value)}
                inputMode="numeric"
                placeholder="95"
              />
            </label>
            {scope === "global" && (
              <label>
                判定依據
                <select
                  value={includeGcp ? "1" : "0"}
                  onChange={(e) => setIncludeGcp(e.target.value === "1")}
                >
                  <option value="1">閘道 ＋ Vertex 直連估算</option>
                  <option value="0">只算經閘道的</option>
                </select>
              </label>
            )}
            <button className="btn-primary" type="submit" disabled={busy || !canSubmit}>
              {busy ? "新增中…" : "新增預算"}
            </button>
          </form>
          {error && <div className="form-error">{error}</div>}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">目前預算</span>
            <span className="microlabel">{rows.length} 筆</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚未設定任何預算。設定後這裡會顯示本月用量、剩餘額度與超標狀態。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {rows.map((b) => {
                  const remaining = b.monthly_limit - b.spend;
                  return (
                    <tr key={b.id} className={b.enabled ? undefined : "row-muted"}>
                      <td className="t-name">
                        {budgetName(b)}
                        <small>
                          上限 US${formatUsd(b.monthly_limit)}（NT$
                          {formatTwd(b.monthly_limit * fx)}）· 警示 {b.warn_pct}% ／ 嚴重{" "}
                          {b.critical_pct}%
                          {b.enabled ? "" : " · 已停用"}
                        </small>
                        <div className="rankbar">
                          <i
                            className={BAR_CLASS[b.level]}
                            style={{ width: `${Math.min(b.pct, 100)}%` }}
                          />
                        </div>
                        {/* 兩種基準一律都列出來，不必為了換角度看而另開一筆預算。
                            粗體那個才是拿來判定的。 */}
                        {b.gcpAttributable ? (
                          <small>
                            經閘道 US${formatUsd(b.spendGateway)}
                            {b.include_gcp ? "" : "（判定依據）"} ＋ Vertex 直連估算 US$
                            {formatUsd(b.spendGcp)} ＝ US${formatUsd(b.spendGateway + b.spendGcp)}
                            {b.include_gcp ? "（判定依據）" : ""} · 另一種基準為{" "}
                            {b.pctAlt.toFixed(1)}%
                          </small>
                        ) : (
                          <small>只計經閘道的用量。Vertex 直連目前分不出軟體，未計入。</small>
                        )}
                      </td>
                      <td className={`t-kind ${KIND_CLASS[b.level]}`}>
                        〔{LEVEL_TEXT[b.level]}〕<small>{b.pct.toFixed(1)}%</small>
                      </td>
                      <td className="t-amt">
                        US${formatUsd(b.spend)}
                        <small>
                          {remaining >= 0
                            ? `剩 US$${formatUsd(remaining)}`
                            : `超出 US$${formatUsd(-remaining)}`}
                        </small>
                      </td>
                      <td className="t-act">
                        <button
                          className="btn-ghost"
                          onClick={() => {
                            const next = prompt("新的月上限（US$）", String(b.monthly_limit));
                            if (next && next.trim()) patch(b.id, { monthlyLimit: next.trim() });
                          }}
                        >
                          改上限
                        </button>
                        <button
                          className="btn-ghost"
                          onClick={() => {
                            const w = prompt("警示門檻（1-100）", String(b.warn_pct));
                            if (!w || !w.trim()) return;
                            const c = prompt("嚴重門檻（須大於警示門檻）", String(b.critical_pct));
                            if (!c || !c.trim()) return;
                            patch(b.id, { warnPct: Number(w.trim()), criticalPct: Number(c.trim()) });
                          }}
                        >
                          改門檻
                        </button>
                        {b.gcpAttributable && (
                          <button
                            className="btn-ghost"
                            onClick={() => patch(b.id, { includeGcp: !b.include_gcp })}
                            title="切換用哪個數字判定；兩種花費一律都會顯示"
                          >
                            {b.include_gcp ? "改判閘道" : "改判含直連"}
                          </button>
                        )}
                        <button className="btn-ghost" onClick={() => patch(b.id, { enabled: !b.enabled })}>
                          {b.enabled ? "停用" : "啟用"}
                        </button>
                        <button className="btn-ghost" onClick={() => remove(b.id)}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">告警紀錄</span>
            <span className="microlabel">同一筆預算每月每種等級只發一次</span>
          </div>
          {alerts.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚未觸發任何告警。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="t-name">
                      {budgetName(a)}
                      <small>
                        {a.period} · {new Date(a.fired_at).toLocaleString("zh-TW")}
                      </small>
                    </td>
                    <td className={`t-kind ${ALERT_KIND_CLASS[a.level]}`}>
                      〔{ALERT_TEXT[a.level]}〕
                      <small>{Number(a.pct).toFixed(1)}%</small>
                    </td>
                    <td className="t-amt">
                      US${formatUsd(Number(a.spend_usd))}
                      <small>上限 US${formatUsd(Number(a.limit_usd))}</small>
                    </td>
                    <td className="t-act">
                      {a.email_error ? (
                        <span className="microlabel" title={a.email_error}>
                          寄信失敗
                        </span>
                      ) : a.emailed_at ? (
                        <span className="microlabel">已寄信</span>
                      ) : (
                        <span className="microlabel">未寄信</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

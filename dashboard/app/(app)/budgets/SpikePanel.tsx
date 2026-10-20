"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SpikeStatus } from "@/lib/db";

function usd(n: number): string {
  return `US$${n.toFixed(2)}`;
}

/**
 * 單日花費暴增（2026-10-21）。
 *
 * 只列「今天有花錢」的軟體：沒花錢的列出來只是一排 0，反而把要看的那幾列擠下去。
 */
export default function SpikePanel({ status, fx }: { status: SpikeStatus; fx: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/spike-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `儲存失敗（${res.status}）`);
        return;
      }
      setMsg("門檻已更新，下一次整點檢查起生效");
      router.refresh();
    } catch {
      setError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setBusy(false);
    }
  }

  const active = status.rows.filter((r) => r.todayUsd > 0 || r.baselineUsd > 0);

  return (
    <section className="block tight" id="spike">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">單日暴增</span>
          <span className="microlabel">今天比平常多花太多就通知</span>
          <span className="spacer" />
          <button
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              const v = prompt("今天花到平常（前 7 天平均）的幾倍就通知？", String(status.multiplier));
              if (v !== null) save({ multiplier: v });
            }}
          >
            倍數 {status.multiplier}
          </button>
          <button
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              const v = prompt(
                "今天至少要花到多少美金才算？（避免平常幾乎不花錢的軟體，花一點點就被當成暴增）",
                String(status.minUsd)
              );
              if (v !== null) save({ minUsd: v });
            }}
          >
            最低 {usd(status.minUsd)}
          </button>
        </div>

        {status.error ? (
          <div className="form-error">算不出來：{status.error}。這不代表今天沒有暴增。</div>
        ) : active.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            今天與前 7 天都沒有任何軟體經閘道花錢。
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {active.map((r) => (
                <tr key={r.appId} className={r.spiking ? "row-flagged" : undefined}>
                  <td className="t-name">
                    {r.name}
                    <small>
                      前 7 天平均 {usd(r.baselineUsd)}／天（約 NT${(r.baselineUsd * fx).toFixed(0)}）
                      {r.alerted ? " · 今天已寄通知" : ""}
                    </small>
                  </td>
                  <td className="t-kind">{r.spiking ? "〔暴增〕" : "〔正常〕"}</td>
                  <td className="t-amt">{usd(r.todayUsd)}</td>
                  <td className="t-act">
                    <span className="microlabel">
                      {r.ratio !== null ? `${r.ratio.toFixed(1)} 倍` : r.todayUsd > 0 ? "無基準" : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {error && <div className="form-error">{error}</div>}
        {msg && <div className="panel-foot">{msg}</div>}

        <div className="panel-foot">
          判定：今天（台北時間）到目前為止的花費 ≥ 前 7 天每日平均 × {status.multiplier}，而且至少 {usd(status.minUsd)}。
          今天還沒過完就拿來比，所以只會晚報、不會誤報。每小時檢查一次，一個軟體一天最多寄一封信，橫幅整天都在。
          只算經閘道的用量；直連 Vertex 與訂閱額度不在這裡。
          要立刻止血，到「應用程式」頁替那個軟體設「每月上限」。
        </div>
      </div>
    </section>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CreditPoolStatus } from "@/lib/db";

const LEVEL_TEXT: Record<CreditPoolStatus["level"], string> = {
  ok: "〔足夠〕",
  low: "〔該換帳號〕",
  empty: "〔已用完〕",
  unknown: "〔算不出來〕",
};

function twd(n: number | null): string {
  return n === null ? "—" : `NT$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * GCP 贈金餘額（2026-10-08）。
 *
 * 三個動作都用 prompt：一年只會按幾次，不值得做一整張表單，
 * 而且 prompt 的預設值可以直接帶出現在的數字，按錯了按取消就好。
 */
export default function CreditPoolPanel({ pools }: { pools: CreditPoolStatus[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function post(id: number, payload: Record<string, unknown>, done: string) {
    setBusy(id);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/credit-pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `儲存失敗（${res.status}）`);
        return;
      }
      setMsg(done);
      router.refresh();
    } catch {
      setError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="block tight" id="credits">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">贈金餘額</span>
          <span className="microlabel">剩多少就該換帳號</span>
        </div>

        {pools.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            尚未設定任何贈金帳號。
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {pools.map((p) => (
                <tr key={p.id} className={p.level === "low" || p.level === "empty" ? "row-flagged" : undefined}>
                  <td className="t-name">
                    {p.label}
                    <small>
                      {p.anchorDay} 在控制台讀到 {twd(p.anchorBalanceTwd)}
                      {p.grantsTwd > 0 ? ` ＋ 之後補記 ${twd(p.grantsTwd)}` : ""}
                      {" − "}之後被抵掉 {twd(p.usedTwd)}
                    </small>
                    <small>
                      帳單資料到 {p.dataThrough ?? "未知"}
                      {p.dailyBurnTwd !== null ? ` · 最近每天約 NT$${p.dailyBurnTwd.toFixed(0)}` : ""}
                      {p.daysLeft !== null ? ` · 照這個速度約 ${p.daysLeft} 天後碰到警示線` : ""}
                    </small>
                    <small>
                      警示線 NT${p.warnBelowTwd.toFixed(0)}
                      {p.alertedAt
                        ? ` · 已於 ${new Date(p.alertedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} 通知` +
                          (p.alertError ? `（寄信失敗：${p.alertError}）` : "")
                        : ""}
                    </small>
                  </td>
                  <td className="t-kind">{LEVEL_TEXT[p.level]}</td>
                  <td className="t-amt">{twd(p.estimateTwd)}</td>
                  <td className="t-act">
                    {p.consoleUrl ? (
                      <a className="btn-ghost" href={p.consoleUrl} target="_blank" rel="noopener noreferrer">
                        控制台
                      </a>
                    ) : null}
                    <button
                      className="btn-ghost"
                      type="button"
                      disabled={busy === p.id}
                      onClick={() => {
                        const v = prompt(
                          `「${p.label}」控制台「抵免額」頁上，所有「可使用」那幾筆的「剩餘的抵免額」加起來是多少？\n` +
                            "填進來會從今天重新起算，已寄過的警示也會清掉。",
                          p.estimateTwd !== null ? p.estimateTwd.toFixed(2) : ""
                        );
                        if (v !== null) post(p.id, { action: "calibrate", balance: v }, "已校正，從今天重新起算");
                      }}
                    >
                      校正
                    </button>
                    <button
                      className="btn-ghost"
                      type="button"
                      disabled={busy === p.id}
                      onClick={() => {
                        const date = prompt(
                          "新發的這筆贈金，控制台上的「開始日期」是哪天？（YYYY-MM-DD）",
                          new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })
                        );
                        if (date === null) return;
                        const amount = prompt("「原始值」是多少台幣？", "");
                        if (amount === null) return;
                        post(p.id, { action: "grant", date: date.trim(), amount }, "已補記");
                      }}
                    >
                      補記贈金
                    </button>
                    <button
                      className="btn-ghost"
                      type="button"
                      disabled={busy === p.id}
                      onClick={() => {
                        const v = prompt("剩多少台幣就提醒？", p.warnBelowTwd.toFixed(0));
                        if (v !== null) post(p.id, { action: "warn", warn: v }, "警示線已更新");
                      }}
                    >
                      警示線
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {error && <div className="form-error">{error}</div>}
        {msg && <div className="panel-foot">{msg}</div>}

        <div className="panel-foot">
          GCP 的帳單匯出只有「每天被抵掉多少」，沒有「還剩多少」，所以這裡是用某一天在控制台讀到的餘額往下扣出來的<strong>預估值</strong>。
          每月新發的贈金不會自動加進來——沒補記的話預估值會偏低，提醒只會提早、不會晚到。
          跌破警示線會寄一封信、全站掛紅色橫幅；校正或補記之後才會解除。
        </div>
      </div>
    </section>
  );
}

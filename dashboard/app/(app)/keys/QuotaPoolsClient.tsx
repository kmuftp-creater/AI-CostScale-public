"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatTokens } from "@/lib/format";

type Pool = {
  id: number;
  model_name: string;
  provider: string;
  key_count: number;
  keyCountSource?: "gateway" | "manual";
  limit_rpd: number | null;
  limit_tpd: number | null;
  source: "default" | "user";
  enabled: boolean;
  note: string | null;
  usedRequests: number;
  usedTokens: number;
  poolLimitRpd: number | null;
  poolLimitTpd: number | null;
  pctRequests: number | null;
  pctTokens: number | null;
};

function barClass(pct: number | null): string {
  if (pct == null) return "bar-ok";
  if (pct >= 100) return "bar-over";
  if (pct >= 95) return "bar-crit";
  if (pct >= 80) return "bar-warn";
  return "bar-ok";
}

export default function QuotaPoolsClient({ initial }: { initial: Pool[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function patch(id: number, body: Record<string, unknown>) {
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/quota-pools/${id}`, {
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
    } finally {
      setBusy(null);
    }
  }

  if (initial.length === 0) {
    return (
      <div className="empty-state">
        <span className="microlabel">Empty</span>
        尚未建立任何金鑰池。
      </div>
    );
  }

  return (
    <>
      <table className="ledger">
        <tbody>
          {initial.map((p) => (
            <tr key={p.id} className={p.enabled ? undefined : "row-muted"}>
              <td className="t-name">
                {p.model_name}
                <small>
                  {p.provider} · {p.key_count} 把輪替
                  {p.keyCountSource === "gateway" ? "（依閘道設定自動計算）" : "（閘道設定讀不到，暫用手填值）"}
                  {p.limit_rpd == null
                    ? " · 每日上限未設定"
                    : ` · 每把 ${p.limit_rpd.toLocaleString("zh-TW")} 次／日，整池 ${(p.poolLimitRpd ?? 0).toLocaleString("zh-TW")} 次`}
                  {p.limit_tpd == null
                    ? " · 每日 token 上限未設定"
                    : ` · 每把 ${p.limit_tpd.toLocaleString("zh-TW")} tokens／日`}
                  {p.source === "default" ? " · 尚未確認" : ""}
                  {p.enabled ? "" : " · 已停用"}
                </small>
                {p.poolLimitRpd != null && (
                  <div className="rankbar">
                    <i
                      className={barClass(p.pctRequests)}
                      style={{ width: `${Math.min(p.pctRequests ?? 0, 100)}%` }}
                    />
                  </div>
                )}
                {p.note && <small>{p.note}</small>}
              </td>
              <td className="t-amt">
                {p.usedRequests.toLocaleString("zh-TW")} 次
                <small>{formatTokens(p.usedTokens)} tokens（今日）</small>
              </td>
              <td className="t-act">
                <button
                  className="btn-ghost"
                  disabled={busy === p.id}
                  onClick={() => {
                    const v = prompt(
                      `${p.model_name}：每「一把」金鑰的每日請求上限。\n留空代表未知，整池上限會自動乘上 ${p.key_count} 把。`,
                      p.limit_rpd == null ? "" : String(p.limit_rpd)
                    );
                    if (v === null) return;
                    patch(p.id, { limitRpd: v.trim() === "" ? null : v.trim() });
                  }}
                >
                  改每日上限
                </button>
                <button
                  className="btn-ghost"
                  disabled={busy === p.id}
                  onClick={() => {
                    const v = prompt(
                      `${p.model_name}：每「一把」金鑰的每日 token 上限（TPD）。
` +
                        `留空代表未知，整池上限會自動乘上 ${p.key_count} 把。
` +
                        `注意：Google AI Studio 免費層沒有 TPD 這個維度（只有 RPM／TPM／RPD），` +
                        `那幾池留空才是正確的。`,
                      p.limit_tpd == null ? "" : String(p.limit_tpd)
                    );
                    if (v === null) return;
                    patch(p.id, { limitTpd: v.trim() === "" ? null : v.trim() });
                  }}
                >
                  改每日 token 上限
                </button>
                {/* 把數已經跟著閘道設定自動算（2026-09-12），只有設定檔讀不到時才需要手填 */}
                {p.keyCountSource === "gateway" ? null : (
                  <button
                    className="btn-ghost"
                    disabled={busy === p.id}
                    onClick={() => {
                      const v = prompt(`${p.model_name}：這池有幾把金鑰輪替？`, String(p.key_count));
                      if (v && v.trim()) patch(p.id, { keyCount: Number(v.trim()) });
                    }}
                  >
                    改把數
                  </button>
                )}
                <button
                  className="btn-ghost"
                  disabled={busy === p.id}
                  onClick={() => patch(p.id, { enabled: !p.enabled })}
                >
                  {p.enabled ? "停用" : "啟用"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="form-error">{error}</div>}
      <div className="panel-foot">
        兩件事要知道，否則這裡的數字會被誤讀。
        <br />
        一、<strong>只計經本閘道消耗的量</strong>。同一把金鑰若被閘道以外的地方用掉，這裡看不到，
        所以這是估算的下限，不等於供應商端的實際剩餘。
        <br />
        二、日界線用的是<strong>台北時間的當日</strong>，與供應商的額度重設時點不一定一致
        （Google AI Studio 是太平洋時間午夜）。跨重設時點時數字會對不上。
        <br />
        標示「尚未確認」的池，上限是系統帶入的參考值或根本沒填，請依你帳號的實際額度修正。
      </div>
    </>
  );
}

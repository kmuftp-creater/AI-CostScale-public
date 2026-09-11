"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type FxInfo = {
  rate: number;
  baseRate: number;
  markupPct: number;
  source: string;
  day: string | null;
  stale: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  "open.er-api": "open.er-api（主來源）",
  "currency-api": "currency-api（備援）",
  manual: "手動填入",
};

export default function SettingsClient({
  initialFx,
  initialMarkup,
  fxInfo,
}: {
  initialFx: string;
  initialMarkup: string;
  fxInfo: FxInfo;
}) {
  const router = useRouter();
  const [fx, setFx] = useState(initialFx);
  const [markup, setMarkup] = useState(initialMarkup);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      // 兩個值分兩次送。設定 API 一次只收一組 key/value，
      // 為了兩個欄位去改 API 的介面不划算。
      for (const [key, value] of [
        ["fx_usd_twd", fx],
        ["fx_markup_pct", markup],
      ] as const) {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? `儲存失敗（${res.status}）`);
          return;
        }
      }
      setMessage("已儲存");
      router.refresh();
    } catch {
      setError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setSaving(false);
    }
  }

  const auto = fxInfo.source !== "manual";

  return (
    <>
      <div className="ledger-note">
        目前換算用 <strong>{fxInfo.rate.toFixed(4)}</strong>
        {auto ? (
          <>
            {" "}
            ＝ {fxInfo.baseRate.toFixed(4)} × (1 ＋ {fxInfo.markupPct}% 手續費)，
            來源 {SOURCE_LABEL[fxInfo.source] ?? fxInfo.source}，日期 {fxInfo.day}
            {fxInfo.stale ? "（已超過兩天沒更新，抓取可能停了）" : ""}
          </>
        ) : (
          <>（自動匯率尚無資料，正在用下方手動填的值。手續費不套用在手動值上）</>
        )}
      </div>
      <div className="ledger-note">
        這個匯率只用於<strong>尚未發生</strong>的預估。已扣款的訂閱用當天凍結的匯率，
        不會被這裡的數字改寫。GCP 帳單匯出本身即為台幣計價，不經過換匯。
      </div>
      <form onSubmit={save}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="fx">USD 對 TWD 匯率（自動抓取失敗時的備援值）</label>
            <input id="fx" value={fx} onChange={(e) => setFx(e.target.value)} inputMode="decimal" />
          </div>
          <div className="field">
            <label htmlFor="markup">國外交易手續費 %</label>
            <input
              id="markup"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <button className="btn-primary" type="submit" disabled={saving}>
            {saving ? "儲存中…" : "儲存"}
          </button>
        </div>
        {message ? <div className="ledger-note">{message}</div> : null}
        {error ? <div className="login-error">{error}</div> : null}
      </form>
    </>
  );
}

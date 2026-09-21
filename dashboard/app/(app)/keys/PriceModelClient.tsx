"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 替某個部署填自訂單價（2026-09-21）。
 *
 * User：「C6 沒看到可以填價格的地方」。
 *
 * 為什麼需要：花費是閘道記的，它拿後端模型名去查 LiteLLM 內建的價目表。
 * 那份表涵蓋多數公開模型，但**自架模型與剛出的型號沒有**——那時這個部署的花費會記成 0。
 * 對一個賣點是「看得到花多少錢」的東西，記 0 比記錯更糟，因為畫面看起來一切正常。
 *
 * 兩個刻意的設計：
 *
 * 1. **填的是「每百萬 token 多少美元」**，因為所有供應商的價目表都用這個單位。
 *    LiteLLM 存的是每 token，換算在主機端做，不要求人自己除以一百萬。
 * 2. **輸入與輸出要嘛都填、要嘛都清掉。** 只填一邊會讓另一邊悄悄用內建價目，
 *    兩者混用算出來的數字沒有意義。
 */
export default function PriceModelClient({
  modelName,
  inputPerMTok,
  outputPerMTok,
}: {
  modelName: string;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inp, setInp] = useState(inputPerMTok == null ? "" : String(inputPerMTok));
  const [outp, setOutp] = useState(outputPerMTok == null ? "" : String(outputPerMTok));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const custom = inputPerMTok != null;

  async function send(clear: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/upstream-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "price",
          modelName,
          inputPerMTok: clear ? null : inp.trim(),
          outputPerMTok: clear ? null : outp.trim(),
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.error ?? `送出失敗（${res.status}）`);
        return;
      }
      setOpen(false);
      setMsg(d.message ?? "已排入佇列");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (msg) return <span className="key-remove-note">{msg}</span>;

  if (!open) {
    return (
      <button className="btn-ghost" type="button" onClick={() => setOpen(true)}>
        單價
      </button>
    );
  }

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog-card">
        <div className="dialog-title">「{modelName}」的單價</div>
        <div className="ledger-note">
          {custom ? (
            <>
              目前用的是<strong>自訂單價</strong>：每百萬 token 輸入 {inputPerMTok}、輸出{" "}
              {outputPerMTok} 美元。
            </>
          ) : (
            <>
              目前用的是 <strong>LiteLLM 內建價目</strong>。公開模型多半查得到，
              <strong>自架模型與剛出的型號查不到，那時花費會記成 0</strong>——
              畫面看起來正常，但數字是假的。
            </>
          )}
        </div>

        <div className="limit-cur">
          <label className="model-default">
            輸入（每百萬 token，美元）
            <input
              value={inp}
              onChange={(e) => setInp(e.target.value)}
              placeholder="例：0.75"
              inputMode="decimal"
            />
          </label>
          <label className="model-default">
            輸出（每百萬 token，美元）
            <input
              value={outp}
              onChange={(e) => setOutp(e.target.value)}
              placeholder="例：3.75"
              inputMode="decimal"
            />
          </label>
        </div>

        <div className="ledger-note">
          兩欄要一起填。只填一邊的話另一邊會悄悄用內建價目，混著算出來的數字沒有意義。
          填完套用時<strong>閘道會重啟數秒</strong>，失敗會自動回滾。
        </div>
        {err ? <div className="dialog-warn">{err}</div> : null}
        <div className="dialog-actions">
          <button className="btn-ghost" type="button" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </button>
          {custom ? (
            <button className="btn-ghost" type="button" onClick={() => send(true)} disabled={busy}>
              清除自訂單價
            </button>
          ) : null}
          <button className="btn-primary" type="button" onClick={() => send(false)} disabled={busy}>
            {busy ? "送出中…" : "設定單價"}
          </button>
        </div>
      </div>
    </div>
  );
}

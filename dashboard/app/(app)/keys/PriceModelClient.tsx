"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 替某個部署填自訂單價（2026-09-21）。
 *
 * User 一開始問的是「C6 沒看到可以填價格的地方」，看到對話框之後又問了更關鍵的一句：
 * 「不填價格，他也會自動計算嗎？因為你一片空白，我也沒看到現在模型的價格顯示在哪裡」。
 *
 * 會自動算——閘道拿後端模型名去查 LiteLLM 內建的價目表。問題是**算不算得出來**
 * 這件事原本完全看不到：查得到就正常計費，查不到就記成 0，而畫面長得一模一樣。
 * 所以這個對話框現在一定會先講「現在實際用的是多少」，那個數字是跟閘道問來的，
 * 不是我們猜的。
 *
 * 兩個刻意的設計：
 *
 * 1. **填的是「每百萬 token 多少美元」**，因為所有供應商的價目表都用這個單位。
 *    LiteLLM 存的是每 token，換算在主機端做。
 * 2. **輸入與輸出要嘛都填、要嘛都清掉。** 只填一邊會讓另一邊悄悄用內建價目，
 *    兩者混用算出來的數字沒有意義。
 */
export default function PriceModelClient({
  modelName,
  inputPerMTok,
  outputPerMTok,
  effInputPerMTok,
  effOutputPerMTok,
  subscription,
}: {
  modelName: string;
  /** 設定檔裡自訂的。null＝沒自訂。 */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** 閘道實際會用的（自訂有就是自訂、沒有就是內建）。null＝問不到閘道。 */
  effInputPerMTok: number | null;
  effOutputPerMTok: number | null;
  /** 訂閱通道不按 token 計費，0 是正常的，不該當成警告。 */
  subscription: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // 預設帶入「現在實際用的價」，不是空白。要微調的人有起點，要照抄的人也看得到基準。
  const [inp, setInp] = useState(
    inputPerMTok != null ? String(inputPerMTok) : effInputPerMTok ? String(effInputPerMTok) : ""
  );
  const [outp, setOutp] = useState(
    outputPerMTok != null ? String(outputPerMTok) : effOutputPerMTok ? String(effOutputPerMTok) : ""
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const custom = inputPerMTok != null;
  const unknownPrice =
    !custom && !subscription && effInputPerMTok === 0 && effOutputPerMTok === 0;

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

        {/* 第一句話一定是「現在實際是多少」。沒有這一句，人不知道要不要動它。 */}
        <div className="ledger-note">
          {effInputPerMTok == null ? (
            <>現在的單價<strong>問不到閘道</strong>，下面填的值會直接寫進設定檔。</>
          ) : subscription ? (
            <>
              這是<strong>訂閱通道</strong>，不按 token 計費，單價 0 是正常的。
              除非你要估算「如果走 API 要多少錢」，否則不用填。
            </>
          ) : unknownPrice ? (
            <>
              <strong className="k-gone">LiteLLM 的內建價目表裡沒有這一支</strong>，
              所以它的花費<strong>現在被記成 0</strong>——畫面看起來正常，但數字是假的。
              自架模型與剛出的型號都會這樣。請填上單價。
            </>
          ) : (
            <>
              現在實際用的是：每百萬 token 輸入 <strong>{effInputPerMTok}</strong>、輸出{" "}
              <strong>{effOutputPerMTok}</strong> 美元
              {custom ? "（你自己填的）" : "（LiteLLM 內建價目，自動查到的）"}。
              {custom ? "" : "不用動它也會正常計費；只有在內建價目不對或查不到時才需要填。"}
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
          <strong>存進去之後就固定了</strong>——之後供應商調價，LiteLLM 更新內建價目也不會影響這裡，
          要跟著調就回來改或清除。套用時<strong>閘道會重啟數秒</strong>，失敗會自動回滾。
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

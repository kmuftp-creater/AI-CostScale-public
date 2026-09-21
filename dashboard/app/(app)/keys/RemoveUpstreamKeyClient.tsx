"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 移除上游金鑰（2026-09-09）。
 *
 * 為什麼補這個：2026-09-07 做了「新增上游金鑰」，卻只做了新增。
 * 然後我請 User 去停用其中三把舊金鑰——**畫面上根本沒有停用或刪除的入口**，
 * 他的回覆是「你說可以停，但網頁沒有設計介面讓我停用或刪除阿」。
 * 只有單向入口的管理介面，等於把後半段工作丟回給人用 ssh 做。
 *
 * 這顆按鈕做的事：把這把金鑰從 `litellm-config.yaml` 的輪替裡拿掉，
 * 並把 `.env` 那一行改成註解。**值留著**，按錯救得回來——
 * 真正要作廢是去供應商後台停用那把金鑰，那件事只有人做得到。
 *
 * 走的路徑跟新增完全一樣（spool → 主機端 cron），理由見 /api/upstream-keys。
 */

export default function RemoveUpstreamKeyClient({
  envName,
  tail,
  modelNames,
  blockedReason,
}: {
  envName: string;
  tail: string | null;
  modelNames: string[];
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function start() {
    setMsg(null);
    // 擋下來的原因要「講出來」，不是把按鈕變灰。
    // 停用的按鈕不會告訴人為什麼——2026-09-07 已經用這個方式錯過一次。
    if (blockedReason) return setErr(blockedReason);
    setErr(null);
    setAsking(true);
  }

  async function confirm() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/upstream-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "remove", envVar: envName }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.error ?? `送出失敗（${res.status}）`);
        return;
      }
      setAsking(false);
      setMsg(d.message ?? "已排入佇列");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (msg) return <span className="key-remove-note">{msg}</span>;

  return (
    <div className="key-remove">
      {asking ? (
        <>
          {/* 不用 .microlabel：它是 text-transform: uppercase 的標籤樣式，
              套在句子上會把模型名與檔名整個轉成大寫（GEMINI-FLASH-FREE、.ENV）。
              這是一句話，不是一個標籤。 */}
          <div className="key-remove-note">
            要把 <code>{envName}</code>
            {tail ? <code className="key-tail">…{tail}</code> : null} 移出{" "}
            {modelNames.join("、")} 的輪替？套用時閘道會重啟數秒。
            <br />
            <code>.env</code> 那一行會改成註解、值留著，按錯可以救回來。
            金鑰本身要作廢，還是得去供應商後台停用。
          </div>
          <div className="key-remove-row">
            <button className="btn-primary btn-danger" type="button" onClick={confirm} disabled={busy}>
              {busy ? "送出中…" : "確定移除"}
            </button>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => setAsking(false)}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </>
      ) : (
        <button className="btn-ghost" type="button" onClick={start}>
          移除
        </button>
      )}
      {err ? <div className="form-error">{err}</div> : null}
    </div>
  );
}

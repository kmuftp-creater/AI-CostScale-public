"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 換掉某個部署打的後端模型（2026-09-21）。
 *
 * User：「裡面的模型要到期了，但我沒有看到可以更換的地方啊」。
 * 在這之前，要把 gemini-flash-free 從 2.5-flash 換成別支，只能 ssh 進主機改
 * `litellm-config.yaml`——而這個後台存在的意義就是不必那樣做。
 *
 * 三個刻意的設計：
 *
 * 1. **候選清單來自供應商型錄**，不是讓人自己打字。打錯一個字，設定檔看起來
 *    完全正常，要等有人真的呼叫才 404。
 * 2. **候選也會標到期日與預覽版**。從一支要停用的換到另一支要停用的，
 *    等於一個月後再做一次同樣的事。
 * 3. **改的是這個名字底下的每一筆**。像 gemini-flash-free 有五把金鑰輪替，
 *    五筆指著同一支模型；只改一筆會變成一半新一半舊，那是最難查的狀態。
 *
 * 送出只是排進佇列。真正的文字替換、重啟、驗證、失敗回滾都在主機端腳本，
 * 而且套用後會**實際去問閘道有沒有生效**——只看健康檢查是不夠的，
 * 2026-09-21 就發生過「容器根本沒重建、閘道還在跑舊設定」而所有檢查都綠的情況。
 */

export type Candidate = {
  id: string;
  group: string;
  tags: string[];
  stage: string;
  expires: string;
};

const STAGE_TEXT: Record<string, string> = {
  preview: "預覽版",
  experimental: "實驗版",
  inactive: "已停用",
};

export default function RetargetModelClient({
  modelName,
  currentBackend,
  currentGroup,
  candidates,
}: {
  modelName: string;
  /** 目前打的後端，例如 vertex_ai/gemini-2.5-flash。 */
  currentBackend: string;
  /** 目前這一支屬於哪一類（文字／生圖／語音…）。null＝型錄裡查不到。 */
  currentGroup: string | null;
  candidates: Candidate[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  /**
   * 預設只顯示同一類的候選（文字換文字）。
   *
   * 原本是在伺服器端就濾掉別類，結果畫面上每一列只剩「看圖」這個能力標籤，
   * 看起來像「這些模型只會看圖」——User 2026-09-21 就是這樣問的。
   * 現在候選都送過來，分類寫在每一列上，要跨類的話自己打開。
   */
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 前綴要沿用現在這一筆的：vertex_ai/ 換成 gemini/ 是換供應商，不是換模型，
  // 那會連帶換掉計費與金鑰來源，不該藏在「換模型」這顆按鈕底下。
  const prefix = currentBackend.includes("/")
    ? currentBackend.slice(0, currentBackend.indexOf("/") + 1)
    : "";
  const currentId = currentBackend.slice(prefix.length);

  const sameGroup = currentGroup ? candidates.filter((c) => c.group === currentGroup) : candidates;
  const otherCount = candidates.length - sameGroup.length;
  const shown = showAll ? candidates : sameGroup;

  async function submit() {
    if (!picked) return setErr("先選一支要換成什麼");
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/upstream-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "retarget", modelName, backendModel: prefix + picked }),
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
        換掉
      </button>
    );
  }

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog-card">
        <div className="dialog-title">把「{modelName}」改成打哪一支</div>
        <div className="ledger-note">
          目前是 <code>{currentBackend}</code>
          {currentGroup ? `，屬於【${currentGroup}】類` : ""}。
          清單是這把憑證在供應商那邊<strong>現在真的還有</strong>的型號
          {currentGroup ? `，預設只列同一類的（${sameGroup.length} 個）` : ""}。
          每一列後面的小字是<strong>能力標籤</strong>（看圖、聽語音、思考）與風險（預覽版、停用日），不是它的分類。
          <br />
          <strong>這個名字底下的每一筆都會一起改</strong>（輪替用的多把金鑰也是）。
        </div>

        {otherCount > 0 ? (
          <label className="model-opt" style={{ margin: "4px 0" }}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            也顯示其他分類的 {otherCount} 個（生圖、語音、嵌入…）
            <span className="m-hint">換成別類的模型，呼叫端多半會直接壞掉，確定再選</span>
          </label>
        ) : null}

        {shown.length === 0 ? (
          <div className="ledger-note">
            沒有可選的替代型號——供應商型錄還沒抓到，或這一類只有現在這一支。
            主機端每 6 小時抓一次清單。
          </div>
        ) : (
          <div className="model-pick">
            {shown.map((c) => (
              <label key={c.id} className="model-opt">
                <input
                  type="radio"
                  name={`retarget-${modelName}`}
                  checked={picked === c.id}
                  onChange={() => setPicked(c.id)}
                  disabled={c.id === currentId}
                />
                <code>{c.id}</code>
                {c.id === currentId ? <span className="m-hint">目前</span> : null}
                {/* 分類一定要寫出來。只顯示能力標籤的話，文字模型看起來會像「只會看圖」。 */}
                {showAll || c.group !== currentGroup ? (
                  <span className="m-hint">〔{c.group}〕</span>
                ) : null}
                {c.tags.length > 0 ? <span className="m-hint">{c.tags.join("·")}</span> : null}
                {STAGE_TEXT[c.stage] ? <span className="m-hint">{STAGE_TEXT[c.stage]}</span> : null}
                {c.expires ? <span className="m-hint k-gone">{c.expires.slice(5)} 停用</span> : null}
              </label>
            ))}
          </div>
        )}

        <div className="ledger-note">
          送出後由主機端套用（每分鐘檢查一次），過程中<strong>閘道會重啟數秒</strong>。
          套用完會實際去問閘道有沒有生效；沒生效或起不來會自動回滾，結果顯示在「套用紀錄」。
        </div>
        {err ? <div className="dialog-warn">{err}</div> : null}
        <div className="dialog-actions">
          <button className="btn-ghost" type="button" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" type="button" onClick={submit} disabled={busy || !picked}>
            {busy ? "送出中…" : "換成這一支"}
          </button>
        </div>
      </div>
    </div>
  );
}

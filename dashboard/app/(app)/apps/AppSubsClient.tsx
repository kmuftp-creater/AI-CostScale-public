"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type AppSub = {
  id: number;
  name: string;
  vkey_id: string | null;
  sub_note: string | null;
  review_at: string | null;
  board_project_name: string | null;
  billing_client_ids: string[] | null;
  acl_synced_at: string | Date | null;
  acl_error: string | null;
  subs: string[];
};

const SUBS = [
  { key: "sub-claude", label: "Claude" },
  { key: "sub-codex", label: "Codex" },
  { key: "sub-gemini", label: "Gemini" },
  // 產圖走 Codex 內建的 image_gen，吃的是同一個 Codex 週額度池。
  // 分成兩個名稱是因為端點不同（/v1/images/generations），不是兩份額度。
  { key: "sub-imagegen", label: "產圖（Codex）" },
  // Antigravity 訂閱附的 Claude 額度（2026-08-29）。**與上面的 Claude 是兩回事**：
  // 那個吃 Claude Code 訂閱，這個吃 Antigravity 的「Claude and GPT models」配額。
  // 量很小——實測一次呼叫吃掉 5h 視窗的 2.39%，5 小時約 41 次。
  { key: "sub-agy-claude", label: "Claude（Antigravity）" },
] as const;

/** 複查日提醒：到期前一週開始提示。 */
function reviewState(reviewAt: string | null): { text: string; cls: string } | null {
  if (!reviewAt) return null;
  const target = new Date(reviewAt + "T00:00:00");
  const days = Math.ceil((target.getTime() - Date.now()) / 86400000);
  if (days < 0) return { text: `複查日已過 ${-days} 天`, cls: "k-over" };
  if (days === 0) return { text: "今天是複查日", cls: "k-over" };
  if (days <= 7) return { text: `複查日剩 ${days} 天`, cls: "k-warn" };
  return { text: `複查日 ${reviewAt}`, cls: "" };
}

export default function AppSubsClient({ initial }: { initial: AppSub[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);

  /**
   * 把所有軟體的白名單重新推一次。
   *
   * 什麼時候要按：**閘道新增或改名模型之後**。白名單存的是明確的部署名
   * （2026-08-26 起），所以新模型不會自動開放給既有軟體。
   */
  async function resync() {
    setError(null);
    setMsg(null);
    setResyncing(true);
    try {
      const res = await fetch("/api/app-subscriptions/resync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `重新同步失敗（${res.status}）`);
        return;
      }
      const failed: { name: string; error: string }[] = data.failed ?? [];
      if (failed.length > 0) {
        setError(
          `${data.synced.length} 個成功、${failed.length} 個失敗：` +
            failed.map((f) => `${f.name}（${f.error}）`).join("；")
        );
      } else {
        setMsg(
          `已同步 ${data.synced.length} 個軟體，白名單含 ${data.models.length} 個模型：` +
            data.models.join("、")
        );
      }
    } catch {
      setError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setResyncing(false);
    }
  }

  async function save(appId: number, payload: Record<string, unknown>) {
    setBusy(appId);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/app-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "儲存失敗");
        return;
      }
      if (data.warning) setError(data.warning);
      else setMsg("已儲存並同步到閘道");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function toggle(app: AppSub, sub: string) {
    const next = app.subs.includes(sub)
      ? app.subs.filter((s) => s !== sub)
      : [...app.subs, sub];
    // 開啟訂閱是有後果的動作：那會讓這個軟體的用量算進你的訂閱額度。
    if (!app.subs.includes(sub)) {
      const ok = confirm(
        `讓「${app.name}」使用 ${sub} 訂閱？\n\n` +
          "提醒：訂閱的速率限制是全帳號共用的。若這個軟體有其他人在用，" +
          "他們的請求也會吃你的訂閱額度，打爆會連你自己在用的 CLI 一起被擋。"
      );
      if (!ok) return;
    }
    save(app.id, { subs: next });
  }

  return (
    <section className="block tight">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">訂閱橋接</span>
          <span className="microlabel">每個軟體可用哪些訂閱額度</span>
          <span className="spacer" />
          <button className="btn-ghost" type="button" disabled={resyncing} onClick={resync}>
            {resyncing ? "同步中…" : "重新同步白名單"}
          </button>
        </div>

        {initial.length === 0 ? (
          <div className="empty-state">
            <span className="microlabel">Empty</span>
            尚未登記任何軟體。
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {initial.map((app) => {
                const rv = reviewState(app.review_at);
                const pending = app.subs.length > 0 && !app.acl_synced_at;
                return (
                  <tr key={app.id}>
                    <td className="t-name">
                      {app.name}
                      <small>
                        {app.subs.length === 0
                          ? "未使用訂閱，走 API 或免費額度"
                          : `使用 ${app.subs.length} 個訂閱`}
                        {app.vkey_id ? "" : " · 無虛擬金鑰，設定無法生效"}
                      </small>
                      {app.sub_note && <small>{app.sub_note}</small>}
                      <small>
                        看板名 {app.board_project_name ?? "未填"}
                        {" · "}
                        帳單標籤 {app.billing_client_ids?.length
                          ? app.billing_client_ids.join("、")
                          : "未填"}
                      </small>
                      {rv && <small className={rv.cls}>{rv.text}</small>}
                      {app.acl_error && (
                        <small className="k-over">閘道同步失敗：{app.acl_error}</small>
                      )}
                      {pending && !app.acl_error && (
                        <small className="k-warn">尚未同步到閘道，設定還沒生效</small>
                      )}
                    </td>
                    <td className="t-kind">
                      {SUBS.map((s) => (
                        <button
                          key={s.key}
                          className="btn-ghost"
                          disabled={busy === app.id}
                          onClick={() => toggle(app, s.key)}
                          title={app.subs.includes(s.key) ? "點擊關閉" : "點擊開啟"}
                        >
                          {app.subs.includes(s.key) ? `☑ ${s.label}` : `☐ ${s.label}`}
                        </button>
                      ))}
                    </td>
                    <td className="t-act">
                      <button
                        className="btn-ghost"
                        disabled={busy === app.id}
                        onClick={() => {
                          const v = prompt(
                            `「${app.name}」的備註。\n例如：開賣前必須關閉訂閱。`,
                            app.sub_note ?? ""
                          );
                          if (v !== null) save(app.id, { note: v });
                        }}
                      >
                        備註
                      </button>
                      <button
                        className="btn-ghost"
                        disabled={busy === app.id}
                        onClick={() => {
                          const v = prompt(
                            `「${app.name}」的複查日（YYYY-MM-DD，留空取消）。\n` +
                              "到期前一週會在總覽頁提醒你回來檢查這個軟體的訂閱設定。",
                            app.review_at ?? ""
                          );
                          if (v !== null) save(app.id, { reviewAt: v.trim() });
                        }}
                      >
                        複查日
                      </button>
                      <button
                        className="btn-ghost"
                        disabled={busy === app.id}
                        onClick={() => {
                          const v = prompt(
                            `「${app.name}」在 App Hub 看板上的專案名（資料夾名，留空取消）。
` +
                              "例如 260101-my-app。這裡的名字是虛擬金鑰別名，" +
                              "與看板的資料夾名是兩套命名，對不起來就無法把花費掛到專案卡上。",
                            app.board_project_name ?? ""
                          );
                          if (v !== null) save(app.id, { boardProjectName: v.trim() });
                        }}
                      >
                        看板名
                      </button>
                      <button
                        className="btn-ghost"
                        disabled={busy === app.id}
                        onClick={() => {
                          const v = prompt(
                            `「${app.name}」在 GCP 帳單裡的 client_id 標籤，多個用逗號分隔。\n` +
                              "又是另一組字串，例如 myapp 對應的是 myapp_main。\n" +
                              "改過名的專案會有多個歷史標籤——舊版程式送出的標籤" +
                              "會一直留在歷史帳單裡，不會被追溯改寫，所以要全部列出才算得齊。" +
                              "例如 app-a 有 app-a 與 app-a-old 兩個。",
                            (app.billing_client_ids ?? []).join(","),
                          );
                          if (v !== null) save(app.id, { billingClientIds: v });
                        }}
                      >
                        帳單標籤
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {error && <div className="form-error">{error}</div>}
        {msg && <div className="panel-foot">{msg}</div>}

        <div className="panel-foot">
          勾選只決定「這個軟體<strong>能不能</strong>打某個訂閱」，不決定它什麼時候打——
          那由專案端的程式決定要呼叫哪個模型名稱
          （<code>sub-claude</code>、<code>sub-codex</code>、<code>sub-gemini</code>、
          <code>sub-imagegen</code>、<code>sub-agy-claude</code>）。
          所以一個軟體可以新聞摘要走 Gemini、產圖走 <code>sub-imagegen</code>。
          <br />
          產圖與 <code>sub-codex</code> 共用同一個 Codex 週額度，勾一個不會多一份額度。
          <br />
          <strong>「Claude」與「Claude（Antigravity）」是兩份不同的額度。</strong>
          前者是 Claude Code 訂閱，後者是 Antigravity 附的「Claude and GPT models」配額。
          後者實測一次呼叫吃掉 5 小時視窗的 <strong>2.39%</strong>（固定 19,146 個 input token），
          也就是 5 小時大約 41 次、扣掉保留線約 33 次——量少可以等的用途才適合，不要拿來跑批次。
          <br />
          <strong>有其他使用者的軟體不要開。</strong>
          訂閱的速率限制是全帳號共用的，別人的請求也會吃你的額度；
          而且拿訂閱服務外部使用者，多半踩各家的使用條款。
        </div>
      </div>
    </section>
  );
}

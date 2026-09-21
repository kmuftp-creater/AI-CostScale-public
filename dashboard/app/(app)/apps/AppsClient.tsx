"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { last4, formatTokens, formatUsd, formatTwd, formatTaipei } from "@/lib/format";

type AppRow = {
  id: number;
  name: string;
  description: string | null;
  vkey_id: string | null;
  status: string;
  created_at: string;
};

type CostEntry = { spend: number; tokens: number };

/** 每月硬上限的畫面資料（2026-09-10）。金額一律美元，台幣在畫面上換算。 */
type AppLimitView = {
  hardLimitUsd: number | null;
  /** 閘道上金鑰現在的計數，LiteLLM 拿它跟上限比。 */
  keySpendUsd: number | null;
  /** 閘道上實際生效的上限。跟 hardLimitUsd 不一致就是沒套上。 */
  keyMaxBudgetUsd: number | null;
  budgetResetAt: string | null;
  /** 本月（台北月初起，跟閘道歸零邊界一致）經閘道的實際花費。 */
  monthSpendUsd: number | null;
};

/** 同一個金額永遠「美元＋台幣」並列。User 的要求：避免使用者誤會幣別。 */
function Money({ usd, fx }: { usd: number; fx: number }) {
  return (
    <>
      US${formatUsd(usd)}（約 NT${formatTwd(usd * fx)}）
    </>
  );
}

/**
 * 每一列名稱底下的上限說明。
 * 顯示的「已用」在有上限時取閘道的計數——那才是閘道拿去比的數字；
 * 沒上限時計數是從建立起的累計，改顯示本月實際花費。
 */
function LimitLine({ lim, fx }: { lim?: AppLimitView; fx: number }) {
  if (!lim) return null;
  const month = lim.monthSpendUsd;
  if (lim.hardLimitUsd == null) {
    return (
      <small className="limit-line">
        每月上限：不設限
        {month != null ? (
          <>
            {" · 本月已用 "}
            <Money usd={month} fx={fx} />
          </>
        ) : null}
      </small>
    );
  }
  const used = lim.keySpendUsd ?? month ?? 0;
  const pct = lim.hardLimitUsd > 0 ? (used / lim.hardLimitUsd) * 100 : 0;
  const over = used >= lim.hardLimitUsd;
  const drift =
    lim.keyMaxBudgetUsd == null || Math.abs(lim.keyMaxBudgetUsd - lim.hardLimitUsd) > 0.00005;
  return (
    <small className={`limit-line${over || drift ? " limit-over" : ""}`}>
      每月上限 <Money usd={lim.hardLimitUsd} fx={fx} />
      {" · 本期已用 "}
      <Money usd={used} fx={fx} />
      {` · ${pct.toFixed(0)}%`}
      {lim.budgetResetAt ? ` · ${formatTaipei(lim.budgetResetAt)} 歸零` : ""}
      {over ? " · 已達上限，閘道正在拒絕這個軟體的請求" : ""}
      {drift
        ? ` · 注意：閘道上實際的上限是${
            lim.keyMaxBudgetUsd == null ? "「沒有設」" : ` US$${formatUsd(lim.keyMaxBudgetUsd)}`
          }，跟這裡的設定不一致，請重新儲存一次`
        : ""}
    </small>
  );
}

/** 貼上即用範例。顯示與複製共用同一份，才不會出現「看到的跟複製到的不一樣」。 */
const SNIPPET = (key: string, base: string) =>
  [
    `OpenAI 相容 base URL: ${base}/v1`,
    `Gemini 原生 base URL: ${base}`,
    `Authorization: Bearer ${key}`,
  ].join("\n");

type UnattributedEntry = {
  calls: number;
  tokens: number;
  usd: number;
  lastAt: string | null;
};

type Unattributed = {
  masterKey: UnattributedEntry;
  retired: (UnattributedEntry & { alias: string })[];
  totalCalls: number;
  totalTokens: number;
  totalUsd: number;
};

export default function AppsClient({
  initialApps,
  costByVkey,
  unattributed,
  limits,
  modelSettings,
  gatewayModels,
  fx,
  fxNote,
  gatewayUrl,
}: {
  initialApps: AppRow[];
  costByVkey: Record<string, CostEntry>;
  unattributed: Unattributed;
  limits: Record<number, AppLimitView>;
  /** 每個軟體目前的模型設定（2026-09-21）。來源是閘道那把金鑰，不是另存一份。 */
  modelSettings: Record<number, { allowed: string[]; defaultModel: string | null }>;
  /** 閘道上可選的非訂閱模型。訂閱通道走「訂閱橋接」面板，不在這裡選。 */
  gatewayModels: string[];
  /** 1 美元換多少台幣（含手續費）。畫面上所有台幣都用這個換。 */
  fx: number;
  fxNote: string;
  /** 給專案貼的閘道網址（環境變數 GATEWAY_PUBLIC_URL）。 */
  gatewayUrl: string;
}) {
  const router = useRouter();
  const [apps, setApps] = useState(initialApps);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AppRow | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<AppRow | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 每月硬上限的對話框（2026-09-10）
  // 模型設定（2026-09-21）
  const [modelTarget, setModelTarget] = useState<AppRow | null>(null);
  const [modelAllowed, setModelAllowed] = useState<string[]>([]);
  const [modelDefault, setModelDefault] = useState<string>("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  const [limitTarget, setLimitTarget] = useState<AppRow | null>(null);
  const [limitCur, setLimitCur] = useState<"twd" | "usd">("twd");
  const [limitInput, setLimitInput] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitNotice, setLimitNotice] = useState<string | null>(null);

  /**
   * 複製到剪貼簿。
   *
   * 一定要回報成敗：clipboard API 需要安全內容（https 或 localhost），
   * 而且瀏覽器可能拒絕。默默失敗的話，使用者會關掉那個「只顯示一次」的
   * 對話框，然後才發現手上什麼都沒有——那把金鑰就永遠拿不回來了。
   */
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(`${what}:失敗`);
    }
  }

  function openModels(app: AppRow) {
    const cur = modelSettings[app.id];
    setModelAllowed(cur?.allowed?.length ? cur.allowed : gatewayModels);
    setModelDefault(cur?.defaultModel ?? "");
    setModelError(null);
    setModelNotice(null);
    setModelTarget(app);
  }

  async function saveModels() {
    if (!modelTarget) return;
    setModelSaving(true);
    setModelError(null);
    try {
      const all = modelAllowed.length === gatewayModels.length;
      const res = await fetch(`/api/apps/${modelTarget.id}/models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowed: all ? null : modelAllowed,
          defaultModel: modelDefault || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setModelNotice(
        `已更新「${modelTarget.name}」：可用 ${data.allowed.length} 個模型` +
          (data.defaultModel
            ? `，預設模型 ${data.defaultModel}（專案送 ${data.aliasName} 就會打到它）`
            : "，沒有設預設模型")
      );
      setModelTarget(null);
      router.refresh();
    } catch (err) {
      setModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelSaving(false);
    }
  }

  function openLimit(app: AppRow) {
    const cur = limits[app.id]?.hardLimitUsd ?? null;
    setLimitCur("twd");
    setLimitInput(cur != null ? String(Math.round(cur * fx)) : "");
    setLimitError(null);
    setLimitTarget(app);
  }

  /** 使用者輸入換成美元。台幣模式按目前匯率換；換不出來回 null。 */
  function inputToUsd(): number | null {
    const n = Number(limitInput.replace(/,/g, "").trim());
    if (!limitInput.trim() || !Number.isFinite(n) || n <= 0) return null;
    return limitCur === "usd" ? n : n / fx;
  }

  async function saveLimit(clear: boolean) {
    if (!limitTarget) return;
    setLimitError(null);
    const usd = clear ? null : inputToUsd();
    // 錯誤要講出來，不是把按鈕變灰（2026-09-07 的教訓）。
    if (!clear && usd == null) {
      setLimitError("請輸入大於 0 的金額。");
      return;
    }
    if (!clear && usd != null && usd < 0.01) {
      setLimitError(`換算後是 US$${usd.toFixed(4)}，低於閘道能設的最小值 US$0.01。`);
      return;
    }
    setLimitSaving(true);
    try {
      const res = await fetch(`/api/apps/${limitTarget.id}/hard-limit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usd }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLimitError(data.error ?? `儲存失敗（${res.status}）`);
        return;
      }
      setLimitNotice(
        clear
          ? `已解除「${limitTarget.name}」的每月上限。`
          : `已設定「${limitTarget.name}」每月上限 US$${formatUsd(data.usd)}（約 NT$${formatTwd(
              data.usd * fx
            )}）；本期已用已同步為 US$${formatUsd(data.seededSpendUsd ?? 0)}。` +
              (data.warning ? `　${data.warning}` : "")
      );
      setLimitTarget(null);
      router.refresh();
    } catch {
      setLimitError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setLimitSaving(false);
    }
  }

  async function confirmRotate() {
    if (!rotateTarget) return;
    setRotateError(null);
    setRotating(true);
    try {
      const res = await fetch(`/api/apps/${rotateTarget.id}/rotate-key`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRotateError(data.error ?? `重新簽發失敗（${res.status}）`);
        return;
      }
      setApps((prev) => prev.map((a) => (a.id === rotateTarget.id ? data.app : a)));
      setRotateTarget(null);
      setKeyWarning(data.warning ?? null);
      setNewKey(data.key);
      router.refresh();
    } catch {
      setRotateError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setRotating(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `新增失敗（${res.status}）`);
        return;
      }
      setApps((prev) => [data.app, ...prev]);
      // 白名單沒套上就是「這把新鑰現在什麼都打得到，含訂閱通道」，
      // 必須在簽發對話框上講出來，不能只留在 acl_error 欄位裡。
      setKeyWarning(
        data.aclWarning ? `金鑰已簽發，但模型白名單沒套上：${data.aclWarning}　請到本頁按「重新同步白名單」。` : null
      );
      setNewKey(data.key);
      setName("");
      setDescription("");
      router.refresh();
    } catch {
      setError("網路請求失敗，請確認伺服器是否運作中");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveError(null);
    try {
      const res = await fetch(`/api/apps/${archiveTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setArchiveError(data.error ?? `封存失敗（${res.status}）`);
        return;
      }
      setApps((prev) => prev.map((a) => (a.id === archiveTarget.id ? data.app : a)));
      setArchiveTarget(null);
      router.refresh();
    } catch {
      setArchiveError("網路請求失敗，請確認伺服器是否運作中");
    }
  }

  // 已封存的收進展開區（2026-08-29）。
  //
  // 封存不刪列是刻意的：刪掉 apps 那一列，該軟體的歷史花費會對不回任何軟體、
  // 整批跑進「未歸戶」（第六十六節第四段）。但「不刪」的代價是每做一次
  // 端到端實測就多一列，清單會被拋棄式軟體淹掉。
  // 所以是收合不是刪除——資料留著、版面不佔。
  const activeApps = apps.filter((a) => a.status === "active");
  const archivedApps = apps.filter((a) => a.status !== "active");

  return (
    <>
      <section className="block">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">新增軟體</span>
            <span className="microlabel">簽發虛擬金鑰</span>
          </div>
          <form onSubmit={handleCreate}>
            <div className="form-row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="app-name">名稱</label>
                <input
                  id="app-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例：date-ads-analyzer"
                  required
                />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label htmlFor="app-desc">描述（選填）</label>
                <input id="app-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "簽發中…" : "新增軟體"}
              </button>
            </div>
          </form>
          {error ? <div className="login-error">{error}</div> : null}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">軟體清單</span>
            <span className="microlabel">
              啟用中 {activeApps.length} 筆
              {archivedApps.length > 0 ? ` · 已封存 ${archivedApps.length}` : ""}
              {unattributed.totalCalls > 0
                ? ` · 另有未歸戶 US$${formatUsd(unattributed.totalUsd, 4)}`
                : " · 無未歸戶用量"}
            </span>
          </div>
          {apps.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚未新增任何軟體，請用上方表單新增第一個。
            </div>
          ) : activeApps.length === 0 && unattributed.totalCalls === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              目前沒有啟用中的軟體，已封存的 {archivedApps.length} 個收在下方展開區。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {activeApps.map((app) => {
                  const cost = (app.vkey_id && costByVkey[app.vkey_id]) || { spend: 0, tokens: 0 };
                  return (
                    <tr key={app.id}>
                      <td className="t-name">
                        {app.name}
                        <small>金鑰末四碼 ****{last4(app.vkey_id)}</small>
                        <LimitLine lim={limits[app.id]} fx={fx} />
                      </td>
                      <td className="t-kind">
                        <span className={`badge ${app.status === "active" ? "active" : "archived"}`}>
                          {app.status === "active" ? "〔啟用〕" : "〔已封存〕"}
                        </span>
                      </td>
                      <td className="t-amt">US${cost.spend.toFixed(2)}</td>
                      <td className="t-act">
                        {app.status === "active" ? (
                          <>
                            <button className="btn-ghost" type="button" onClick={() => openModels(app)}>
                              模型
                            </button>
                            <button className="btn-ghost" type="button" onClick={() => openLimit(app)}>
                              每月上限
                            </button>
                            <button
                              className="btn-ghost"
                              type="button"
                              onClick={() => {
                                setRotateError(null);
                                setRotateTarget(app);
                              }}
                            >
                              重新簽發
                            </button>
                            <button
                              className="btn-ghost btn-danger"
                              type="button"
                              onClick={() => setArchiveTarget(app)}
                            >
                              封存
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {/* D-8（2026-08-25）：未歸戶原本是另一個面板，看排行時不知道有多少
                    沒被算進去。改成同一張表裡標紅的**一列**——「剩下的」要跟
                    「有歸到的」並排才讀得出比例。
                    刻意只有一列：已撤銷的金鑰有數十把，一把一列會把真正的軟體淹掉，
                    明細收在下面的展開區。 */}
                {unattributed.totalCalls > 0 && (
                  <tr className="row-flagged">
                    <td className="t-name">
                      未歸戶
                      <small>
                        對不回任何軟體的請求。
                        {unattributed.masterKey.calls > 0
                          ? `master key 直接打 ${unattributed.masterKey.calls.toLocaleString("zh-TW")} 次`
                          : "master key 本期沒有直接打"}
                        {unattributed.retired.length > 0
                          ? `；已撤銷金鑰 ${unattributed.retired.length} 把`
                          : ""}
                      </small>
                    </td>
                    <td className="t-kind">〔未歸戶〕</td>
                    <td className="t-amt">US${unattributed.totalUsd.toFixed(2)}</td>
                    <td>
                      <span className="microlabel">
                        {unattributed.totalCalls.toLocaleString("zh-TW")} 次 ·{" "}
                        {formatTokens(unattributed.totalTokens)} tok
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {archivedApps.length > 0 ? (
            <details className="foot-details">
              <summary>已封存 {archivedApps.length} 個</summary>
              <table className="ledger">
                <tbody>
                  {archivedApps.map((app) => {
                    const cost = (app.vkey_id && costByVkey[app.vkey_id]) || { spend: 0, tokens: 0 };
                    return (
                      <tr key={app.id}>
                        <td className="t-name">
                          {app.name}
                          <small>金鑰已撤銷 · 末四碼 ****{last4(app.vkey_id)}</small>
                        </td>
                        <td className="t-kind">
                          <span className="badge archived">〔已封存〕</span>
                        </td>
                        <td className="t-amt">US${cost.spend.toFixed(2)}</td>
                        <td />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <span className="microlabel">
                封存只撤銷金鑰、不刪資料列。刪掉列的話，這些軟體的歷史花費會對不回任何軟體、
                整批跑進上面的「未歸戶」——數字加起來還是對的，只是歸錯地方而且沒有錯誤訊息。
              </span>
            </details>
          ) : null}
          <div className="panel-foot">
            每個軟體的金額，是「用該軟體的虛擬金鑰打的」。
            {unattributed.totalCalls > 0 ? (
              <>
                {" "}
                標紅那一列是<strong>對不回任何軟體的請求</strong>，本期共{" "}
                {unattributed.totalCalls.toLocaleString("zh-TW")} 次、
                {formatTokens(unattributed.totalTokens)} tokens、US$
                {formatUsd(unattributed.totalUsd, 4)}。
                沒有這一列的話，上面的數字看起來就像全部，真的有東西在偷打也不會有人發現。
              </>
            ) : (
              " 本期沒有對不回軟體的請求。"
            )}
            <br />
            閘道的身分是<strong>金鑰不是 IP</strong>。已撤銷的金鑰在
            <code> /key/list</code> 上早就不存在，但別名還留在帳目的 metadata 裡，
            所以照樣指認得出來。IP 只有兩個值（VPS 內部與 nginx 進來），分不出軟體；
            user-agent 閘道沒有存。
            {unattributed.masterKey.calls > 0 || unattributed.retired.length > 0 ? (
              <details className="foot-details">
                <summary>未歸戶明細</summary>
                <table className="ledger">
                  <tbody>
                    {unattributed.masterKey.calls > 0 && (
                      <tr>
                        <td className="t-name">
                          master key 直接打
                          <small>沒有金鑰別名。多半是健檢與人工實測。</small>
                        </td>
                        <td className="t-amt">
                          {unattributed.masterKey.calls.toLocaleString("zh-TW")} 次
                          <small>
                            {formatTokens(unattributed.masterKey.tokens)} tok · 最近{" "}
                            {formatTaipei(unattributed.masterKey.lastAt)}
                          </small>
                        </td>
                      </tr>
                    )}
                    {unattributed.retired.map((r) => (
                      <tr key={r.alias}>
                        <td className="t-name">
                          <code>{r.alias}</code>
                          <small>已撤銷，別名還留在帳目裡所以指認得出來</small>
                        </td>
                        <td className="t-amt">
                          {r.calls.toLocaleString("zh-TW")} 次
                          <small>
                            {formatTokens(r.tokens)} tok · 最近 {formatTaipei(r.lastAt)}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </div>
        </div>
      </section>

      {newKey ? (
        <div className="dialog-overlay" role="dialog" aria-modal="true">
          <div className="dialog-card">
            <div className="dialog-title">虛擬金鑰已簽發</div>
            <div className="dialog-warn">
              此金鑰只會顯示這一次。系統只存雜湊，
              <strong>關掉之後任何人都拿不回來</strong>，包含這個後台。
              請先按「複製金鑰」再關閉。
            </div>
            {keyWarning ? <div className="login-error">{keyWarning}</div> : null}
            <div className="dialog-key">{newKey}</div>
            <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn-ghost" type="button" onClick={() => copy(newKey, "金鑰")}>
                {copied === "金鑰"
                  ? "已複製"
                  : copied === "金鑰:失敗"
                    ? "複製失敗，請手動選取"
                    : "複製金鑰"}
              </button>
            </div>
            <div className="field-hint">貼上即用範例</div>
            <div className="dialog-snippet">{SNIPPET(newKey, gatewayUrl)}</div>
            <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn-ghost" type="button" onClick={() => copy(SNIPPET(newKey, gatewayUrl), "範例")}>
                {copied === "範例"
                  ? "已複製"
                  : copied === "範例:失敗"
                    ? "複製失敗，請手動選取"
                    : "複製接入範例"}
              </button>
            </div>
            <div className="ledger-note">
              同一個專案裡<strong>所有供應商區塊都貼這一把</strong>——
              閘道是看模型名稱路由，不是看金鑰。其他專案各有各的金鑰，不受影響。
            </div>
            <div className="dialog-actions">
              <button
                className="btn-primary"
                type="button"
                onClick={() => {
                  setNewKey(null);
                  setKeyWarning(null);
                }}
              >
                我已保存，關閉
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {limitNotice ? (
        <div className="form-ok limit-notice" role="status">
          {limitNotice}
          <button className="btn-ghost" type="button" onClick={() => setLimitNotice(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {modelNotice ? (
        <div className="form-ok limit-notice" role="status">
          {modelNotice}
          <button className="btn-ghost" type="button" onClick={() => setModelNotice(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {modelTarget ? (
        <div className="dialog-overlay" role="dialog" aria-modal="true">
          <div className="dialog-card">
            <div className="dialog-title">「{modelTarget.name}」可以用哪些模型</div>
            <div className="ledger-note">
              <strong>模型是專案每次呼叫時指定的</strong>，這裡決定的是它「可以」用哪些。
              取消勾選的模型，那個專案打過去會收到 HTTP 403。
              訂閱通道（<code>sub-</code> 開頭）不在這裡設定，那要走下面的「訂閱橋接」面板。
            </div>
            <div className="model-pick">
              {gatewayModels.map((m) => (
                <label key={m} className="model-opt">
                  <input
                    type="checkbox"
                    checked={modelAllowed.includes(m)}
                    onChange={(e) =>
                      setModelAllowed((prev) =>
                        e.target.checked ? [...prev, m] : prev.filter((x) => x !== m)
                      )
                    }
                  />
                  <code>{m}</code>
                </label>
              ))}
            </div>
            <div className="limit-cur" role="group" aria-label="快速選取">
              <button type="button" className="btn-ghost" onClick={() => setModelAllowed(gatewayModels)}>
                全部勾選
              </button>
              <button type="button" className="btn-ghost" onClick={() => setModelAllowed([])}>
                全部取消
              </button>
            </div>
            <label className="model-default">
              預設模型（選填）
              <select value={modelDefault} onChange={(e) => setModelDefault(e.target.value)}>
                <option value="">不指定</option>
                {modelAllowed.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <div className="ledger-note">
              設了預設模型之後，那個專案只要送 <code>default</code> 這個名字就會打到它。
              好處是<strong>以後要換模型，改這裡就好，專案一行都不用動</strong>。
            </div>
            {modelError ? <div className="dialog-warn">{modelError}</div> : null}
            <div className="dialog-actions">
              <button type="button" className="btn-ghost" onClick={() => setModelTarget(null)} disabled={modelSaving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={saveModels} disabled={modelSaving}>
                {modelSaving ? "儲存中…" : "儲存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {limitTarget
        ? (() => {
            const lim = limits[limitTarget.id];
            const usd = inputToUsd();
            const month = lim?.monthSpendUsd ?? 0;
            const tooLow = usd != null && usd <= month;
            return (
              <div className="dialog-overlay" role="dialog" aria-modal="true">
                <div className="dialog-card">
                  <div className="dialog-title">設定「{limitTarget.name}」的每月上限</div>
                  <div className="limit-form">
                    <div className="limit-cur" role="group" aria-label="輸入幣別">
                      <button
                        type="button"
                        className="btn-ghost"
                        aria-pressed={limitCur === "twd"}
                        onClick={() => {
                          if (limitCur === "usd" && usd != null) setLimitInput(String(Math.round(usd * fx)));
                          setLimitCur("twd");
                        }}
                      >
                        用台幣輸入
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        aria-pressed={limitCur === "usd"}
                        onClick={() => {
                          if (limitCur === "twd" && usd != null) setLimitInput(usd.toFixed(2));
                          setLimitCur("usd");
                        }}
                      >
                        用美金輸入
                      </button>
                    </div>
                    <label>
                      每月上限（{limitCur === "twd" ? "新台幣 NT$" : "美金 US$"}）
                      <input
                        value={limitInput}
                        onChange={(e) => setLimitInput(e.target.value.replace(/[^0-9.,]/g, ""))}
                        inputMode="decimal"
                        placeholder={limitCur === "twd" ? "例：300" : "例：10"}
                        autoFocus
                      />
                    </label>
                    <div className="limit-eq">
                      {usd != null ? (
                        <>
                          ＝ <strong>US${formatUsd(usd)}</strong>　約 <strong>NT${formatTwd(usd * fx)}</strong>
                        </>
                      ) : (
                        "輸入金額後，這裡會同時顯示美金與台幣。"
                      )}
                    </div>
                  </div>

                  <div className="ledger-note">
                    本月已用 <Money usd={month} fx={fx} />（{lim?.budgetResetAt
                      ? `${formatTaipei(lim.budgetResetAt)} 歸零`
                      : "每月 1 日 00:00（台北）歸零"}）
                  </div>
                  {tooLow ? (
                    <div className="dialog-warn">
                      這個上限<strong>不高於本月已用</strong>。一存下去，「{limitTarget.name}」打閘道的請求就會
                      <strong>立刻被拒絕</strong>，直到下個月歸零。
                    </div>
                  ) : null}
                  <div className="ledger-note">
                    <strong>上限是用美金存在閘道上的</strong>，實際擋下的點就是那個美金數字。
                    台幣是按目前匯率換算的參考值：{fxNote}。匯率變動時，畫面上的台幣會跟著變，美金上限不會。
                    <br />
                    超過上限之後，閘道會直接拒絕、不會轉發給供應商，那個專案收到的是
                    <strong> HTTP 429</strong>（<code>budget_exceeded</code>）。
                    429 通常被程式當成「太頻繁、稍後重試」——
                    <strong>專案那邊若有自動重試，要把 budget_exceeded 當成不可重試</strong>，否則會一直重打。
                  </div>
                  {limitError ? <div className="login-error">{limitError}</div> : null}
                  <div className="dialog-actions">
                    <button
                      className="btn-ghost"
                      type="button"
                      disabled={limitSaving}
                      onClick={() => setLimitTarget(null)}
                    >
                      取消
                    </button>
                    {lim?.hardLimitUsd != null ? (
                      <button
                        className="btn-ghost btn-danger"
                        type="button"
                        disabled={limitSaving}
                        onClick={() => saveLimit(true)}
                      >
                        解除上限
                      </button>
                    ) : null}
                    <button
                      className="btn-primary"
                      type="button"
                      disabled={limitSaving}
                      onClick={() => saveLimit(false)}
                    >
                      {limitSaving ? "套用中…" : "儲存上限"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}

      {rotateTarget ? (
        <div className="dialog-overlay" role="dialog" aria-modal="true">
          <div className="dialog-card">
            <div className="dialog-title">確認重新簽發「{rotateTarget.name}」的金鑰？</div>
            <div className="dialog-warn">
              舊金鑰會<strong>立刻失效</strong>。在你把新金鑰貼進去之前，
              「{rotateTarget.name}」打閘道的所有請求都會被拒絕。
            </div>
            <div className="ledger-note">
              要換的地方是<strong>這個專案裡每一個貼過金鑰的欄位</strong>
              （各家供應商的區塊都是同一把）。
              <br />
              <strong>其他專案不受影響</strong>——每個軟體各有各的金鑰。
              <br />
              模型白名單會自動套到新金鑰上，訂閱模型的權限不會因為換金鑰而放寬。
            </div>
            {rotateError ? <div className="login-error">{rotateError}</div> : null}
            <div className="dialog-actions">
              <button className="btn-ghost" type="button" disabled={rotating} onClick={() => setRotateTarget(null)}>
                取消
              </button>
              <button className="btn-primary btn-danger" type="button" disabled={rotating} onClick={confirmRotate}>
                {rotating ? "簽發中…" : "確認重新簽發"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {archiveTarget ? (
        <div className="dialog-overlay" role="dialog" aria-modal="true">
          <div className="dialog-card">
            <div className="dialog-title">確認封存「{archiveTarget.name}」？</div>
            <div className="ledger-note">封存會立即撤銷對應的虛擬金鑰，該軟體之後的請求會被 LiteLLM 拒絕。此動作無法復原。</div>
            {archiveError ? <div className="login-error">{archiveError}</div> : null}
            <div className="dialog-actions">
              <button className="btn-ghost" type="button" onClick={() => setArchiveTarget(null)}>
                取消
              </button>
              <button className="btn-primary btn-danger" type="button" onClick={confirmArchive}>
                確認封存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

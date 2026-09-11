"use client";

import { useEffect, useState } from "react";

/**
 * Phase 5 A3 的三個對話框：說明、設定、卡片編輯（含新增待設計）。
 * 內容照搬 App Hub 的 index.html，那是 User 自己寫的說明與欄位，不重新發明。
 */

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="board-modal" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <h2 className="drawer-title">{title}</h2>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="drawer-actions">{footer}</div> : null}
      </div>
    </>
  );
}

/** 說明：內容取自 App Hub 的使用說明，時間久了會忘記怎麼用，這頁就是給那時候看的。 */
export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="使用說明" onClose={onClose}>
      <h3>這是什麼</h3>
      <p>
        彙整各台電腦、各帳號的專案進度，集中在一個畫面查看，並能一鍵開啟本機資料夾與工具繼續開工。
        每張卡片的內容來自該專案的 <code>doc/status.json</code>。
      </p>

      <h3>三種狀態</h3>
      <ul>
        <li><b>待設計</b>：只有想法或剛建資料夾、尚未開工。</li>
        <li><b>設計中</b>：正在開發。已完成的專案若又有新的程式碼開發，會自動標「已重啟」並回到設計中。</li>
        <li><b>已完成</b>：已完工（手動「標記完成」或編輯設為已完成）。</li>
      </ul>

      <h3>怎麼讓專案出現在看板</h3>
      <ul>
        <li><b>有上 GitHub</b>：到「設定 → 追蹤的專案」勾選該 repo，並在其 <code>doc/status.json</code> 填進度。</li>
        <li><b>沒上 GitHub（本機專案）</b>：用推送通道直接送上看板。</li>
        <li><b>只記個構想</b>：點「＋ 新增待設計」手動建一張卡片。</li>
      </ul>

      <h3>如何更新進度</h3>
      <ul>
        <li><b>看板編輯（最快）</b>：開卡片按「編輯」改內容、儲存。GitHub 專案會直接寫回該 repo 的 <code>doc/status.json</code>。</li>
        <li><b>從 Antigravity／Claude 等平台</b>：對 AI 說「更新進度並推送」。</li>
      </ul>

      <h3>欄位紀律（2026-08-22 起）</h3>
      <ul>
        <li><b>進度說明</b>：只寫現況摘要，上限約 500 字。完整開發紀錄屬於專案的 <code>doc/backup-*.md</code>。</li>
        <li><b>備註</b>：<b>只有你會寫</b>，AI 不會動它。先前被普遍違反，源頭已修。</li>
        <li><b>分類</b>：從編輯視窗的下拉清單挑，不要每個專案自己發明。</li>
      </ul>

      <h3>需要注意</h3>
      <p>
        內容區頂部會提醒：停滯超過 30 天的設計中專案、已完成又有新開發、追蹤了卻沒填進度。
        點提醒可以只看那一批。
      </p>

      <h3>重新整理</h3>
      <p>
        看板讀的是資料庫快取，GitHub 側由排程定時同步。按「重新整理」會<b>立刻</b>重抓一次 GitHub，
        本機推送與草稿則是即時的、不需要同步。
      </p>
    </Modal>
  );
}

type SettingsData = {
  tracked: string[];
  categories: string[];
  apps: string[];
  repos: { full: string; name: string; tracked: boolean }[];
  reposError: string | null;
};

/** 設定：追蹤的 repo、軟體分類清單、開啟應用程式清單。 */
export function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [filter, setFilter] = useState("");
  const [catNew, setCatNew] = useState("");
  const [appNew, setAppNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/board/settings")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("讀取設定失敗"));
  }, []);

  async function save() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/board/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracked: data.tracked,
          categories: data.categories,
          apps: data.apps,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error ?? "儲存失敗");
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("網路請求失敗");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <Modal title="設定" onClose={onClose}>
        <div className="form-error">{error}</div>
      </Modal>
    );
  }
  if (!data) {
    return (
      <Modal title="設定" onClose={onClose}>
        <div className="empty-state">讀取中…</div>
      </Modal>
    );
  }

  const shown = data.repos.filter((r) => !filter || r.full.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal
      title="設定"
      onClose={onClose}
      footer={
        <>
          <button className="btn-primary" type="button" onClick={save} disabled={busy}>
            {busy ? "儲存中…" : "儲存"}
          </button>
          <button className="btn-ghost" type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      {error ? <div className="form-error">{error}</div> : null}

      <h3>追蹤的專案（GitHub repo）</h3>
      <p className="microlabel">勾選要顯示在看板的 repo。取消勾選會從看板移除，不會動到 GitHub。</p>
      {data.reposError ? <div className="form-error">{data.reposError}</div> : null}
      <input
        className="board-search"
        placeholder="搜尋 repo 名稱…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="settings-list">
        {shown.map((r) => (
          <li key={r.full}>
            <label>
              <input
                type="checkbox"
                checked={data.tracked.includes(r.full)}
                onChange={(e) =>
                  setData({
                    ...data,
                    tracked: e.target.checked
                      ? [...data.tracked, r.full]
                      : data.tracked.filter((x) => x !== r.full),
                  })
                }
              />
              {r.full}
            </label>
          </li>
        ))}
      </ul>

      <h3>軟體分類清單</h3>
      <p className="microlabel">卡片的分類從這裡挑。專案端的 AI 也被要求只能用清單內的值。</p>
      <ul className="settings-list">
        {data.categories.map((c) => (
          <li key={c}>
            <span>{c}</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setData({ ...data, categories: data.categories.filter((x) => x !== c) })}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-add">
        <input value={catNew} onChange={(e) => setCatNew(e.target.value)} placeholder="新分類，例如 ERP" />
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            if (!catNew.trim()) return;
            setData({ ...data, categories: [...data.categories, catNew.trim()] });
            setCatNew("");
          }}
        >
          ＋ 加入
        </button>
      </div>

      <h3>開啟應用程式清單</h3>
      <p className="microlabel">
        每個專案可複選用哪些工具開啟。實際執行檔路徑由各電腦小幫手的 apps.json 對照。
      </p>
      <ul className="settings-list">
        {data.apps.map((a) => (
          <li key={a}>
            <span>{a}</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setData({ ...data, apps: data.apps.filter((x) => x !== a) })}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-add">
        <input value={appNew} onChange={(e) => setAppNew(e.target.value)} placeholder="例如 Antigravity" />
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            if (!appNew.trim()) return;
            setData({ ...data, apps: [...data.apps, appNew.trim()] });
            setAppNew("");
          }}
        >
          ＋ 加入
        </button>
      </div>
    </Modal>
  );
}

export type EditableCard = {
  id?: string;
  name: string;
  title: string;
  status: string;
  category: string;
  host: string;
  path: string;
  summary: string;
  progress: string;
  notes: string;
  apps: string[];
  links: { label: string; url: string }[];
  cycles: { start: string; end: string; note: string }[];
  tags: string[];
};

/** 編輯／新增卡片。GitHub 卡儲存時會寫回該 repo 的 doc/status.json。 */
export function EditModal({
  initial,
  categories,
  appOptions,
  onClose,
  onSaved,
}: {
  initial: EditableCard;
  categories: string[];
  appOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [c, setC] = useState<EditableCard>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGithub = Boolean(c.id && c.id.includes("/") && !c.id.startsWith("draft:") && !c.id.startsWith("push:"));

  async function save() {
    if (!c.name.trim()) {
      setError("請填專案名稱");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/board/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error ?? "儲存失敗");
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("網路請求失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={c.id ? "編輯專案" : "新增待設計專案"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-primary" type="button" onClick={save} disabled={busy}>
            {busy ? "儲存中…" : "儲存"}
          </button>
          <button className="btn-ghost" type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      {error ? <div className="form-error">{error}</div> : null}
      {isGithub ? (
        <p className="microlabel">
          這是 GitHub 專案：儲存會直接寫回 <code>{c.id}</code> 的 doc/status.json，並清掉手動狀態覆寫。
        </p>
      ) : null}

      <div className="edit-grid">
        <label>
          專案名稱
          <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} disabled={Boolean(c.id)} />
        </label>
        <label>
          顯示標題
          <input value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} />
        </label>
        <label>
          進度狀態
          <select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value })}>
            <option value="planned">待設計</option>
            <option value="in-progress">設計中</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <label>
          軟體分類
          <select value={c.category} onChange={(e) => setC({ ...c, category: e.target.value })}>
            <option value="">未分類</option>
            {[...new Set([...categories, c.category].filter(Boolean))].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label>
          所在電腦
          <input value={c.host} onChange={(e) => setC({ ...c, host: e.target.value })} placeholder="例如 DESKTOP-B12" />
        </label>
        <label>
          本機資料夾路徑
          <input value={c.path} onChange={(e) => setC({ ...c, path: e.target.value })} placeholder="D:\專案\xxx" />
        </label>
      </div>

      <label className="edit-full">
        用哪些工具開啟
        <div className="app-checks">
          {appOptions.map((a) => (
            <label key={a} className="app-check">
              <input
                type="checkbox"
                checked={c.apps.includes(a)}
                onChange={(e) =>
                  setC({ ...c, apps: e.target.checked ? [...c.apps, a] : c.apps.filter((x) => x !== a) })
                }
              />
              {a}
            </label>
          ))}
          {appOptions.length === 0 ? <span className="microlabel">應用程式頁尚未建立清單</span> : null}
        </div>
      </label>

      <label className="edit-full">
        開發週期（結束日留空＝進行中）
        <div className="cycle-editor">
          {c.cycles.map((cy, i) => (
            <div className="cycle-row" key={i}>
              <input
                type="date"
                value={cy.start}
                onChange={(e) => {
                  const next = [...c.cycles];
                  next[i] = { ...cy, start: e.target.value };
                  setC({ ...c, cycles: next });
                }}
              />
              <input
                type="date"
                value={cy.end}
                onChange={(e) => {
                  const next = [...c.cycles];
                  next[i] = { ...cy, end: e.target.value };
                  setC({ ...c, cycles: next });
                }}
              />
              <input
                value={cy.note}
                placeholder="這段做了什麼"
                onChange={(e) => {
                  const next = [...c.cycles];
                  next[i] = { ...cy, note: e.target.value };
                  setC({ ...c, cycles: next });
                }}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setC({ ...c, cycles: c.cycles.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setC({ ...c, cycles: [...c.cycles, { start: "", end: "", note: "" }] })}
          >
            ＋ 新增一段週期
          </button>
        </div>
      </label>

      <label className="edit-full">
        相關連結
        <div className="cycle-editor">
          {c.links.map((l, i) => (
            <div className="cycle-row" key={i}>
              <input
                value={l.label}
                placeholder="標籤"
                onChange={(e) => {
                  const next = [...c.links];
                  next[i] = { ...l, label: e.target.value };
                  setC({ ...c, links: next });
                }}
              />
              <input
                value={l.url}
                placeholder="https://…"
                onChange={(e) => {
                  const next = [...c.links];
                  next[i] = { ...l, url: e.target.value };
                  setC({ ...c, links: next });
                }}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setC({ ...c, links: c.links.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setC({ ...c, links: [...c.links, { label: "", url: "" }] })}
          >
            ＋ 新增連結
          </button>
        </div>
      </label>

      <label className="edit-full">
        簡易說明（一句話，會顯示在卡片上）
        <textarea rows={2} value={c.summary} onChange={(e) => setC({ ...c, summary: e.target.value })} />
      </label>

      <label className="edit-full">
        進度說明（現況摘要，建議 500 字內）
        <textarea rows={6} value={c.progress} onChange={(e) => setC({ ...c, progress: e.target.value })} />
        <span className="microlabel">
          {c.progress.length} 字{c.progress.length > 500 ? "　超過建議長度，完整紀錄請放專案的 doc/backup-*.md" : ""}
        </span>
      </label>

      <label className="edit-full">
        備註（只有你會寫，AI 不會動它）
        <textarea rows={3} value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} />
      </label>

      <label className="edit-full">
        標籤（逗號分隔）
        <input
          value={c.tags.join(", ")}
          onChange={(e) => setC({ ...c, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
        />
      </label>
    </Modal>
  );
}

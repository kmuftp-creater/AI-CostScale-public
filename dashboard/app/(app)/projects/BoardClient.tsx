"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardProject } from "@/lib/db";
import { HelpModal, SettingsModal, EditModal, type EditableCard } from "./BoardModals";

/**
 * Phase 5 A2 唯讀看板，版面 A 案（2026-08-22 User 核定）：摘要卡＋側拉抽屜。
 *
 * 分層原則：卡片是索引（狀態、標題、分類、花費、更新日、停滯旗標、一行摘要），
 * 詳情（完整進度、備註、週期、連結、動作）全部進抽屜。
 * 頁面高度只由卡數決定，不被任何一張卡的內文長度綁架——
 * 專案 AI 會把上千字的收工總結寫進 progress，那是資料治理要管的事，
 * 版面的責任是「再長也不能弄壞排版」。
 *
 * 抽屜在 A3 會直接承載編輯表單，這個容器是兩個階段共用的投資。
 *
 * 篩選與合併語意照搬 App Hub（側欄雙篩選＋需要注意提醒條），
 * 這一層不因版面改案而變。
 */
type CardData = BoardProject & {
  spendGatewayTwd: number | null;
  spendBillingGrossTwd: number | null;
  spendBillingNetTwd: number | null;
};

const STATUS_DEF = [
  { key: "all", label: "顯示全部", icon: "🌐" },
  { key: "planned", label: "待設計", icon: "📋" },
  { key: "in-progress", label: "設計中", icon: "🛠️" },
  { key: "done", label: "已完成", icon: "✅" },
] as const;

const STATUS_META: Record<string, { cls: string; label: string }> = {
  "in-progress": { cls: "progress", label: "設計中" },
  done: { cls: "done", label: "已完成" },
  planned: { cls: "planned", label: "待設計" },
};

type AttnKey = "stale" | "reopened" | "nostatus" | "nohost" | "nopush";

/**
 * 距離最後一次收到推送幾天。null＝不適用或還沒有資料。
 *
 * lastPushedAt 是空字串代表「這個欄位是 2026-08-23 才加的，這張卡從那之後
 * 還沒被推過」。那不等於失聯，所以回 null 不要標紅——真的沒人推的話，
 * 它會一直是空的，而在關注清單裡另有一格「從未收到新推送」。
 */
function pushAgeDays(p: BoardProject): number | null {
  if (!p.lastPushedAt) return null;
  const t = Date.parse(p.lastPushedAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

const ATTN: Record<AttnKey, (p: CardData) => boolean> = {
  stale: (p) => p.status === "in-progress" && p.staleDays !== null && p.staleDays >= 30,
  // 只看本機推送的卡：GitHub 來的不靠推送，draft 是手寫的，兩者都不適用。
  // 判準是「最後一次收到推送」超過 3 天，不是 status.json 自己寫的 updatedAt——
  // 內容沒改但排程還在推的時候 updatedAt 不會動，那不算失聯。
  nopush: (p) => p.source === "pushed" && pushAgeDays(p) !== null && (pushAgeDays(p) as number) >= 3,
  reopened: (p) => p.reactivated,
  nostatus: (p) => p.source === "github" && !p.hasStatusFile,
  // 「開不了」的卡：既沒有本機路徑、也沒有任何雲端連結，點進去只能看文字。
  //
  // 注意判準不是「沒填 host」。App Hub 的 schema 明說純雲端專案可以不填
  // path／apps、改用 links（AI Studio、Canvas 那類），那種卡是完整的。
  // 2026-08-22 實查：26 個 GitHub 卡有 16 個沒有 host，但其中多數有 links，
  // 拿「沒 host」當警訊會把正常的雲端專案全部誤報。
  nohost: (p) => p.hasStatusFile && !p.host && !p.path && p.links.length === 0,
};

function spendText(p: CardData): string {
  const parts: string[] = [];
  if ((p.spendGatewayTwd ?? 0) > 0) parts.push(`閘道 NT$${Math.round(p.spendGatewayTwd!)}`);
  if ((p.spendBillingGrossTwd ?? 0) > 0) parts.push(`GCP NT$${Math.round(p.spendBillingGrossTwd!)}`);
  return parts.join(" · ");
}

/** 週期收斂成一行；多段時滑鼠移上去看完整清單。 */
function cycleLine(p: CardData): { span: string; tip: string } | null {
  const cy = p.cycles;
  if (!cy.length) return null;
  const span = `${cy[0].start || "—"} ~ ${cy[cy.length - 1].end || "進行中"}${cy.length > 1 ? `（${cy.length} 段）` : ""}`;
  const tip = cy
    .map((c, i) => `${i + 1}. ${c.start || "—"} ~ ${c.end || "進行中"}${c.note ? "：" + c.note : ""}`)
    .join(String.fromCharCode(10));
  return { span, tip };
}

function Pills({ p }: { p: CardData }) {
  const sm = STATUS_META[p.status] ?? STATUS_META.planned;
  const stale = p.staleDays !== null && p.staleDays >= 30;
  return (
    <div className="bcard-tagline">
      <span className={`pill pill-status-${sm.cls}`}>{sm.label}</span>
      {p.category ? <span className="pill pill-cat">{p.category}</span> : null}
      {p.source === "draft" ? <span className="pill pill-draft">草稿</span> : null}
      {stale ? (
        <span className="pill pill-stale" title="超過 30 天沒有程式碼活動">
          停滯 {p.staleDays} 天
        </span>
      ) : null}
      {p.reactivated ? <span className="bcard-badge">已重啟</span> : null}
    </div>
  );
}

/**
 * 摘要卡。密度經兩輪調整（2026-08-22 User 回報）：
 * 第一版只剩標題與一行摘要太少，補回主機／帳號／週期、進度前兩行、標籤，
 * 每一段都有硬性行數上限；本輪再補回**卡片上的動作鈕**，
 * 照 App Hub 的分工：開啟（實心）、雲端連結（外框）、次要動作用圖示鈕。
 *
 * 容器從 <button> 換成 <div role="button">：按鈕不能巢狀按鈕與連結，
 * 上一版那樣寫是不合法的 HTML，瀏覽器行為也不保證。
 * 卡片本身仍可點（開抽屜），動作鈕一律 stopPropagation。
 */
function Card({
  p,
  onOpen,
  onEdit,
  onAction,
  onDelete,
  busy,
  periodLabel,
}: {
  p: CardData;
  onOpen: () => void;
  onEdit: () => void;
  onAction: (action: "complete" | "reopen") => void;
  onDelete: () => void;
  busy: boolean;
  periodLabel: string;
}) {
  const spend = spendText(p);
  const cls = (STATUS_META[p.status] ?? STATUS_META.planned).cls;
  const cy = cycleLine(p);
  const appsQ = p.apps.length ? `&apps=${encodeURIComponent(p.apps.join(","))}` : "";
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className={`bcard bcard-st-${cls}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // 只認落在卡片本體上的按鍵。動作鈕與連結是卡片的子元素，鍵盤事件會冒泡上來，
        // 原本沒擋，導致焦點停在「編輯」按 Enter 開的是抽屜、而 preventDefault()
        // 又把按鈕自身的觸發吃掉——鍵盤根本按不動任何一顆動作鈕（2026-08-22 正式站實測）。
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <Pills p={p} />
      <div className="bcard-title">{p.title}</div>

      {(p.host || p.owner || cy) && (
        <div className="bcard-meta-line">
          {p.host ? <span>🖥 {p.host}</span> : null}
          {p.owner ? <span>🐙 {p.owner}</span> : null}
          {cy ? <span title={cy.tip}>📅 {cy.span}</span> : null}
        </div>
      )}

      {p.summary ? <div className="bcard-summary-line">{p.summary}</div> : null}

      {p.progress ? (
        <div className="bcard-progress-peek">
          <div className="bcard-peek-text">
            <span className="bcard-peek-label">進度</span>
            {p.progress}
          </div>
        </div>
      ) : null}

      {p.tags.length > 0 ? (
        <div className="bcard-tag-line">
          {p.tags.slice(0, 8).map((t) => (
            <span className="tag" key={t}>
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="bcard-foot">
        <span className="bcard-date">更新 {p.updatedAt || "—"}</span>
        {spend ? (
          <span className="bcard-spend" title={`${periodLabel} AI 花費。兩個數字部分重疊，不要相加。`}>
            💰 {spend}
          </span>
        ) : null}
      </div>

      <div className="bcard-actions">
        {/* 主要動作：本機開啟（實心）與雲端連結（外框），與 App Hub 的視覺分工一致。 */}
        {p.path ? (
          <a
            className="btn-open"
            href={`apphub://open?path=${encodeURIComponent(p.path)}${appsQ}`}
            onClick={stop}
            title={p.apps.length ? `${p.path}（${p.apps.join("、")}）` : p.path}
          >
            🖥️ 開啟
          </a>
        ) : null}
        {p.links
          .filter((l) => l.url)
          .slice(0, 4)
          .map((l) => (
            <a
              className="btn-link-out"
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              title={l.label ? `${l.label}　${l.url}` : l.url}
            >
              🌐 <span className="btn-label-clip">{l.label || "連結"}</span>
            </a>
          ))}
        {p.url ? (
          <a className="btn-link-out" href={p.url} target="_blank" rel="noreferrer" onClick={stop} title="GitHub">
            GitHub
          </a>
        ) : null}

        {/* 次要動作：圖示鈕，靠右。 */}
        <span className="bcard-mini">
          <button
            type="button"
            className="btn-icon"
            title="編輯"
            disabled={busy}
            onClick={(e) => {
              stop(e);
              onEdit();
            }}
          >
            ✏️
          </button>
          {p.status === "in-progress" ? (
            <button
              type="button"
              className="btn-icon btn-icon-done"
              title="標記完成"
              disabled={busy}
              onClick={(e) => {
                stop(e);
                onAction("complete");
              }}
            >
              ✓
            </button>
          ) : p.status === "done" ? (
            <button
              type="button"
              className="btn-icon"
              title="退回設計中"
              disabled={busy}
              onClick={(e) => {
                stop(e);
                onAction("reopen");
              }}
            >
              ↩
            </button>
          ) : null}
          {p.source !== "github" ? (
            <button
              type="button"
              className="btn-icon btn-icon-danger"
              title="刪除卡片"
              disabled={busy}
              onClick={(e) => {
                stop(e);
                onDelete();
              }}
            >
              🗑️
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** 詳情抽屜。A3 起帶編輯、標記完成／退回、刪除。 */
function Drawer({
  p,
  onClose,
  onEdit,
  onAction,
  onDelete,
  busy,
  periodLabel,
}: {
  p: CardData;
  onClose: () => void;
  onEdit: () => void;
  onAction: (action: "complete" | "reopen") => void;
  onDelete: () => void;
  busy: boolean;
  periodLabel: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const appsQ = p.apps.length ? `&apps=${encodeURIComponent(p.apps.join(","))}` : "";

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="board-drawer" role="dialog" aria-label={p.title}>
        <div className="drawer-top">
          <div className="drawer-head">
            <Pills p={p} />
            <button type="button" className="btn-ghost drawer-close" onClick={onClose} aria-label="關閉">
              ✕
            </button>
          </div>
          <h2 className="drawer-title">{p.title}</h2>
        </div>
        <div className="drawer-meta">
          <span>{p.name}</span>
          {p.host ? <span>🖥 {p.host}</span> : null}
          {p.owner ? <span>🐙 {p.owner}</span> : null}
          {p.updatedAt ? <span>更新 {p.updatedAt}</span> : null}
          {p.lastActivity ? <span>最近活動 {p.lastActivity}</span> : null}
          {p.source === "pushed" ? (
            <span title="最後一次收到這台電腦推送的時間。與『更新』不同——那是 status.json 內容自己寫的日期。">
              📡{" "}
              {p.lastPushedAt
                ? `最後推送 ${new Date(p.lastPushedAt).toLocaleString("zh-TW", {
                    timeZone: "Asia/Taipei",
                    hour12: false,
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
                : "尚未收到新推送"}
            </span>
          ) : null}
        </div>

        {spendText(p) ? (
          <div className="drawer-block">
            <div className="drawer-label">{periodLabel} AI 花費</div>
            <div className="drawer-spend">
              {(p.spendGatewayTwd ?? 0) > 0 ? (
                <div title="經閘道的所有請求，逐筆精確">閘道　NT$ {Math.round(p.spendGatewayTwd!)}</div>
              ) : null}
              {(p.spendBillingGrossTwd ?? 0) > 0 ? (
                <div title="Google 帳單原價。與閘道那個數字部分重疊，不可相加。">
                  GCP　NT$ {Math.round(p.spendBillingGrossTwd!)}
                  {p.spendBillingNetTwd !== null ? `（抵免後 NT$ ${Math.round(p.spendBillingNetTwd)}）` : ""}
                </div>
              ) : null}
              <div className="microlabel">兩個數字部分重疊，不可相加</div>
            </div>
          </div>
        ) : null}

        {p.cycles.length > 0 ? (
          <div className="drawer-block">
            <div className="drawer-label">開發週期</div>
            {p.cycles.map((c, i) => (
              <div key={i} className="drawer-cycle">
                {c.start || "—"} ～ {c.end || "進行中"}
                {c.note ? `　${c.note}` : ""}
              </div>
            ))}
          </div>
        ) : null}

        {p.summary ? (
          <div className="drawer-block">
            <div className="drawer-label">說明</div>
            <div className="drawer-text">{p.summary}</div>
          </div>
        ) : null}

        {p.progress ? (
          <div className="drawer-block">
            <div className="drawer-label">進度說明</div>
            <div className="drawer-text drawer-pre">{p.progress}</div>
          </div>
        ) : null}

        {p.notes ? (
          <div className="drawer-block">
            <div className="drawer-label">備註</div>
            <div className="drawer-text drawer-pre drawer-notes">{p.notes}</div>
          </div>
        ) : null}

        {p.tags.length > 0 ? (
          <div className="drawer-block">
            <div className="bcard-tags">
              {p.tags.map((t) => (
                <span className="tag" key={t}>
                  #{t}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="drawer-actions">
          <button className="btn-primary" type="button" onClick={onEdit} disabled={busy}>
            ✏️ 編輯
          </button>
          {p.status === "in-progress" ? (
            <button className="btn-ghost" type="button" onClick={() => onAction("complete")} disabled={busy}>
              ✓ 標記完成
            </button>
          ) : p.status === "done" ? (
            <button className="btn-ghost" type="button" onClick={() => onAction("reopen")} disabled={busy}>
              ↩ 退回設計中
            </button>
          ) : null}
          {p.source !== "github" ? (
            <button className="btn-ghost" type="button" onClick={onDelete} disabled={busy}>
              🗑️ 刪除
            </button>
          ) : null}
          {p.path ? (
            <a
              className="btn-primary"
              href={`apphub://open?path=${encodeURIComponent(p.path)}${appsQ}`}
              title={p.apps.length ? `${p.path}（${p.apps.join("、")}）` : p.path}
            >
              🖥️ 開啟
            </a>
          ) : null}
          {p.links
            .filter((l) => l.url)
            .map((l) => (
              <a className="btn-ghost" key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                🌐 {l.label || "連結"}
              </a>
            ))}
          {p.url ? (
            <a className="btn-ghost" href={p.url} target="_blank" rel="noreferrer">
              GitHub
            </a>
          ) : null}
        </div>
      </aside>
    </>
  );
}

export default function BoardClient({
  projects,
  githubSyncedAt,
  githubRepoCount,
  categoryOptions,
  appOptions,
  periodLabel,
}: {
  projects: CardData[];
  githubSyncedAt: string | null;
  githubRepoCount: number;
  categoryOptions: string[];
  appOptions: string[];
  /**
   * 卡片上那筆花費算的是哪一段期間（「本月」或「上月」），跟著頁首的日期選單走。
   * 必須傳進來而不是寫死：2026-08-26 把這一頁接上選單之前，
   * 標籤寫死「本月」，選了上月之後金額會換、字不會換——那比沒反應更糟。
   */
  periodLabel: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [attention, setAttention] = useState<AttnKey | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "help" | "settings">(null);
  const [editing, setEditing] = useState<EditableCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** 重新整理：先叫後端立刻重抓 GitHub，再重新載入頁面資料。 */
  async function refresh() {
    setBusy(true);
    setToast("重新整理中…");
    try {
      const res = await fetch("/api/board/sync", { method: "POST" });
      const j = await res.json();
      if (!res.ok) {
        setToast(j.error ?? "同步失敗");
      } else {
        const miss = j.missing?.length ? `，${j.missing.length} 個追蹤中的 repo 找不到` : "";
        setToast(`已同步 ${j.synced}/${j.tracked} 個 repo${miss}`);
      }
    } catch {
      setToast("同步失敗：網路請求錯誤");
    } finally {
      router.refresh();
      setBusy(false);
      setTimeout(() => setToast(null), 6000);
    }
  }

  async function cardAction(id: string, action: "complete" | "reopen") {
    setBusy(true);
    try {
      const res = await fetch("/api/board/cards", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const j = await res.json();
      setToast(res.ok ? (action === "complete" ? "已標記完成" : "已退回設計中") : j.error ?? "操作失敗");
      router.refresh();
      setOpenId(null);
    } catch {
      setToast("操作失敗：網路請求錯誤");
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 5000);
    }
  }

  async function cardDelete(p: CardData) {
    if (!window.confirm(`刪除「${p.title}」這張卡片？（不會動到 GitHub 或本機檔案）`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/board/cards", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id }),
      });
      const j = await res.json();
      setToast(res.ok ? "已刪除" : j.error ?? "刪除失敗");
      router.refresh();
      setOpenId(null);
    } catch {
      setToast("刪除失敗：網路請求錯誤");
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 5000);
    }
  }

  function toEditable(p: CardData): EditableCard {
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      status: p.status,
      category: p.category,
      host: p.host,
      path: p.path,
      summary: p.summary,
      progress: p.progress,
      notes: p.notes,
      apps: p.apps,
      links: p.links,
      cycles: p.cycles,
      tags: p.tags,
    };
  }

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.title, p.name, p.summary, p.category, ...p.tags].join(" ").toLowerCase().includes(q)
    );
  }, [projects, search]);

  const byStatus = useMemo(
    () => searched.filter((p) => status === "all" || p.status === status),
    [searched, status]
  );

  const categories = useMemo(() => {
    const cats = new Map<string, number>();
    for (const p of byStatus) {
      const c = p.category || "未分類";
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    return [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hant"));
  }, [byStatus]);

  const list = useMemo(() => {
    if (attention) return projects.filter(ATTN[attention]);
    return byStatus.filter((p) => category === "all" || (p.category || "未分類") === category);
  }, [projects, byStatus, category, attention]);

  const attnItems = (
    [
      { key: "stale", icon: "🔴", label: "停滯超過 30 天" },
      { key: "nopush", icon: "📡", label: "超過 3 天沒收到推送" },
      { key: "reopened", icon: "🔄", label: "已完成又有新開發" },
      { key: "nostatus", icon: "📝", label: "追蹤中尚未填進度" },
      { key: "nohost", icon: "🖥", label: "開不了（無路徑也無連結）" },
    ] as { key: AttnKey; icon: string; label: string }[]
  )
    .map((x) => ({ ...x, n: projects.filter(ATTN[x.key]).length }))
    .filter((x) => x.n > 0);

  const opened = openId !== null ? list.find((p) => p.id === openId) ?? projects.find((p) => p.id === openId) : null;

  return (
    <>
      <section className="block">
        <div className="board-topbar">
          <input
            className="board-search"
            type="search"
            placeholder="搜尋名稱、說明或關鍵字…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="board-tools">
            <button className="btn-ghost" type="button" onClick={refresh} disabled={busy}>
              ↻ 重新整理
            </button>
            <button className="btn-ghost" type="button" onClick={() => setModal("settings")}>
              ⚙ 設定
            </button>
            <button className="btn-ghost" type="button" onClick={() => setModal("help")}>
              ？說明
            </button>
            <button
              className="btn-primary"
              type="button"
              onClick={() =>
                setEditing({
                  name: "",
                  title: "",
                  status: "planned",
                  category: "",
                  host: "",
                  path: "",
                  summary: "",
                  progress: "",
                  notes: "",
                  apps: [],
                  links: [],
                  cycles: [],
                  tags: [],
                })
              }
            >
              ＋ 新增待設計
            </button>
          </div>
        </div>
        <div className="board-status-line">
          <span className="microlabel">
            {githubSyncedAt
              ? `GitHub ${githubRepoCount} repo · 同步 ${new Date(githubSyncedAt).toLocaleString("zh-TW")}`
              : "GitHub 側尚未同步（缺 GITHUB_TOKEN）"}
          </span>
          {toast ? <span className="board-toast">{toast}</span> : null}
        </div>
      </section>

      <section className="block tight">
        <div className="board-layout">
          <aside className="board-side">
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">進度狀態</span>
              </div>
              <ul className="board-side-list">
                {STATUS_DEF.map((s) => {
                  const n =
                    s.key === "all" ? searched.length : searched.filter((p) => p.status === s.key).length;
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        className={status === s.key && !attention ? "active" : ""}
                        onClick={() => {
                          setStatus(s.key);
                          setAttention(null);
                        }}
                      >
                        <span>{s.icon}</span>
                        <span className="grow">{s.label}</span>
                        <span className="s-count">{n}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">軟體分類</span>
              </div>
              <ul className="board-side-list">
                <li>
                  <button
                    type="button"
                    className={category === "all" && !attention ? "active" : ""}
                    onClick={() => {
                      setCategory("all");
                      setAttention(null);
                    }}
                  >
                    <span>🗂️</span>
                    <span className="grow">全部分類</span>
                    <span className="s-count">{byStatus.length}</span>
                  </button>
                </li>
                {categories.map(([c, n]) => (
                  <li key={c}>
                    <button
                      type="button"
                      className={category === c && !attention ? "active" : ""}
                      onClick={() => {
                        setCategory(c);
                        setAttention(null);
                      }}
                    >
                      <span>•</span>
                      <span className="grow">{c}</span>
                      <span className="s-count">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <main className="board-main">
            {attnItems.length > 0 && (
              <div className="board-attn">
                <span className="microlabel">需要注意</span>
                {attnItems.map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    className={`attn-chip${attention === x.key ? " active" : ""}`}
                    onClick={() => setAttention(attention === x.key ? null : x.key)}
                  >
                    {x.icon} {x.label} <span className="s-count">{x.n}</span>
                  </button>
                ))}
                {attention ? (
                  <button type="button" className="attn-chip" onClick={() => setAttention(null)}>
                    ✕ 清除
                  </button>
                ) : null}
              </div>
            )}
            <div className="microlabel" style={{ marginBottom: "0.6rem" }}>
              顯示 {list.length} / {projects.length} 個專案
            </div>
            {list.length === 0 ? (
              <div className="panel">
                <div className="empty-state">
                  <span className="microlabel">Empty</span>
                  沒有符合條件的專案，試試清除搜尋或切換其他狀態／分類。
                </div>
              </div>
            ) : (
              <div className="board-grid">
                {list.map((p) => (
                  <Card
                    p={p}
                    key={p.id}
                    busy={busy}
                    periodLabel={periodLabel}
                    onOpen={() => setOpenId(p.id)}
                    onEdit={() => setEditing(toEditable(p))}
                    onAction={(a) => cardAction(p.id, a)}
                    onDelete={() => cardDelete(p)}
                  />
                ))}
              </div>
            )}
          </main>
        </div>
      </section>

      {opened ? (
        <Drawer
          p={opened}
          busy={busy}
          periodLabel={periodLabel}
          onClose={() => setOpenId(null)}
          onEdit={() => setEditing(toEditable(opened))}
          onAction={(a) => cardAction(opened.id, a)}
          onDelete={() => cardDelete(opened)}
        />
      ) : null}

      {modal === "help" ? <HelpModal onClose={() => setModal(null)} /> : null}
      {modal === "settings" ? (
        <SettingsModal
          onClose={() => setModal(null)}
          onSaved={() => {
            setToast("設定已儲存，正在重抓 GitHub…");
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <EditModal
          initial={editing}
          categories={categoryOptions}
          appOptions={appOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setToast("已儲存");
            setOpenId(null);
            router.refresh();
            setTimeout(() => setToast(null), 5000);
          }}
        />
      ) : null}
    </>
  );
}

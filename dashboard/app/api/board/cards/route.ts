import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getPool } from "@/lib/db";
import { writeStatusJson, lastCommitDate } from "@/lib/board-write";

export const dynamic = "force-dynamic";

/**
 * 看板卡片的寫入端（Phase 5 A3）。三種卡片的寫入位置不同，這是本檔的核心：
 *
 *   draft:*   純本地草稿      → board_cards
 *   push:*    本機推送的專案  → board_cards（不碰 GitHub，那是推送通道的地盤）
 *   owner/repo GitHub 專案    → **寫回該 repo 的 doc/status.json**，資料庫只是快取
 *
 * 第三種是關鍵：GitHub 卡的真相在 repo 裡，只改快取會在下次同步被蓋掉。
 * 這與 App Hub 的 functions/api/status.js 是同一套規則。
 */

type Body = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "p"
  );
}

/** 從請求整理出一份乾淨的卡片資料，三種卡片共用。 */
function normalize(body: Body) {
  const status = str(body.status) || "planned";
  return {
    name: str(body.name),
    title: str(body.title) || str(body.name),
    status: ["planned", "in-progress", "done"].includes(status) ? status : "planned",
    category: str(body.category),
    host: str(body.host),
    path: str(body.path),
    summary: str(body.summary),
    progress: str(body.progress),
    notes: str(body.notes),
    apps: arr(body.apps).map((x) => String(x).trim()).filter(Boolean),
    links: arr(body.links)
      .map((l) => {
        const o = l as Record<string, unknown>;
        return { label: str(o?.label), url: str(o?.url) };
      })
      .filter((l) => l.url),
    cycles: arr(body.cycles).map((c) => {
      const o = c as Record<string, unknown>;
      return { start: str(o?.start), end: str(o?.end), note: str(o?.note) };
    }),
    tags: arr(body.tags).map((x) => String(x).trim()).filter(Boolean),
    updatedAt: str(body.updatedAt) || new Date().toISOString().slice(0, 10),
  };
}

/** POST：新增草稿，或就地編輯任一種卡片（帶 id 就是編輯）。 */
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }

  const data = normalize(body);
  if (!data.name) return NextResponse.json({ error: "請填專案名稱" }, { status: 400 });

  const id = str(body.id);
  const client = getPool();

  // GitHub 卡：寫回 repo 的 doc/status.json，真相在那裡。
  if (id && id.includes("/") && !id.startsWith("draft:") && !id.startsWith("push:")) {
    try {
      // completedAt 沿用既有值，不要用「按下編輯的今天」蓋掉歷史。
      const { rows } = await client.query(
        `SELECT status_json FROM costscale.board_github WHERE repo = $1`,
        [id]
      );
      const prev = (rows[0]?.status_json ?? {}) as Record<string, unknown>;
      await writeStatusJson(id, { ...data, completedAt: prev.completedAt ?? null });
      // 寫回後快取立刻更新，不然畫面要等下一次同步才會變。
      await client.query(
        `UPDATE costscale.board_github SET status_json = $2 WHERE repo = $1`,
        [id, JSON.stringify({ ...data, completedAt: prev.completedAt ?? null })]
      );
      return NextResponse.json({ ok: true, target: "github" });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "寫回 GitHub 失敗" },
        { status: 500 }
      );
    }
  }

  // 草稿與本機推送卡：寫 board_cards。
  const isDraft = id ? id.startsWith("draft:") : true;
  const cardId = id || `draft:d_${slug(data.name)}_${Date.now().toString(36)}`;
  const source = isDraft ? "draft" : "pushed";

  await client.query(
    `INSERT INTO costscale.board_cards
       (id, source, name, title, status, category, host, path, summary, progress, notes,
        apps, links, cycles, tags, updated_at, created_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, title=EXCLUDED.title, status=EXCLUDED.status,
       category=EXCLUDED.category, host=EXCLUDED.host, path=EXCLUDED.path,
       summary=EXCLUDED.summary, progress=EXCLUDED.progress, notes=EXCLUDED.notes,
       apps=EXCLUDED.apps, links=EXCLUDED.links, cycles=EXCLUDED.cycles, tags=EXCLUDED.tags,
       updated_at=EXCLUDED.updated_at, raw=EXCLUDED.raw`,
    [
      cardId,
      source,
      data.name,
      data.title,
      data.status,
      data.category,
      data.host,
      data.path,
      data.summary,
      data.progress,
      data.notes,
      JSON.stringify(data.apps),
      JSON.stringify(data.links),
      JSON.stringify(data.cycles),
      JSON.stringify(data.tags),
      data.updatedAt,
      JSON.stringify({ ...data, id: cardId, source }),
    ]
  );
  return NextResponse.json({ ok: true, id: cardId, target: source });
}

/** DELETE：刪掉草稿或本機推送卡。GitHub 卡不給刪——那要去取消追蹤。 */
export async function DELETE(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const id = str(body.id);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  if (!id.startsWith("draft:") && !id.startsWith("push:")) {
    return NextResponse.json(
      { error: "GitHub 專案不能從看板刪除，請到設定取消追蹤。" },
      { status: 400 }
    );
  }

  const client = getPool();
  await client.query(`DELETE FROM costscale.board_cards WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}

/**
 * PATCH：標記完成／退回設計中。
 *
 * GitHub 卡走 board_overrides（蓋在 status.json 之上），本機卡直接改 status。
 * 標記完成的結束日取**最後一次 commit 的日期**，不是按下的今天——
 * 那反映真正的停工時間，是 App Hub 刻意的設計。
 */
export async function PATCH(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  const id = str(body.id);
  const action = str(body.action);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  if (!["complete", "reopen"].includes(action)) {
    return NextResponse.json({ error: "action 只能是 complete 或 reopen" }, { status: 400 });
  }

  const client = getPool();
  const nextStatus = action === "complete" ? "done" : "in-progress";

  if (id.startsWith("draft:") || id.startsWith("push:")) {
    await client.query(`UPDATE costscale.board_cards SET status = $2 WHERE id = $1`, [id, nextStatus]);
    return NextResponse.json({ ok: true, status: nextStatus });
  }

  let endDate: string | null = null;
  if (action === "complete") {
    try {
      endDate = await lastCommitDate(id);
    } catch {
      endDate = null;
    }
  }
  await client.query(
    `INSERT INTO costscale.board_overrides (repo, status, end_date, raw)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (repo) DO UPDATE SET
       status=EXCLUDED.status, end_date=EXCLUDED.end_date, raw=EXCLUDED.raw, imported_at=now()`,
    [id, nextStatus, endDate, JSON.stringify({ status: nextStatus, endDate })]
  );
  return NextResponse.json({ ok: true, status: nextStatus, endDate });
}

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/board/push —— 本機推送通道（Phase 5 A4）。
 *
 * body 與 App Hub 的 /api/push 完全相容：{ token, project }，
 * 所以各電腦的 push-status.ps1 只要在設定檔多加一個目標就能雙推，
 * 不必改腳本邏輯。
 *
 * 驗證用獨立的 BOARD_PUSH_TOKEN，不是登入 session：
 * 推送來自各電腦的排程，沒有瀏覽器也沒有 Google 登入。
 * 未設定就回 503 停用——預設關比預設開安全（與 /api/hub/spend 同一原則）。
 */

function slug(name: string): string {
  return (
    String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "p"
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 固定時間比對，不因前綴相同而提早返回。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  const expected = process.env.BOARD_PUSH_TOKEN || "";
  if (!expected) {
    return NextResponse.json({ error: "伺服器未設定 BOARD_PUSH_TOKEN，推送通道停用" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  if (!safeEqual(String(body.token || ""), expected)) {
    return NextResponse.json({ error: "推送金鑰錯誤" }, { status: 401 });
  }

  const p = (body.project || {}) as Record<string, unknown>;
  const name = str(p.name);
  if (!name) return NextResponse.json({ error: "project.name 為空" }, { status: 400 });

  const status = ["planned", "in-progress", "done"].includes(str(p.status)) ? str(p.status) : "in-progress";
  const id = `push:${slug(name)}`;
  const client = getPool();

  // pushed_at 保留第一次的值（App Hub 同樣做法）＝「這張卡是什麼時候出現的」。
  // last_pushed_at 每次都更新＝「還有沒有人在推」。兩件事都要，不能只留一個：
  // 只有 pushed_at 的時候，看不出一張卡是還活著還是早就沒人推了——
  // 2026-08-23 查 auto-line 那兩張重複的卡就是卡在這裡（第四十七節 C-7）。
  await client.query(
    `INSERT INTO costscale.board_cards
       (id, source, name, title, status, category, host, path, summary, progress, notes,
        apps, links, cycles, tags, updated_at, pushed_at, last_pushed_at, raw)
     VALUES ($1,'pushed',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now(),$16)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, title=EXCLUDED.title, status=EXCLUDED.status,
       category=EXCLUDED.category, host=EXCLUDED.host, path=EXCLUDED.path,
       summary=EXCLUDED.summary, progress=EXCLUDED.progress, notes=EXCLUDED.notes,
       apps=EXCLUDED.apps, links=EXCLUDED.links, cycles=EXCLUDED.cycles, tags=EXCLUDED.tags,
       updated_at=EXCLUDED.updated_at,
       pushed_at=COALESCE(costscale.board_cards.pushed_at, EXCLUDED.pushed_at),
       last_pushed_at=now(),
       raw=EXCLUDED.raw`,
    [
      id,
      name,
      str(p.title) || name,
      status,
      str(p.category),
      str(p.host),
      str(p.path),
      str(p.summary),
      str(p.progress),
      str(p.notes),
      JSON.stringify(Array.isArray(p.apps) ? p.apps : []),
      JSON.stringify(Array.isArray(p.links) ? p.links : []),
      JSON.stringify(Array.isArray(p.cycles) ? p.cycles : []),
      JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
      str(p.updatedAt),
      JSON.stringify(p),
    ]
  );

  return NextResponse.json({ ok: true, name, id });
}

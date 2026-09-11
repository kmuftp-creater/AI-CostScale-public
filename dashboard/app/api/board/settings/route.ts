import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getPool } from "@/lib/db";
import { listAllRepos } from "@/lib/board-write";

export const dynamic = "force-dynamic";

/** 三個設定鍵都存 JSON 陣列字串，與 App Hub 的 KV 同形狀，讀寫端不必轉換。 */
const KEYS = {
  tracked: "board_tracked",
  categories: "board_categories",
  apps: "board_apps",
} as const;

async function readList(key: string): Promise<string[]> {
  const client = getPool();
  const { rows } = await client.query(`SELECT value FROM costscale.settings WHERE key = $1`, [key]);
  if (!rows[0]) return [];
  try {
    const v = JSON.parse(rows[0].value);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** GET：設定頁需要的全部資料，含可勾選的 repo 清單。 */
export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;

  const [tracked, categories, apps] = await Promise.all([
    readList(KEYS.tracked),
    readList(KEYS.categories),
    readList(KEYS.apps),
  ]);

  // repo 清單要打 GitHub，慢且可能沒設 token——失敗時回空陣列，
  // 設定頁的其他兩區照樣可用，不要因為一區壞掉整頁開不了。
  let repos: { full: string; name: string; tracked: boolean }[] = [];
  let reposError: string | null = null;
  try {
    repos = await listAllRepos();
    if (!repos.length) reposError = "沒有取得任何 repo（可能未設定 GITHUB_TOKEN）";
  } catch (err) {
    reposError = err instanceof Error ? err.message : "取得 repo 清單失敗";
  }

  return NextResponse.json({ tracked, categories, apps, repos, reposError });
}

/** PUT：整組覆寫。只送有帶的欄位，沒帶的不動。 */
export async function PUT(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }

  const client = getPool();
  const saved: string[] = [];
  for (const [field, key] of Object.entries(KEYS)) {
    const v = body[field];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return NextResponse.json({ error: `${field} 必須是陣列` }, { status: 400 });
    }
    // 去重、去空白、保持順序，避免設定頁按一按就塞進重複值。
    const clean = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
    await client.query(
      `INSERT INTO costscale.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(clean)]
    );
    saved.push(field);
  }

  return NextResponse.json({ ok: true, saved });
}

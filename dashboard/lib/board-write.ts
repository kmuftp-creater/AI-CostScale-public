import { getPool } from "@/lib/db";

/**
 * Phase 5 A3：看板的寫入側與 GitHub 同步。
 *
 * 為什麼同步從 python 腳本搬進這裡：原本 `scripts/sync-board-github.py` 只能由
 * VPS 的 cron 跑，介面上的「重新整理」按不到它——而 App Hub 的重新整理是即時的，
 * 少了它就等於少一個功能。改成 TS 之後同一份實作同時服務按鈕與排程
 * （排程改打 POST /api/board/sync 帶 token），不維護兩份語意。
 *
 * 語意全部照搬 App Hub 的 functions/api/*.js，逐項對應寫在各函式的註解裡。
 */

const GH_API = "https://api.github.com";

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "costscale-board",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** 多帳號：GITHUB_TOKENS（逗號分隔）優先，否則單把 GITHUB_TOKEN。 */
export function githubTokens(): string[] {
  const multi = (process.env.GITHUB_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const one = (process.env.GITHUB_TOKEN || "").trim();
  return one ? [one] : [];
}

type GhRepo = {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  created_at: string;
  pushed_at: string;
  owner: { login: string };
};

async function ghJson<T>(token: string, url: string): Promise<T | null> {
  const r = await fetch(url, { headers: ghHeaders(token), cache: "no-store" });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

async function listRepos(token: string): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ghJson<GhRepo[]>(
      token,
      `${GH_API}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`
    );
    if (!batch) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** owner/repo → 能存取它的 token。設定頁與寫回都需要。 */
export async function resolveToken(owner: string): Promise<string | null> {
  for (const t of githubTokens()) {
    const u = await ghJson<{ login?: string }>(t, `${GH_API}/user`);
    if (u?.login && u.login.toLowerCase() === owner.toLowerCase()) return t;
  }
  return null;
}

async function statusFile(token: string, full: string): Promise<unknown | null> {
  const meta = await ghJson<{ content?: string }>(token, `${GH_API}/repos/${full}/contents/doc/status.json`);
  if (!meta?.content) return null;
  try {
    // GitHub 回的 base64 帶換行；BOM 也要吃掉，否則 JSON.parse 失敗。
    const text = Buffer.from(meta.content.replace(/\n/g, ""), "base64").toString("utf8").replace(/^﻿/, "");
    return JSON.parse(text);
  } catch {
    // 檔在但不是合法 JSON——與 App Hub 同樣退化成「沒有檔」，不讓一個壞檔擋住整批同步。
    return null;
  }
}

/**
 * 最近一次「真正的程式碼開發」日期。
 * 略過看板自己寫 status.json 的 commit——不濾掉的話，每次備存推送都會把
 * 停滯天數歸零，停滯偵測就永遠不會亮。這是 App Hub 原本就有的規則。
 */
async function lastCodeActivity(token: string, full: string): Promise<string | null> {
  const arr = await ghJson<{ commit?: { message?: string; committer?: { date?: string }; author?: { date?: string } } }[]>(
    token,
    `${GH_API}/repos/${full}/commits?per_page=15`
  );
  if (!arr?.length) return null;
  const isBoardWrite = (msg?: string) => {
    const m = String(msg || "").toLowerCase();
    return m.includes("status.json") || m.includes("進度看板") || m.includes("app progress board");
  };
  for (const c of arr) {
    if (isBoardWrite(c.commit?.message)) continue;
    const d = c.commit?.committer?.date || c.commit?.author?.date;
    if (d) return d.slice(0, 10);
  }
  const last = arr[arr.length - 1].commit;
  const d = last?.committer?.date;
  return d ? d.slice(0, 10) : null;
}

export type SyncResult = { synced: number; tracked: number; missing: string[] };

/** 同步所有追蹤中的 repo 進 board_github。介面的「重新整理」與排程共用這一支。 */
export async function syncBoardGithub(): Promise<SyncResult> {
  const tokens = githubTokens();
  if (!tokens.length) throw new Error("伺服器未設定 GITHUB_TOKEN");

  const client = getPool();
  const { rows } = await client.query(`SELECT value FROM costscale.settings WHERE key = 'board_tracked'`);
  const tracked: string[] = rows[0] ? JSON.parse(rows[0].value) : [];
  if (!tracked.length) return { synced: 0, tracked: 0, missing: [] };

  // GitHub 的 owner/repo 路徑不分大小寫，但追蹤清單存的是使用者當初寫下的字面值。
  // 用字面值做 Map 比對，repo 改過大小寫（例如 My-App → my-app）就會被
  // 整個判成「找不到」而靜默漏掉。改用小寫當鍵，並把清單正規化成 GitHub 的正式名稱
  // 寫回設定——否則底下那道 DELETE 會立刻把剛寫進去的列再刪掉。
  const owned = new Map<string, { repo: GhRepo; token: string }>();
  for (const t of tokens) {
    for (const r of await listRepos(t)) {
      const k = r.full_name.toLowerCase();
      if (!owned.has(k)) owned.set(k, { repo: r, token: t });
    }
  }

  const canonical = tracked.map((f) => owned.get(f.toLowerCase())?.repo.full_name ?? f);
  const missing = tracked.filter((f) => !owned.has(f.toLowerCase()));
  if (canonical.some((c, i) => c !== tracked[i])) {
    await client.query(`UPDATE costscale.settings SET value = $1 WHERE key = 'board_tracked'`, [
      JSON.stringify(canonical),
    ]);
  }

  let synced = 0;
  for (const full of canonical.filter((f) => owned.has(f.toLowerCase()))) {
    const { repo, token } = owned.get(full.toLowerCase())!;
    const [sj, act] = await Promise.all([statusFile(token, full), lastCodeActivity(token, full)]);
    await client.query(
      `INSERT INTO costscale.board_github
         (repo, name, description, html_url, repo_created, repo_pushed, status_json, last_activity, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (repo) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, html_url=EXCLUDED.html_url,
         repo_created=EXCLUDED.repo_created, repo_pushed=EXCLUDED.repo_pushed,
         status_json=EXCLUDED.status_json, last_activity=EXCLUDED.last_activity, synced_at=now()`,
      [
        full,
        repo.name,
        repo.description ?? "",
        repo.html_url ?? "",
        repo.created_at ? repo.created_at.slice(0, 10) : null,
        repo.pushed_at ?? null,
        sj !== null ? JSON.stringify(sj) : null,
        act,
      ]
    );
    synced += 1;
  }

  // 取消追蹤的 repo 要從快取移除，否則看板會一直顯示已經不追的專案。
  await client.query(`DELETE FROM costscale.board_github WHERE NOT (repo = ANY($1))`, [canonical]);
  return { synced, tracked: tracked.length, missing };
}

/** 設定頁的 repo 清單（含目前是否追蹤）。 */
export async function listAllRepos(): Promise<{ full: string; name: string; tracked: boolean }[]> {
  const tokens = githubTokens();
  if (!tokens.length) return [];
  const client = getPool();
  const { rows } = await client.query(`SELECT value FROM costscale.settings WHERE key = 'board_tracked'`);
  const tracked = new Set<string>(rows[0] ? JSON.parse(rows[0].value) : []);
  const seen = new Map<string, GhRepo>();
  for (const t of tokens) {
    for (const r of await listRepos(t)) if (!seen.has(r.full_name)) seen.set(r.full_name, r);
  }
  return [...seen.values()]
    .map((r) => ({ full: r.full_name, name: r.name, tracked: tracked.has(r.full_name) }))
    .sort((a, b) => a.full.localeCompare(b.full));
}

/**
 * 把編輯後的內容寫回 GitHub 的 doc/status.json。
 * 寫完清掉該 repo 的 override——編輯過後 status.json 就是狀態依據，
 * 留著舊的「標記完成」覆寫會讓畫面顯示與檔案內容不一致（App Hub 同樣做法）。
 */
export async function writeStatusJson(repoFull: string, data: Record<string, unknown>): Promise<void> {
  const slash = repoFull.indexOf("/");
  if (slash < 0) throw new Error("id 不是 owner/repo 形式");
  const owner = repoFull.slice(0, slash);
  const token = await resolveToken(owner);
  if (!token) throw new Error("找不到可存取此 repo 的權杖");

  const url = `${GH_API}/repos/${repoFull}/contents/doc/status.json`;
  const cur = await ghJson<{ sha?: string }>(token, url);
  const body = {
    message: "更新 doc/status.json（由進度看板編輯）",
    content: Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64"),
    ...(cur?.sha ? { sha: cur.sha } : {}),
  };
  const put = await fetch(url, { method: "PUT", headers: { ...ghHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!put.ok) {
    let msg = String(put.status);
    try {
      msg = ((await put.json()) as { message?: string }).message || msg;
    } catch {}
    throw new Error("GitHub 寫入失敗：" + msg);
  }

  const client = getPool();
  await client.query(`DELETE FROM costscale.board_overrides WHERE repo = $1`, [repoFull]);
}

/** 最後一次 commit 日期，標記完成時當結束日用（不是按下的今天）。 */
export async function lastCommitDate(repoFull: string): Promise<string | null> {
  const owner = repoFull.slice(0, repoFull.indexOf("/"));
  const token = await resolveToken(owner);
  if (!token) return null;
  const arr = await ghJson<{ commit?: { committer?: { date?: string }; author?: { date?: string } } }[]>(
    token,
    `${GH_API}/repos/${repoFull}/commits?per_page=1`
  );
  const d = arr?.[0]?.commit?.committer?.date || arr?.[0]?.commit?.author?.date;
  return d ? d.slice(0, 10) : null;
}

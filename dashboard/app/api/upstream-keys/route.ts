import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

/**
 * 新增／移除上游金鑰（2026-09-07 新增，2026-09-09 補移除）。
 *
 * **這裡不會改任何設定檔，也不會重啟任何東西。**
 * 它只做兩件事：先向供應商驗證那把金鑰是活的，然後把一份「待套用」請求
 * 寫進 spool 目錄。真正去改 `.env`、改 `litellm-config.yaml`、重啟閘道、
 * 失敗回滾的是主機端的 `scripts/apply-upstream-key.py`，cron 每分鐘跑一次。
 *
 * 為什麼要拆成兩段：要讓這個網頁應用自己改檔案並重啟容器，最直接的做法是
 * 把 docker socket 掛進來——**那等於讓一個對外的網頁應用可以控制整台機器上
 * 所有容器**，為了一個「新增金鑰」的功能付這個代價不成比例。
 *
 * **送出前一定要先驗金鑰。** 不驗的話，貼錯的金鑰會一路寫進 .env、
 * 觸發閘道重啟、然後整組輪替金鑰裡多一把永遠 401 的——而 LiteLLM 的
 * 輪替不會因為某一把壞掉就跳過它，那會變成間歇性失敗，最難查的那種。
 */

const SPOOL = process.env.UPSTREAM_KEY_SPOOL || "/app/spool/upstream-keys";

/** 這一版只開這五家。其餘的等「新增模型」那個功能一起做。 */
const PROVIDERS: Record<
  string,
  { label: string; verify: (key: string) => Promise<{ ok: boolean; detail: string }> }
> = {
  gemini: {
    label: "Google AI Studio（Gemini）",
    verify: (key) =>
      probe("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": key },
      }),
  },
  openai: {
    label: "OpenAI",
    verify: (key) =>
      probe("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  anthropic: {
    label: "Anthropic（Claude）",
    verify: (key) =>
      probe("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      }),
  },
  groq: {
    label: "Groq",
    verify: (key) =>
      probe("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  openrouter: {
    label: "OpenRouter",
    verify: (key) =>
      probe("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
};

/**
 * 打一個「列模型」之類的便宜端點驗金鑰。
 *
 * 只認 200 為通過。401／403 是金鑰不對，要明講；
 * 其他狀態（429、5xx、連不上）**不能當成金鑰壞掉**——那是上游或網路的問題，
 * 把它說成「金鑰無效」會讓人去換一把好好的金鑰。
 */
/**
 * **不能只看狀態碼。** 2026-09-07 實測：Google 對無效金鑰回的是
 * `HTTP 400 · "API key not valid. Please pass a valid API key."`，
 * 不是 401 也不是 403。只看狀態碼的話會回「這不一定是金鑰的問題，稍後再試」——
 * 把「你貼錯金鑰」說成「上游可能有事」，人就會去查錯的方向。
 * （這正是某個付費專案把首字逾時標成「閘道不通」的同一種錯，第八十四節。）
 */
const KEY_INVALID = /api[_ ]?key not valid|invalid[_ ]api[_ ]key|api_key_invalid|incorrect api key|invalid x-api-key|no auth credentials/i;

async function probe(url: string, init: RequestInit): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403 || KEY_INVALID.test(body)) {
      return { ok: false, detail: `供應商說這把金鑰無效（HTTP ${res.status}）` };
    }
    return {
      ok: false,
      detail: `上游回 HTTP ${res.status}，這不一定是金鑰的問題，稍後再試一次`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `連不到上游：${msg.slice(0, 80)}——這不是金鑰的問題` };
  }
}

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** GET：回最近的套用結果，讓畫面顯示「套用中／成功／失敗」。 */
export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;
  try {
    await mkdir(SPOOL, { recursive: true });
    const names = await readdir(SPOOL);
    const pending = names.filter((n) => n.endsWith(".json") && !n.endsWith(".status.json"));
    const statuses = [];
    for (const n of names.filter((x) => x.endsWith(".status.json")).slice(-20)) {
      try {
        statuses.push(JSON.parse(await readFile(path.join(SPOOL, n), "utf8")));
      } catch {
        // 壞掉的狀態檔略過就好，不要讓整頁掛掉
      }
    }
    statuses.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    return NextResponse.json({ pending: pending.length, statuses: statuses.slice(0, 10) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  // ── 換部署後端：走同一條 spool（2026-09-21）────────────────────
  // User：「裡面的模型要到期了，但我沒有看到可以更換的地方」。
  // 在這之前，要把某個部署改成打另一支模型只能 ssh 進去改 litellm-config.yaml。
  //
  // 這裡只寫請求檔，實際的文字替換、重啟、驗證、失敗回滾都在主機端腳本，
  // 理由與新增金鑰完全相同：對外的網頁應用不該拿到 docker 或設定檔的寫入權。
  if (str(body.op, 20) === "retarget") {
    const modelName = str(body.modelName, 80);
    const backendModel = str(body.backendModel, 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(modelName) || modelName.includes("*")) {
      return NextResponse.json({ error: `部署名不合法：${modelName}` }, { status: 400 });
    }
    if (!/^[a-z][a-z0-9_]*\/[A-Za-z0-9._\-/:]+$/.test(backendModel) || backendModel.includes("*")) {
      return NextResponse.json(
        { error: `新的後端模型要寫成「供應商/型號」，例如 vertex_ai/gemini-3.8-flash` },
        { status: 400 }
      );
    }
    const id = randomUUID();
    try {
      await mkdir(SPOOL, { recursive: true });
      const tmp = path.join(SPOOL, `${id}.json.tmp`);
      await writeFile(
        tmp,
        JSON.stringify({ id, op: "retarget", modelName, backendModel, createdAt: new Date().toISOString() }),
        { encoding: "utf8", mode: 0o600 }
      );
      await rename(tmp, path.join(SPOOL, `${id}.json`));
    } catch (e) {
      return NextResponse.json(
        { error: `寫入待套用佇列失敗：${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      id,
      message:
        `已排入佇列：把 ${modelName} 改成打 ${backendModel}。` +
        "主機端每分鐘處理一次，套用時閘道會重啟數秒；" +
        "套用後會實際去問閘道有沒有生效，沒生效或起不來會自動回滾。結果看上面的套用紀錄。",
    });
  }

  // ── 移除：走同一條 spool，但不需要 provider 也不需要金鑰 ──────────
  // （2026-09-09 補。原本只有新增，User 回報「網頁沒有設計介面讓我停用或刪除」。）
  if (str(body.op, 20) === "remove") {
    const envVar = str(body.envVar, 60).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(envVar)) {
      return NextResponse.json({ error: `環境變數名不合法：${envVar}` }, { status: 400 });
    }
    const id = randomUUID();
    try {
      await mkdir(SPOOL, { recursive: true });
      const tmp = path.join(SPOOL, `${id}.json.tmp`);
      await writeFile(tmp, JSON.stringify({ id, op: "remove", envVar, createdAt: new Date().toISOString() }), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, path.join(SPOOL, `${id}.json`));
    } catch (e) {
      return NextResponse.json(
        { error: `寫入待套用佇列失敗：${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      id,
      message: `已排入移除佇列（${envVar}）。主機端每分鐘處理一次，套用時閘道會重啟數秒。結果會出現在上面的套用紀錄。`,
    });
  }

  const provider = str(body.provider, 40);
  const modelName = str(body.modelName, 80);
  const envVar = str(body.envVar, 60).toUpperCase();
  const backendModel = str(body.backendModel, 120);
  const key = str(body.key, 400);
  const rpm = Number(body.rpm) || 0;
  const pricingType = str(body.pricingType, 20) || "unknown";

  const p = PROVIDERS[provider];
  if (!p) {
    return NextResponse.json(
      { error: `這一版只支援：${Object.keys(PROVIDERS).join("、")}` },
      { status: 400 }
    );
  }
  if (!modelName || !backendModel) {
    return NextResponse.json({ error: "要指定加進哪個模型組、以及上游模型名" }, { status: 400 });
  }
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(envVar)) {
    return NextResponse.json(
      { error: "環境變數名只能用大寫英數與底線，開頭是字母，長度 3 到 61" },
      { status: 400 }
    );
  }
  if (!key) return NextResponse.json({ error: "金鑰是空的" }, { status: 400 });
  // 角括號的坑（2026-09-03 踩過）：說明裡的佔位符連符號一起被貼進來，
  // 送出去只會回 401，而訊息看不出是這個原因。這裡直接擋。
  if (/^[<"']/.test(key) || /[>"']$/.test(key)) {
    return NextResponse.json(
      { error: "金鑰前後有角括號或引號。只貼值本身，不要連符號一起貼。" },
      { status: 400 }
    );
  }

  // ── 先驗金鑰，驗不過就不寫 ──────────────────────────────────────
  const v = await p.verify(key);
  if (!v.ok) {
    return NextResponse.json({ error: `金鑰沒有通過驗證：${v.detail}` }, { status: 400 });
  }

  // ── 寫待套用請求 ────────────────────────────────────────────────
  const id = randomUUID();
  const payload = {
    id,
    provider,
    modelName,
    envVar,
    backendModel,
    key,
    rpm: rpm > 0 ? rpm : undefined,
    pricingType,
    createdAt: new Date().toISOString(),
  };
  try {
    await mkdir(SPOOL, { recursive: true });
    // 先寫 .tmp 再改名：主機端的 cron 每分鐘掃一次，
    // 不這樣做的話它可能讀到只寫了一半的檔。
    const tmp = path.join(SPOOL, `${id}.json.tmp`);
    const dst = path.join(SPOOL, `${id}.json`);
    await writeFile(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, dst);
  } catch (e) {
    return NextResponse.json(
      { error: `寫入待套用佇列失敗：${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    id,
    message: `金鑰已驗證通過（${v.detail}），已排入套用佇列。主機端每分鐘處理一次，套用時閘道會重啟數秒。`,
  });
}

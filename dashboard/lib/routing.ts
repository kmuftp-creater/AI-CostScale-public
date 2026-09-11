/**
 * 路由順位與橋接狀態的資料來源。
 *
 * 兩邊都是「現場問」而不是讀設定檔的副本：
 *   - 橋接：直接打 http://10.87.213.1:8788/health（VPS 打回家用主機的反向隧道）
 *   - 閘道：打 LiteLLM 的 /model/info，拿到的是實際載入的部署，不是 yaml 的字面
 * 讀設定檔的副本會漂移——2026-08-23 那次 83 分鐘中斷就是因為沒有任何地方
 * 看得到隧道的真實死活。
 */

const BRIDGE_URL = process.env.BRIDGE_HEALTH_URL || "http://10.87.213.1:8788/health";
// 沿用 compose 已經傳進來的 LITELLM_BASE_URL，不要另外發明一個環境變數名。
const LITELLM_URL = process.env.LITELLM_BASE_URL || "http://litellm:4000";

export type BridgeProvider = {
  name: string;
  cli: string;
  rpmLimit: number | null;
  recentMinute: number | null;
  endpoints: string[];
};

export type BridgeStatus = {
  reachable: boolean;
  error: string | null;
  running: number | null;
  queued: number | null;
  providers: BridgeProvider[];
  checkedAt: Date;
};

export async function getBridgeStatus(): Promise<BridgeStatus> {
  const checkedAt = new Date();
  try {
    const ctl = AbortSignal.timeout(6000);
    const r = await fetch(BRIDGE_URL, { cache: "no-store", signal: ctl });
    if (!r.ok) {
      return { reachable: false, error: `橋接回 HTTP ${r.status}`, running: null, queued: null, providers: [], checkedAt };
    }
    const j = (await r.json()) as Record<string, unknown>;
    const raw = (j.providers ?? {}) as Record<string, Record<string, unknown>>;
    const providers: BridgeProvider[] = Object.entries(raw).map(([name, v]) => ({
      name,
      cli: typeof v.cli === "string" ? v.cli : "",
      rpmLimit: typeof v.rpmLimit === "number" ? v.rpmLimit : null,
      recentMinute: typeof v.recentMinute === "number" ? v.recentMinute : null,
      endpoints: Array.isArray(v.endpoints) ? v.endpoints.map(String) : [],
    }));
    return {
      reachable: j.ok === true,
      error: j.ok === true ? null : "橋接回報自身不健康",
      running: typeof j.running === "number" ? j.running : null,
      queued: typeof j.queued === "number" ? j.queued : null,
      providers,
      checkedAt,
    };
  } catch (err) {
    // 逾時與連線被拒都走這裡。訊息要留著——「不通」兩個字看不出是哪一種。
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: msg, running: null, queued: null, providers: [], checkedAt };
  }
}

export type ModelGroup = {
  name: string;
  deployments: number;
  providers: string[];
  /** 走橋接的訂閱模型，隧道斷掉時這些會全部不可用。 */
  viaBridge: boolean;
  /** 直接掛在通用萬用字元底下的（openrouter/*、vertex_ai/*），不是本專案逐一列的。 */
  passthrough: boolean;
};

export type RoutingInfo = {
  ok: boolean;
  error: string | null;
  strategy: string;
  groups: ModelGroup[];
  totalDeployments: number;
};

/**
 * 從 litellm_params 猜供應商。model 字串的前綴就是 LiteLLM 自己的分類法。
 *
 * **`api_base` 的判斷一定要排在前綴比對之前。** 訂閱橋接那四條在設定檔裡
 * 寫的是 `model: openai/sub-claude`（LiteLLM 只認得 OpenAI 相容格式，
 * 前綴是講「用哪套協定」不是「打到誰」），所以只要先比前綴，
 * `sub-claude`、`sub-codex`、`sub-gemini`、`sub-imagegen` 全部會被標成
 * 「OpenAI」，而底下那行「訂閱橋接」永遠走不到——2026-08-26 起這段就是死碼，
 * 8/28 撈頁面實際渲染結果時才發現。它們打的是本機 CLI，跟 OpenAI 沒有關係。
 */
function providerOf(p: Record<string, unknown>): string {
  const m = typeof p.model === "string" ? p.model : "";
  if (typeof p.api_base === "string" && p.api_base.includes("8788")) return "訂閱橋接";
  if (m.startsWith("vertex_ai/")) return "Vertex AI";
  if (m.startsWith("gemini/")) return "AI Studio";
  if (m.startsWith("openrouter/")) return "OpenRouter";
  if (m.startsWith("groq/")) return "Groq";
  if (m.startsWith("anthropic/")) return "Anthropic";
  if (m.startsWith("openai/")) return "OpenAI";
  if (m.startsWith("xai/")) return "xAI";
  if (m.startsWith("deepseek/")) return "DeepSeek";
  return m.split("/")[0] || "其他";
}

export async function getRoutingInfo(): Promise<RoutingInfo> {
  const key = process.env.LITELLM_MASTER_KEY || "";
  if (!key) {
    return { ok: false, error: "伺服器未設定 LITELLM_MASTER_KEY", strategy: "", groups: [], totalDeployments: 0 };
  }
  try {
    const r = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      return { ok: false, error: `閘道回 HTTP ${r.status}`, strategy: "", groups: [], totalDeployments: 0 };
    }
    const j = (await r.json()) as { data?: unknown[] };
    const items = Array.isArray(j.data) ? j.data : [];
    const byName = new Map<string, { providers: Set<string>; n: number }>();
    for (const it of items) {
      const o = it as Record<string, unknown>;
      const name = typeof o.model_name === "string" ? o.model_name : "";
      if (!name) continue;
      const params = (o.litellm_params ?? {}) as Record<string, unknown>;
      const cur = byName.get(name) ?? { providers: new Set<string>(), n: 0 };
      cur.n += 1;
      cur.providers.add(providerOf(params));
      byName.set(name, cur);
    }
    const groups: ModelGroup[] = [...byName.entries()]
      .map(([name, v]) => ({
        name,
        deployments: v.n,
        providers: [...v.providers].sort(),
        viaBridge: name.startsWith("sub-"),
        passthrough: name.includes("/"),
      }))
      // 多把金鑰輪替的排前面——那才是「順位」有意義的地方。
      .sort((a, b) => b.deployments - a.deployments || a.name.localeCompare(b.name));
    return {
      ok: true,
      error: null,
      strategy: "simple-shuffle",
      groups,
      totalDeployments: items.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, strategy: "", groups: [], totalDeployments: 0 };
  }
}

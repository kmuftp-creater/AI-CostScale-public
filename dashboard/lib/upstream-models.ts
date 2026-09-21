/**
 * 「這把上游金鑰實際能用哪些模型」（2026-09-21）。
 *
 * 起因（User）：「有的模型會過時，就像 gemini 2.5 系列的即將要全部停用了，我要避免用到，
 * 所以他們可以載入模型去看」。
 *
 * 為什麼資料要繞一圈：儀表板**刻意沒有掛 .env**，容器裡一把上游金鑰都沒有
 * （2026-09-21 實測 `env | grep -c GEMINI_FREE_KEY` 是 0），所以它自己問不到供應商。
 * 沿用 `_tails.json` 的分工：主機端 cron 跑 `scripts/fetch-upstream-models.py` 讀 .env、
 * 去問各供應商，只把**模型名稱**寫進 spool；這裡只負責讀檔與比對。
 * 金鑰值一個位元組都不會進到這個行程。
 *
 * 比對要回答兩個問題：
 *   1. 閘道設定用到的模型，供應商清單裡還在不在——不在就是已下架或即將停用，要換掉。
 *   2. 供應商有、但閘道還沒開的，有哪些——那是可以新增的。
 *
 * 「即將停用」的資料從哪來（2026-09-21 逐家實測）：只有 OpenRouter 會直說到期日；
 * Vertex 只給 GA／預覽／實驗，Groq 只給 active，Gemini API 什麼都不給。
 * 所以抓取腳本會拿 OpenRouter 的日期去對同名模型當**交叉參考**，
 * 介面必須照實寫是誰宣告的（expiresFrom），不能講得像原廠公告。
 */
import { readFile } from "node:fs/promises";

const MODELS_PATH = process.env.UPSTREAM_KEY_SPOOL
  ? `${process.env.UPSTREAM_KEY_SPOOL}/_models.json`
  : "/app/spool/upstream-keys/_models.json";

/** 服務帳戶那一列在金鑰盤點裡的名字，與抓取腳本用的鍵值不同，要對映。 */
const SERVICE_ACCOUNT_ALIAS: Record<string, string> = {
  GOOGLE_APPLICATION_CREDENTIALS: "VERTEX_SERVICE_ACCOUNT",
};

export type UpstreamModelEntry = {
  provider: string;
  ok: boolean;
  count: number;
  models: string[];
  /** 供應商回的錯誤。金鑰失效時這裡會有值——那是要立刻處理的事。 */
  error: string | null;
};

/** 一個模型的公開中繼資料。由抓取腳本算好，這裡只負責顯示。 */
export type ModelMeta = {
  id: string;
  /** 供應商給的好讀名稱，可能是空字串。 */
  label: string;
  /** 主分類：文字／生圖／語音／影片／嵌入／音樂／其他。 */
  group: string;
  /** 能力標籤：看圖、聽語音、讀影片、思考。 */
  tags: string[];
  /** ga／preview／experimental／inactive；空字串＝供應商沒說。 */
  stage: string;
  /** 供應商宣告的到期日 YYYY-MM-DD；空字串＝沒有人說過。 */
  expires: string;
  /** 這個日期是誰說的。空＝該供應商自己說的；openrouter＝拿同名模型交叉參考來的。 */
  expiresFrom: string;
};

export type ProviderCatalog = {
  count: number;
  models: string[];
  meta?: Record<string, ModelMeta>;
};

export type UpstreamModels = {
  fetchedAt: Date | null;
  keys: Record<string, UpstreamModelEntry>;
  providers: Record<string, ProviderCatalog>;
  /** 讀不到檔案時的原因。null＝讀到了。 */
  error: string | null;
};

/** 分類在畫面上的固定順序。使用者不一定知道自己要什麼，先給最常用的。 */
export const GROUP_ORDER = ["文字", "生圖", "語音", "影片", "嵌入", "音樂", "其他"];

export const STAGE_LABEL: Record<string, string> = {
  preview: "預覽版",
  experimental: "實驗版",
  inactive: "已停用",
};

export const EMPTY_UPSTREAM_MODELS: UpstreamModels = {
  fetchedAt: null,
  keys: {},
  providers: {},
  error: "還沒有抓過（主機端排程每 6 小時跑一次）",
};

export async function readUpstreamModels(): Promise<UpstreamModels> {
  try {
    const raw = await readFile(MODELS_PATH, "utf8");
    const d = JSON.parse(raw) as {
      fetchedAt?: string;
      keys?: Record<string, UpstreamModelEntry>;
      providers?: Record<string, ProviderCatalog>;
    };
    return {
      fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : null,
      keys: d.keys ?? {},
      providers: d.providers ?? {},
      error: null,
    };
  } catch (err) {
    // 讀不到不讓整頁掛掉：這一格是輔助資訊，不是頁面的主資料。
    return {
      ...EMPTY_UPSTREAM_MODELS,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 某一把金鑰（或服務帳戶）對應的供應商清單。沒有就回 null。 */
export function catalogFor(data: UpstreamModels, envName: string): UpstreamModelEntry | null {
  return data.keys[SERVICE_ACCOUNT_ALIAS[envName] ?? envName] ?? null;
}

/**
 * 把閘道設定裡的後端模型名，換成供應商清單裡的寫法。
 *   vertex_ai/gemini-3.1-flash-lite → gemini-3.1-flash-lite
 *   gemini/gemini-2.5-flash         → gemini-2.5-flash
 *   groq/openai/gpt-oss-120b        → openai/gpt-oss-120b（Groq 的 id 本來就帶 openai/ 前綴）
 */
export function catalogId(backendModel: string): string {
  const i = backendModel.indexOf("/");
  return i < 0 ? backendModel : backendModel.slice(i + 1);
}

export type ModelCheck = {
  modelName: string;
  backendModel: string;
  /** true＝供應商清單裡還有；false＝已經沒有（可能下架）；null＝無法判斷（萬用樣式或沒抓到清單）。 */
  present: boolean | null;
  /** 供應商清單裡那一筆的中繼資料。present 不是 true 時是 null。 */
  meta: ModelMeta | null;
};

/** 逐一檢查這把金鑰的部署，在供應商清單裡還在不在。 */
export function checkDeployments(
  data: UpstreamModels,
  catalog: UpstreamModelEntry | null,
  deployments: { modelName: string; backendModel: string }[]
): ModelCheck[] {
  const seen = new Set<string>();
  const out: ModelCheck[] = [];
  for (const d of deployments) {
    if (seen.has(d.backendModel)) continue;
    seen.add(d.backendModel);
    let present: boolean | null = null;
    let meta: ModelMeta | null = null;
    if (d.backendModel.includes("*")) {
      present = null; // 萬用部署不是具體型號，比對沒有意義
    } else if (catalog?.ok) {
      const id = catalogId(d.backendModel);
      present = catalog.models.includes(id) || catalog.models.includes(d.backendModel);
      if (present) meta = metaOf(data, catalog, id) ?? metaOf(data, catalog, d.backendModel);
    }
    out.push({ modelName: d.modelName, backendModel: d.backendModel, present, meta });
  }
  return out;
}

/** 供應商型錄裡那一筆的中繼資料。抓取腳本還是舊版（沒有 meta）時回 null。 */
export function metaOf(
  data: UpstreamModels,
  catalog: UpstreamModelEntry | null,
  id: string
): ModelMeta | null {
  if (!catalog) return null;
  return data.providers[catalog.provider]?.meta?.[id] ?? null;
}

export type ModelGroup = { group: string; items: ModelMeta[] };

/**
 * 把一堆模型 id 依分類分組（User：「使用者不一定清楚該用什麼模型」）。
 * 沒有中繼資料的（舊版抓取腳本寫的檔）全部歸到「其他」，不是憑空猜。
 */
export function groupModels(
  data: UpstreamModels,
  catalog: UpstreamModelEntry | null,
  ids: string[]
): ModelGroup[] {
  const buckets = new Map<string, ModelMeta[]>();
  for (const id of ids) {
    const m = metaOf(data, catalog, id);
    const g = m?.group ?? "其他";
    const item: ModelMeta =
      m ?? { id, label: "", group: "其他", tags: [], stage: "", expires: "", expiresFrom: "" };
    const arr = buckets.get(g);
    if (arr) arr.push(item);
    else buckets.set(g, [item]);
  }
  const order = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return [...buckets.entries()]
    .map(([group, items]) => ({ group, items: items.sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => order(a.group) - order(b.group));
}

/** 這個日期算不算「快到期」。預設 120 天內。 */
export function isExpiringSoon(expires: string, days = 120): boolean {
  if (!expires) return false;
  const t = Date.parse(expires + "T00:00:00Z");
  if (Number.isNaN(t)) return false;
  return t - Date.now() < days * 86400000;
}

/** 到期日寫成一句人話。要講清楚是誰宣告的——交叉參考不是原廠公告。 */
export function expiryText(m: ModelMeta): string {
  if (!m.expires) return "";
  const who = m.expiresFrom === "openrouter" ? "OpenRouter 宣告" : "供應商宣告";
  return `${who} ${m.expires} 停用`;
}

/** 供應商有、但閘道這把金鑰沒有用到的模型。用來回答「還可以加什麼」。 */
export function unusedModels(
  catalog: UpstreamModelEntry | null,
  deployments: { backendModel: string }[]
): string[] {
  if (!catalog?.ok) return [];
  const used = new Set(deployments.map((d) => catalogId(d.backendModel)));
  return catalog.models.filter((m) => !used.has(m));
}

/**
 * LiteLLM 管理 API 的最小封裝。呼叫方必須自行 catch LiteLlmError 並轉成
 * HTTP 503——本機開發環境下 LiteLLM 容器很可能沒啟動或連不到，任何一個
 * 呼叫這支模組的 API 路由都不能因此整個 route handler 丟未捕捉例外。
 */

export class LiteLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteLlmError";
  }
}

function baseUrl(): string {
  return process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
}

function masterKey(): string {
  return process.env.LITELLM_MASTER_KEY ?? "";
}

async function callLiteLlm<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterKey()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new LiteLlmError(
      `連不到 LiteLLM 閘道（${baseUrl()}）：${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new LiteLlmError(`LiteLLM 回應非 2xx（${res.status}）：${detail.slice(0, 300)}`);
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new LiteLlmError(`LiteLLM 回應非合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET 版本。/model/info 之類的查詢端點不吃 POST。 */
async function getLiteLlm<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${masterKey()}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new LiteLlmError(
      `連不到 LiteLLM 閘道（${baseUrl()}）：${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new LiteLlmError(`LiteLLM 回應非 2xx（${res.status}）：${detail.slice(0, 300)}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new LiteLlmError(
      `LiteLLM 回應非合法 JSON：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export type GenerateKeyResult = {
  key: string;
  token?: string;
  key_name?: string;
  [key: string]: unknown;
};

/** 呼叫 POST /key/generate，簽發一把虛擬金鑰。 */
export async function generateVirtualKey(params: {
  keyAlias: string;
  metadata?: Record<string, unknown>;
}): Promise<GenerateKeyResult> {
  return callLiteLlm<GenerateKeyResult>("/key/generate", {
    key_alias: params.keyAlias,
    metadata: params.metadata ?? {},
  });
}

/**
 * 改一把虛擬金鑰的別名。
 *
 * 重新簽發時用來讓出正式別名——**LiteLLM 要求別名全站唯一**，
 * 舊金鑰不先改名的話，同名的新金鑰會被回 400（2026-08-26 實測）。
 */
export async function renameVirtualKey(key: string, keyAlias: string): Promise<void> {
  await callLiteLlm("/key/update", { key, key_alias: keyAlias });
}

/**
 * 閘道上實際存在的部署名（`model_name`），去重後排序。
 *
 * 用途是把金鑰白名單從萬用樣式換成明確清單。**LiteLLM 的 /v1/models
 * 是原樣回傳白名單**，樣式進去就是樣式出來——專案後台的「讀取可用模型」
 * 因此會拿到 `groq-*` 這種打不到的東西（實測回 400 no healthy deployments），
 * 而真正能用的名字一個都不在裡面。
 *
 * 排除 `sub-*`：那是訂閱通道，要在「應用程式」頁逐一授權，
 * 不能因為換個做法就整批開放。
 * 排除含 `*` 的：那本身就是萬用部署，列進白名單等於沒改。
 */
export async function listGatewayModelNames(): Promise<string[]> {
  const data = await getLiteLlm<{ data?: Array<Record<string, unknown>> }>(
    "/model/info"
  );
  const rows = Array.isArray(data) ? data : (data?.data ?? []);
  const names = new Set<string>();
  for (const m of rows) {
    const name = typeof m?.model_name === "string" ? m.model_name : "";
    // 排除三種：訂閱通道（要逐一授權）、萬用部署（列進白名單等於沒改）、
    // 以及帶供應商前綴的展開結果。最後這種是關鍵：/model/info 會把
    // `gemini-*` 這個萬用部署展開成整套 Vertex 型錄（148 筆裡有 136 筆是這種），
    // 那些不是設定檔裡的部署名，列進白名單只是把雜訊換個地方（2026-08-26 實測）。
    if (!name || name.startsWith("sub-") || name.includes("*") || name.includes("/")) continue;
    names.add(name);
  }
  return [...names].sort();
}

/** 呼叫 POST /key/delete，撤銷一把虛擬金鑰（封存軟體時用）。 */
export async function deleteVirtualKey(keys: string[]): Promise<void> {
  await callLiteLlm("/key/delete", { keys });
}

/**
 * 把某把虛擬金鑰的模型白名單設成「所有非訂閱模型 ＋ 指定的訂閱模型」。
 *
 * 為什麼要連非訂閱模型一起列：LiteLLM 只有允許清單、沒有拒絕清單。
 * 要擋掉訂閱模型就必須把其餘全部寫出來，否則設了白名單反而會把
 * 專案原本在用的模型一起擋掉——那是會弄壞正式流量的。
 *
 * **2026-08-26 從萬用樣式改成明確部署名。** 原本寫 `gemini-*`、`groq-*`
 * 這類樣式，理由是「日後新增模型時沒重新同步的軟體不會突然打不通」。
 * 但 LiteLLM 的 /v1/models 是原樣回傳白名單，於是每個專案後台的
 * 「讀取可用模型」拿到的是一堆打不到的樣式與展開的 Vertex 型錄，
 * 真正能用的名字一個都沒有——那個代價比原本要避免的大。
 *
 * 而且改成明確清單**不會弄壞任何現在能用的東西**：既有模型照樣在清單裡，
 * 只是閘道新增模型時要按一次「重新同步」才會開放給既有軟體。
 */
export async function setKeyAllowedModels(params: {
  key: string;
  nonSubPatterns: string[];
  subModels: string[];
}): Promise<void> {
  await callLiteLlm("/key/update", {
    key: params.key,
    models: [...params.nonSubPatterns, ...params.subModels],
  });
}

/**
 * 設定或解除一把虛擬金鑰的每月硬上限（2026-09-10）。
 *
 * 超過 `max_budget` 時閘道**直接拒絕、不轉發給供應商**——執行的是 LiteLLM，
 * 不是這個儀表板。`budget_duration: "1mo"` 讓它每個月初歸零
 * （LiteLLM 1.97 的 `duration_in_seconds` 對 `mo` 算的是「到下個月初」）。
 *
 * 傳 null 就是解除：兩個欄位一起清掉，不留「有上限但不歸零」的半套狀態。
 */
export async function setKeyMonthlyBudget(params: {
  key: string;
  maxBudgetUsd: number | null;
}): Promise<void> {
  await callLiteLlm(
    "/key/update",
    params.maxBudgetUsd == null
      ? { key: params.key, max_budget: null, budget_duration: null }
      : { key: params.key, max_budget: params.maxBudgetUsd, budget_duration: "1mo" }
  );
}

/**
 * 改寫一把虛擬金鑰的累計花費計數。
 *
 * 為什麼需要：金鑰上的 `spend` 是**從建立那天起的累計**，不是本月。
 * 直接設一個每月上限，閘道拿的是累計數字去比——例如 app-c 累計已經 US$2.95，
 * 設 US$2 的月上限會讓它當場被擋，即使這個月其實才花幾毛。
 * 所以設上限時要把計數改成「本期實際花了多少」（由 SpendLogs 加總）。
 */
export async function setKeySpend(key: string, spendUsd: number): Promise<void> {
  await callLiteLlm("/key/update", { key, spend: spendUsd });
}

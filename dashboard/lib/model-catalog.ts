/**
 * 模型對照表的資料來源（2026-11-20）。
 *
 * 起因：專案端填的是我們自己取的名稱（gemini-fast、gemini-flash-paid、gemini-studio-paid…），
 * User：「管理員不一定會記著這模型到底是什麼，然後 AI CostScale 裡面的金鑰、訂閱也都看不出來」。
 * 當天實際狀況是同一支 gemini-3.8-flash 有四個名稱，差別只在走哪條通道、錢記在哪個帳號，
 * 而畫面上沒有任何一處把這件事並排列出來。
 *
 * 這裡把每個名稱整理成一列：實際模型、通道、付費帳號、計費方式、幾把金鑰、
 * 與哪些名稱其實是同一個東西、最近 7 天打不打得通。
 *
 * 全部從 litellm-config.yaml 讀，不手寫清單——手寫的會在下一次換模型時過期。
 * 名稱本身不改：各專案已經在用，改了會斷線。
 *
 * 只能在伺服器端用（會讀檔、查資料庫）。要給 client component 的話，傳 `notesOf()` 的結果。
 */
import { listConfigCatalog, providerOfModel, type PricingType } from "@/lib/keys";
import { countCallsByModelGroup, listCreditPoolProjects } from "@/lib/db";
import { kindOfDeployment, KIND_ORDER, type ModelKind } from "@/lib/model-kind";

export const PRICING_TEXT: Record<PricingType, string> = {
  free: "免費額度",
  payg: "隨用隨付",
  subscription: "訂閱",
  unknown: "未標示",
};

export type ModelCatalogRow = {
  /** 專案端要填的名稱。 */
  name: string;
  kind: ModelKind;
  /** 去掉供應商前綴的實際模型，例如 gemini-3.8-flash。 */
  backend: string;
  /** 通道，例如 Vertex AI、Google AI Studio、訂閱橋接。 */
  provider: string;
  /** 錢記在哪：Vertex 是帳號名稱（查不到就是專案 ID），其他是金鑰把數。 */
  account: string;
  pricing: PricingType;
  keyCount: number;
  isWildcard: boolean;
  /** 實際模型、通道、帳號完全相同的其他名稱。 */
  sameAs: string[];
  /** 最近 7 天經閘道的次數。null＝查不到，不是 0。 */
  calls: { ok: number; fail: number } | null;
  /** 給下拉選單用的一行說明。 */
  note: string;
};

export type ModelCatalog = {
  rows: ModelCatalogRow[];
  groups: { kind: ModelKind; rows: ModelCatalogRow[] }[];
  error: string | null;
};

function shortBackend(backendModel: string): string {
  const i = backendModel.indexOf("/");
  return i >= 0 ? backendModel.slice(i + 1) : backendModel;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const [{ entries, error }, projectLabels, calls] = await Promise.all([
    listConfigCatalog(),
    listCreditPoolProjects(),
    countCallsByModelGroup(7),
  ]);

  // 同一個名稱可以有很多筆（每把金鑰一筆），先收成一列。
  const byName = new Map<
    string,
    { backend: string; provider: string; pricing: PricingType; isWildcard: boolean; envs: Set<string>; project: string | null; n: number }
  >();
  for (const e of entries) {
    const cur = byName.get(e.modelName);
    if (cur) {
      cur.n += 1;
      if (e.envName) cur.envs.add(e.envName);
      continue;
    }
    byName.set(e.modelName, {
      backend: shortBackend(e.backendModel),
      provider: providerOfModel(e.backendModel, e.apiBase ?? undefined),
      pricing: e.pricing,
      isWildcard: e.isWildcard,
      envs: new Set(e.envName ? [e.envName] : []),
      project: e.vertexProject,
      n: 1,
    });
  }

  // 「其實是同一個東西」＝實際模型、通道、記帳專案、金鑰組合全部相同。
  const sig = (v: { backend: string; provider: string; project: string | null; envs: Set<string> }) =>
    [v.backend, v.provider, v.project ?? "", [...v.envs].sort().join(",")].join("|");
  const bySig = new Map<string, string[]>();
  for (const [name, v] of byName) {
    if (v.isWildcard) continue;
    const k = sig(v);
    const arr = bySig.get(k);
    if (arr) arr.push(name);
    else bySig.set(k, [name]);
  }

  const rows: ModelCatalogRow[] = [];
  for (const [name, v] of byName) {
    const isBridge = v.provider === "訂閱橋接";
    const account = v.project
      ? (projectLabels[v.project] ?? `專案 ${v.project}`)
      : isBridge
        ? "訂閱帳號"
        : v.envs.size > 0
          ? `${v.envs.size} 把金鑰`
          : "—";
    const sameAs = v.isWildcard ? [] : (bySig.get(sig(v)) ?? []).filter((n) => n !== name).sort();
    // 下拉選單的說明：名稱與實際模型相同時不重複寫一次。
    const parts = [
      v.backend !== name && !isBridge ? v.backend : null,
      v.project ? `${v.provider}（${projectLabels[v.project] ?? v.project}）` : v.provider,
      PRICING_TEXT[v.pricing],
    ].filter(Boolean);
    rows.push({
      name,
      kind: kindOfDeployment(name),
      backend: v.backend,
      provider: v.provider,
      account,
      pricing: v.pricing,
      keyCount: v.envs.size,
      isWildcard: v.isWildcard,
      sameAs,
      calls: calls ? (calls[name] ?? { ok: 0, fail: 0 }) : null,
      note: parts.join(" · "),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const groups = KIND_ORDER.map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind) })).filter(
    (g) => g.rows.length > 0
  );
  return { rows, groups, error };
}

/** 名稱 → 一行說明。給 client component 的下拉選單與勾選清單用。 */
export function notesOf(catalog: ModelCatalog): Record<string, string> {
  return Object.fromEntries(catalog.rows.filter((r) => !r.isWildcard).map((r) => [r.name, r.note]));
}

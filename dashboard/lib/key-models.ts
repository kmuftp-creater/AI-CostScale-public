/**
 * 「重新同步白名單」時，一把金鑰的非訂閱清單要怎麼算（2026-11-10）。
 *
 * 原本是把閘道全部模型推給每一把金鑰，於是「可用模型」手動取消的項目會被洗掉，
 * 隨用隨付的新模型也會一次開給所有軟體。現在只整理，不擴大：
 *
 * - 保留這把金鑰目前勾選的模型。新模型要到該軟體的「模型」逐一開放。
 * - 拿掉閘道上已不存在的名字（模型改名或移除後留下的）。
 * - 萬用樣式、`default` 別名、帶供應商前綴的項目原樣保留，那些不是閘道的部署名。
 * - 金鑰上完全沒有清單時才用閘道全部模型：那是簽發時白名單沒套上的補救路徑，
 *   不補的話那把金鑰是全開的，連訂閱通道都打得到。
 * - 全部名字都比對不到時不動，清空會讓這個軟體什麼都打不到。
 */

const DEFAULT_ALIAS = "default";

/**
 * 後台的勾選 → 它底下可選模型的名稱前綴（2026-11-10）。
 * 後台每個訂閱來源只有一個勾選，推送白名單時才展開成閘道上實際存在的名稱，
 * 所以之後新增模型只要改橋接表與閘道設定，這裡不用動。
 * Antigravity 的 Gemini 與 Claude／GPT 是兩個額度池，對應到兩個勾選。
 */
const SUB_VARIANT_PREFIXES: Record<string, string[]> = {
  "sub-claude": ["sub-claude-"],
  "sub-codex": ["sub-codex-"],
  "sub-gemini": ["sub-agy-gemini-"],
  "sub-agy-claude": ["sub-agy-claude-", "sub-agy-gpt-"],
};

/** 把授權的訂閱來源展開成「來源本身＋閘道上它底下的所有模型」。 */
export function expandSubModels(subs: string[], gatewaySubNames: string[]): string[] {
  const out = new Set(subs);
  for (const sub of subs) {
    for (const prefix of SUB_VARIANT_PREFIXES[sub] ?? []) {
      for (const name of gatewaySubNames) {
        if (name.startsWith(prefix)) out.add(name);
      }
    }
  }
  return [...out];
}

export function resyncNonSubModels(
  currentModels: string[],
  gatewayModels: string[],
  vertexPattern: string
): { models: string[]; removed: string[] } {
  const entries = currentModels.filter((m) => !m.startsWith("sub-") && m !== vertexPattern);
  const isDeploymentName = (m: string) => !m.includes("*") && !m.includes("/") && m !== DEFAULT_ALIAS;

  const named = entries.filter(isDeploymentName);
  const others = entries.filter((m) => !isDeploymentName(m));

  if (named.length === 0) {
    return { models: [...new Set([...gatewayModels, ...others])], removed: [] };
  }

  const kept = named.filter((m) => gatewayModels.includes(m));
  if (kept.length === 0) return { models: entries, removed: [] };

  return {
    models: [...new Set([...kept, ...others])],
    removed: named.filter((m) => !gatewayModels.includes(m)),
  };
}

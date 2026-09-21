/**
 * 閘道部署名稱的分類（2026-09-21，User：「模型是否該分類，因為有的模型是文字、有的是語音、
 * 有的是圖片、混和，都不一樣，使用者不一定清楚該用什麼模型」）。
 *
 * 跟 `lib/upstream-models.ts` 的分類不同的是：那邊分的是**供應商型錄**，有模態欄位可用；
 * 這裡分的是**我們自己取的部署名**（gemini-fast、groq-large 這種），供應商不認識這些名字，
 * 所以只能靠名字推。推不出來就歸「其他」，不要假裝知道。
 *
 * 這支刻意不 import 任何 node 模組——對話框是 client component，會一起被打包到瀏覽器。
 */

export const KIND_ORDER = ["文字", "生圖", "語音", "影片", "嵌入", "訂閱", "其他"] as const;
export type ModelKind = (typeof KIND_ORDER)[number];

/** 一句話說明這一類是幹嘛的，給不熟模型的人看。 */
export const KIND_HINT: Record<string, string> = {
  文字: "寫字、問答、寫程式。大部分專案要的是這一類",
  生圖: "產生圖片。收費方式與文字模型不同，通常貴很多",
  語音: "語音轉文字（聽寫）或文字轉語音（朗讀）",
  影片: "產生或讀影片",
  嵌入: "把文字轉成向量，做搜尋與比對用，不會回話",
  訂閱: "走訂閱帳號的通道，不照 token 計費",
  其他: "分不出來的，用之前先確認它吃什麼、吐什麼",
};

export function kindOfDeployment(name: string): ModelKind {
  const n = name.toLowerCase();
  if (n.startsWith("sub-")) return "訂閱";
  if (n.includes("embedding") || n.includes("embed")) return "嵌入";
  if (n.includes("transcribe") || n.includes("whisper") || n.includes("tts") || n.includes("live"))
    return "語音";
  if (n.includes("veo") || n.includes("video")) return "影片";
  if (n.includes("image") || n.includes("imagen")) return "生圖";
  if (n.includes("*")) return "其他"; // 萬用部署不是具體型號
  if (n.includes("guard") || n.includes("moderation") || n.includes("rerank")) return "其他";
  return "文字";
}

export type DeploymentGroup = { group: ModelKind; items: string[] };

/** 依分類分組，組內照名字排序。沒有東西的分類不會出現。 */
export function groupDeployments(names: string[]): DeploymentGroup[] {
  const buckets = new Map<ModelKind, string[]>();
  for (const n of names) {
    const k = kindOfDeployment(n);
    const arr = buckets.get(k);
    if (arr) arr.push(n);
    else buckets.set(k, [n]);
  }
  return KIND_ORDER.filter((k) => buckets.has(k)).map((k) => ({
    group: k,
    items: (buckets.get(k) as string[]).sort((a, b) => a.localeCompare(b)),
  }));
}

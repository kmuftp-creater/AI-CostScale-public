/**
 * 上手清單的狀態判斷（純函式，不碰資料庫與網路）。
 *
 * 為什麼拆成兩檔：這支只吃「已經查好的訊號」，所以可以用假資料驗證
 * 全未完成、部分完成、全完成、查詢失敗四種組合（見 scripts/test-onboarding.mjs）。
 * 真正去查資料庫與閘道的是 lib/onboarding.ts。
 *
 * 每個訊號用 Probe 包起來：查得到是 { ok: true, value }，
 * 查詢丟例外或逾時是 { ok: false, error }。ok:false 的那一步一律顯示「無法確認」，
 * 不得當成已完成，也不得當成未完成——兩種都是在對使用者說謊。
 */

export type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

export type StepId = "provider-key" | "first-app" | "first-call" | "schedule";

export type OnboardingSignals = {
  /** 非 placeholder 的上游金鑰把數、設定檔裡的上游金鑰總把數，以及閘道上第一個真的能用的模型。 */
  providerKeys: Probe<{ realCount: number; totalCount: number; model: string | null }>;
  /** 啟用中且有虛擬金鑰的軟體數。 */
  appCount: Probe<number>;
  /** 用軟體的虛擬金鑰（含換掉的舊金鑰）成功打進閘道的請求筆數。 */
  successCalls: Probe<number>;
  /** 匯率資料表最新一筆寫入距今幾小時。null＝表是空的。 */
  fxAgeHours: Probe<number | null>;
};

export type OnboardingStep = {
  id: StepId;
  /** true＝已完成、false＝未完成、null＝無法確認。 */
  done: boolean | null;
  /** 標題，不超過 16 個字。 */
  title: string;
  /** 兩句白話：第一句說這一步是什麼，第二句說為什麼要做或做完會怎樣。 */
  desc: string;
  /** 依狀態變動的補充說明（偵測到什麼、下一步按哪裡）。 */
  note: string;
  href: string;
  linkLabel: string;
};

export type OptionalItem = { id: string; title: string; desc: string; href: string; linkLabel: string };

export type OnboardingResult = {
  steps: OnboardingStep[];
  /** done === true 的步驟數。 */
  doneCount: number;
  total: number;
  /** 四步都確認完成。有任何一步是「無法確認」就不算。 */
  allDone: boolean;
  /** 還沒確認完成的步驟數（未完成 ＋ 無法確認）。 */
  remaining: number;
  curl: { url: string; model: string; command: string };
  optional: OptionalItem[];
};

export const FALLBACK_MODEL = "gemini-flash-free";
/** 匯率最新一筆的寫入時間在幾小時內，才算排程有在跑。排程每天抓一次，多留 2 小時給延遲。 */
export const FX_FRESH_HOURS = 26;
/** 範本裡未填金鑰的佔位字是 "placeholder"，尾 4 碼是 "lder"。 */
export const PLACEHOLDER_TAIL = "lder";

export const OPTIONAL_ITEMS: OptionalItem[] = [
  {
    id: "monthly-cap",
    title: "替軟體設每月上限",
    desc: "到「應用程式」頁，在軟體那一列按「每月上限」。花到上限時閘道會直接拒絕請求，帳單不會失控。",
    href: "/apps",
    linkLabel: "前往「應用程式」",
  },
  {
    id: "manual",
    title: "看一遍使用說明",
    desc: "「說明」頁用白話講每一頁在回答什麼問題、數字該怎麼讀。有疑問時先來這裡找。",
    href: "/manual",
    linkLabel: "前往「說明」",
  },
];

const UNKNOWN_NOTE =
  "目前查不到這一步的狀態（資料庫或閘道暫時沒回應），這不代表沒做。稍後重新整理再看一次。";

export function buildCurl(gatewayUrl: string, model: string): string {
  const url = gatewayUrl.replace(/\/+$/, "");
  return (
    `curl -s ${url}/v1/chat/completions ` +
    `-H "Authorization: Bearer sk-你的虛擬金鑰" ` +
    `-H "Content-Type: application/json" ` +
    `-d '{"model":"${model}","messages":[{"role":"user","content":"用一句話自我介紹"}]}'`
  );
}

export function evaluateOnboarding(sig: OnboardingSignals, ctx: { gatewayUrl: string }): OnboardingResult {
  const pk = sig.providerKeys;
  const ac = sig.appCount;
  const sc = sig.successCalls;
  const fx = sig.fxAgeHours;

  const s1: boolean | null = pk.ok ? pk.value.realCount > 0 : null;
  const s2: boolean | null = ac.ok ? ac.value > 0 : null;
  const s3: boolean | null = sc.ok ? sc.value > 0 : null;
  const s4: boolean | null = fx.ok ? fx.value !== null && fx.value <= FX_FRESH_HOURS : null;

  const steps: OnboardingStep[] = [
    {
      id: "provider-key",
      done: s1,
      title: "放入 AI 供應商金鑰",
      desc: "把你向 Google、Groq 等 AI 供應商申請的金鑰交給閘道保管。閘道要拿這把金鑰才能替你的軟體呼叫 AI，沒有它就沒有模型可以用。",
      note:
        s1 === null
          ? UNKNOWN_NOTE
          : s1
            ? `已放入 ${pk.ok ? pk.value.realCount : 0} 把真的金鑰。`
            : "目前每個金鑰欄位都還是範本的佔位字 placeholder。到「金鑰管理」頁的「新增上游金鑰」貼上金鑰，按「驗證並排入套用」，約一分鐘後生效。",
      href: "/keys",
      linkLabel: "前往「金鑰管理」",
    },
    {
      id: "first-app",
      done: s2,
      title: "新增第一個軟體",
      desc: "替你的一個專案（軟體）發一把專屬的虛擬金鑰。之後這個專案用虛擬金鑰呼叫閘道，花費就會記在它名下。",
      note:
        s2 === null
          ? UNKNOWN_NOTE
          : s2
            ? `已有 ${ac.ok ? ac.value : 0} 個軟體。`
            : "到「應用程式」頁，在「新增軟體」填名稱後按「新增軟體」。畫面會顯示一次 sk- 開頭的金鑰，先複製起來，關掉就看不到了。",
      href: "/apps",
      linkLabel: "前往「應用程式」",
    },
    {
      id: "first-call",
      done: s3,
      title: "用虛擬金鑰打第一次呼叫",
      desc: "拿上一步的虛擬金鑰，對閘道問一個問題。有成功回答，才證明金鑰、閘道與上游供應商整條路是通的。",
      note:
        s3 === null
          ? UNKNOWN_NOTE
          : s3
            ? `閘道已記到 ${sc.ok ? sc.value : 0} 筆成功的請求。`
            : "在任何一台電腦貼上下面這段指令（把 sk-你的虛擬金鑰 換成剛才複製的金鑰）。有回答就成功，回到這頁重新整理就會打勾。",
      href: "/requests",
      linkLabel: "看「請求紀錄」",
    },
    {
      id: "schedule",
      done: s4,
      title: "確認排程有在跑",
      desc: "主機上的排程每天會更新匯率、檢查預算。排程沒跑的話，台幣金額會越來越舊，預算超標也不會有人通知。",
      note:
        s4 === null
          ? UNKNOWN_NOTE
          : s4
            ? "排程最近 26 小時內有更新資料。"
            : "超過 26 小時沒有排程寫入的紀錄。請回主機照 INSTALL.md 第 7 節設定排程，或重新執行一次安裝腳本，之後重新整理這頁。",
      href: "/subscriptions",
      linkLabel: "前往「訂閱」看匯率",
    },
  ];

  const doneCount = steps.filter((s) => s.done === true).length;
  const model = (pk.ok && pk.value.model) || FALLBACK_MODEL;
  const url = ctx.gatewayUrl.replace(/\/+$/, "");
  return {
    steps,
    doneCount,
    total: steps.length,
    allDone: doneCount === steps.length,
    remaining: steps.length - doneCount,
    curl: { url, model, command: buildCurl(url, model) },
    optional: OPTIONAL_ITEMS,
  };
}

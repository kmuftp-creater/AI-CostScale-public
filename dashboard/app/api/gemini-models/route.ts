import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 以 Gemini 原生格式回報閘道目前實際可用的模型。
 *
 * 為什麼需要這條：LiteLLM 沒有 /v1beta/models 這條路由，而各專案的後台
 * 「讀取可用模型／金鑰驗證」會打它。先前用 nginx 靜態檔擋著，但那份清單是
 * 手寫的，模型增減時不會同步，還會讓讀到的人誤判閘道的能力範圍
 * （2026-08-19 換衣間就是據此誤判閘道沒有影像模型）。改成即時查 LiteLLM。
 *
 * 這條路由刻意不擋登入：呼叫方是各專案的伺服器與 CLI，沒有瀏覽器 session。
 * 回傳內容只有模型名稱與它打到哪一支，沒有金鑰或用量，不含機密。
 *
 * 【backendModel 是 2026-09-21 加的】
 *
 * User 在 Auto Line 的模型下拉看到 `gemini-smart`、`gemini-fast`，說
 * 「不會有人知道他實際是哪個模型阿」——他是對的。閘道的 `/v1/models` 是
 * OpenAI 格式，只有 `id` 一個欄位，**沒有地方放真實模型**，所以任何讀那條的
 * 介面都只看得到部署名。
 *
 * 用途別名（gemini-fast／gemini-smart）本身要留著：那是為了「換模型時不必改專案」
 * 而存在的，今天就用它換過兩次。但別名不該是黑盒子——所以這裡多回三個欄位，
 * 讀得到的介面就能顯示「gemini-fast（現在打 gemini-3.8-flash）」。
 *
 * **既有欄位一個都沒動**（name、displayName、supportedGenerationMethods 語意不變），
 * 舊的呼叫端照常運作；不想用新欄位的就當它不存在。
 */

// 會回傳影像的模型；LiteLLM 的 /v1/models 不帶能力資訊，只能靠名稱判斷。
function supportedMethods(id: string): string[] {
  const base = ["generateContent", "streamGenerateContent", "countTokens"];
  if (/image|imagen|banana/i.test(id)) return [...base, "predict"];
  return base;
}

export async function GET() {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const masterKey = process.env.LITELLM_MASTER_KEY;

  if (!baseUrl || !masterKey) {
    return NextResponse.json(
      { error: { message: "閘道未設定（缺 LITELLM_BASE_URL 或 LITELLM_MASTER_KEY）" } },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${masterKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: { message: `閘道回應非 2xx（${res.status}）` } },
        { status: 502 }
      );
    }
    const data = (await res.json()) as { data?: { id?: string }[] };

    // 每個部署名實際打到哪一支。/v1/models 給不出這個，要另外問 /model/info。
    // 問不到就退回「沒有這一欄」，不要讓整條路由因為附加資訊而失敗——
    // 呼叫端要的主體是「有哪些模型可用」。
    const backendOf = new Map<string, string>();
    try {
      const info = await fetch(`${baseUrl}/model/info`, {
        headers: { Authorization: `Bearer ${masterKey}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      if (info.ok) {
        const j = (await info.json()) as {
          data?: { model_name?: string; litellm_params?: { model?: string } }[];
        };
        for (const m of j.data ?? []) {
          const n = m.model_name;
          const b = m.litellm_params?.model;
          if (typeof n === "string" && typeof b === "string" && !backendOf.has(n)) {
            backendOf.set(n, b);
          }
        }
      }
    } catch {
      // 附加資訊拿不到就算了，下面會少那幾個欄位。
    }

    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      // 萬用比對項（例如 gemini-*）不是可直接呼叫的模型名稱，不列出來
      .filter((id) => !id.includes("*"))
      .sort()
      .map((id) => {
        const backend = backendOf.get(id) ?? null;
        // 去掉供應商前綴給人看：vertex_ai/gemini-3.8-flash → gemini-3.8-flash。
        // 完整值留在 backendModel，需要分辨供應商的人拿得到。
        const shortName = backend ? backend.slice(backend.indexOf("/") + 1) : null;
        const isAlias = backend !== null && shortName !== id;
        return {
          name: `models/${id}`,
          displayName: id,
          supportedGenerationMethods: supportedMethods(id),
          // ── 以下為 AI CostScale 的擴充欄位（2026-09-21）──
          /** 這個名字實際打到的上游模型，含供應商前綴。問不到閘道時是 null。 */
          backendModel: backend,
          /** 給人看的一行字。介面直接拿去顯示就不會有人問「這是哪個模型」。 */
          label: isAlias ? `${id}（${shortName}）` : id,
          /** true＝這是用途別名，名字跟實際模型不同，換模型時不必改專案。 */
          isAlias,
        };
      });

    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json(
      { error: { message: `無法連線閘道：${err instanceof Error ? err.message : String(err)}` } },
      { status: 502 }
    );
  }
}

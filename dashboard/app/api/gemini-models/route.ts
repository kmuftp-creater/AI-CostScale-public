import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 以 Gemini 原生格式回報閘道目前實際可用的模型。
 *
 * 為什麼需要這條：LiteLLM 沒有 /v1beta/models 這條路由，而各專案的後台
 * 「讀取可用模型／金鑰驗證」會打它。先前用 nginx 靜態檔擋著，但那份清單是
 * 手寫的，模型增減時不會同步，還會讓讀到的人誤判閘道的能力範圍
 * （2026-08-19 某個試穿專案就是據此誤判閘道沒有影像模型）。改成即時查 LiteLLM。
 *
 * 這條路由刻意不擋登入：呼叫方是各專案的伺服器與 CLI，沒有瀏覽器 session。
 * 回傳內容只有模型名稱，沒有金鑰或用量，不含機密。
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
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      // 萬用比對項（例如 gemini-*）不是可直接呼叫的模型名稱，不列出來
      .filter((id) => !id.includes("*"))
      .sort()
      .map((id) => ({
        name: `models/${id}`,
        displayName: id,
        supportedGenerationMethods: supportedMethods(id),
      }));

    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json(
      { error: { message: `無法連線閘道：${err instanceof Error ? err.message : String(err)}` } },
      { status: 502 }
    );
  }
}

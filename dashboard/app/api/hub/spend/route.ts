import { NextRequest, NextResponse } from "next/server";
import { getSpendByProject, getFxRate } from "@/lib/db";
import { monthRange } from "@/lib/format";
import { taipeiDay } from "@/lib/range";

export const dynamic = "force-dynamic";

/**
 * 給 App Hub 看板用的唯讀花費端點（Phase 5 B 段）。
 *
 * 認證用共享 token，不用 Google session：呼叫端是 Cloudflare Functions，
 * 沒有瀏覽器 session 可用。未設定 HUB_API_TOKEN 時整支端點關閉——
 * 預設關比預設開安全，忘了設定會得到 503 而不是一個沒有保護的端點。
 *
 * 刻意設計成**由 App Hub 的 Functions 在伺服器端呼叫**，不是瀏覽器直接打：
 * 這樣 token 不會出現在前端，也就不需要開 CORS。
 * 所以這裡沒有任何 Access-Control-Allow-Origin 標頭，那是故意的。
 */
export async function GET(request: NextRequest) {
  const expected = process.env.HUB_API_TOKEN ?? "";
  if (!expected) {
    return NextResponse.json(
      { error: "未設定 HUB_API_TOKEN，端點停用" },
      { status: 503 }
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // 長度不同直接判失敗，長度相同才逐字比較，避免用比較耗時洩漏長度以外的資訊。
  let ok = got.length === expected.length;
  if (ok) {
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    ok = diff === 0;
  }
  if (!ok) {
    return NextResponse.json({ error: "token 不正確" }, { status: 401 });
  }

  const offset = request.nextUrl.searchParams.get("range") === "last" ? -1 : 0;
  const range = monthRange(offset);
  const fxRate = await getFxRate();
  const projects = await getSpendByProject(
    new Date(range.from),
    new Date(range.to),
    fxRate.rate
  );

  return NextResponse.json({
    month: taipeiDay(new Date(range.from)).slice(0, 7),
    fx: { rate: fxRate.rate, source: fxRate.source, day: fxRate.day, stale: fxRate.stale },
    // 這段是給讀這份 JSON 的人看的，不要拿掉。
    // 兩個數字重疊在「經閘道打 Google」那一段，相加會重複計算。
    caution:
      "gateway 與 billing 是兩種不同的統計，不可相加。" +
      "gateway 是經閘道的所有請求（含 Groq、OpenRouter、訂閱），" +
      "billing 是 Google 實際收的錢（含專案直連 Vertex 的部分），兩者部分重疊。" +
      "billing 為 null 代表該軟體尚未設定 billing_client_id，無從歸戶，不是零。",
    projects: projects.filter((p) => p.boardProjectName),
    unmapped: projects
      .filter((p) => !p.boardProjectName)
      .map((p) => p.app),
  });
}

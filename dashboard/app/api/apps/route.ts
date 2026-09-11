import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listApps, createApp, markAclSynced } from "@/lib/db";
import { generateVirtualKey, setKeyAllowedModels, LiteLlmError } from "@/lib/litellm";
import { resolveAllowedBase } from "@/lib/acl";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireSession();
  if (guard) return guard;

  const apps = await listApps();
  return NextResponse.json({ apps });
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  let body: { name?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求 body 不是合法 JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name 為必填" }, { status: 400 });
  }

  let generated;
  try {
    generated = await generateVirtualKey({ keyAlias: name, metadata: { app: name } });
  } catch (err) {
    if (err instanceof LiteLlmError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json({ error: "呼叫 LiteLLM 管理 API 時發生未預期錯誤" }, { status: 503 });
  }

  const tokenId =
    (generated.token as string | undefined) ||
    (generated.key_name as string | undefined) ||
    generated.key;

  const app = await createApp({
    name,
    description: body.description ?? null,
    vkeyId: tokenId,
  });

  if (!app) {
    return NextResponse.json(
      { error: "虛擬金鑰已簽發，但寫入資料庫失敗（資料庫可能無法連線）。金鑰仍然有效，請自行至 LiteLLM 記錄。", key: generated.key },
      { status: 500 }
    );
  }

  // 新軟體的金鑰要當場套上模型白名單。
  //
  // 不套會怎樣：/key/generate 沒帶 models 時，LiteLLM 存的是**空陣列**，
  // 而空陣列的語意是「全部放行」——新軟體一發鑰就打得到 sub-claude、
  // sub-codex、sub-gemini、sub-imagegen，也就是 User 自己的訂閱額度，
  // 完全繞過「應用程式」頁那一關訂閱授權。
  // 2026-08-28 用拋棄式軟體實測確認：script 剛發的新鑰直打 sub-claude 回 200，
  // 而且 /v1/models 會把四條訂閱通道全列給它看。
  //
  // subModels 固定給空陣列：新軟體預設不得使用訂閱通道，
  // 要開放一律走「應用程式」頁的訂閱授權，那裡才有額度守門的配套。
  //
  // 失敗不中止：金鑰與資料庫列都已經建好，中止只會留下更難收拾的半套狀態。
  // 改成寫進 acl_error 並在回應裡帶警告——「設定看起來對但實際沒生效」
  // 是最危險的狀態，必須看得出來（同 rotate-key 的處理）。
  let aclWarning: string | null = null;
  try {
    const base = await resolveAllowedBase({ vertexPassthrough: false });
    await setKeyAllowedModels({ key: tokenId, nonSubPatterns: base.models, subModels: [] });
    await markAclSynced(app.id, base.usedFallback ? `已推送，但用的是退路清單：${base.reason}` : undefined);
  } catch (err) {
    aclWarning = err instanceof Error ? err.message : String(err);
    await markAclSynced(app.id, aclWarning);
  }

  return NextResponse.json({ app, key: generated.key, aclWarning }, { status: 201 });
}

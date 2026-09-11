import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import {
  NON_SUB_MODEL_PATTERNS,
  VERTEX_PASSTHROUGH_PATTERN,
  listAppSubscriptions,
  markAclSynced,
} from "@/lib/db";
import { listGatewayModelNames, setKeyAllowedModels } from "@/lib/litellm";

export const dynamic = "force-dynamic";

/**
 * 把所有軟體的金鑰白名單重新推一次到閘道。
 *
 * 什麼時候要按：**閘道新增或改名模型之後**。
 * 白名單存的是明確的部署名（2026-08-26 起，理由見 setKeyAllowedModels），
 * 所以新模型不會自動開放給既有軟體，要按一次這個。
 *
 * 逐一推送、逐一記結果——一個軟體失敗不影響其他軟體。
 * 全部成功才回 ok，有失敗要明確列出是哪幾個：
 * 「設定看起來對但實際沒生效」是最危險的狀態。
 */
export async function POST() {
  const guard = await requireSession();
  if (guard) return guard;

  let gatewayModels: string[];
  try {
    gatewayModels = await listGatewayModelNames();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `取不到閘道的模型清單，沒有推送任何軟體：${msg}` },
      { status: 503 }
    );
  }

  if (gatewayModels.length === 0) {
    // 空清單推下去等於把所有軟體斷線。寧可不做。
    return NextResponse.json(
      { error: "閘道回了空的模型清單，為避免把所有軟體鎖死，這次不推送。" },
      { status: 503 }
    );
  }

  const apps = await listAppSubscriptions();
  const ok: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const app of apps) {
    if (!app.vkey_id) continue;
    const base = [...gatewayModels];
    if (app.vertex_passthrough) base.push(VERTEX_PASSTHROUGH_PATTERN);
    try {
      await setKeyAllowedModels({
        key: app.vkey_id,
        nonSubPatterns: base,
        subModels: app.subs ?? [],
      });
      await markAclSynced(app.id);
      ok.push(app.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAclSynced(app.id, msg);
      failed.push({ name: app.name, error: msg });
    }
  }

  return NextResponse.json({
    models: gatewayModels,
    fallbackUsed: false,
    synced: ok,
    failed,
    // 退路清單只在 listGatewayModelNames 失敗時才會用到，這裡帶出來是為了
    // 讓呼叫端知道「正常路徑」與「退路」的差別，不是給它挑的。
    fallbackPatterns: NON_SUB_MODEL_PATTERNS,
  });
}

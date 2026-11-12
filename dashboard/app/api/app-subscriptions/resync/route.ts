import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import {
  NON_SUB_MODEL_PATTERNS,
  VERTEX_PASSTHROUGH_PATTERN,
  getKeyModelSettings,
  listAppSubscriptions,
  markAclSynced,
} from "@/lib/db";
import { expandSubModels, resyncNonSubModels } from "@/lib/key-models";
import { listGatewayModelNames, listGatewaySubModelNames, setKeyAllowedModels } from "@/lib/litellm";

export const dynamic = "force-dynamic";

/**
 * 把所有軟體的金鑰白名單整理後重新推一次到閘道。
 *
 * 什麼時候要按：**閘道把模型改名或移除之後**，或簽發時出現「白名單沒套上」的警告。
 * 保留各軟體目前勾選的模型，**不會開放新模型**（規則見 lib/key-models.ts）。
 * 新模型要到該軟體的「模型」逐一勾選。
 *
 * 逐一推送、逐一記結果——一個軟體失敗不影響其他軟體。
 * 全部成功才回 ok，有失敗要明確列出是哪幾個：
 * 「設定看起來對但實際沒生效」是最危險的狀態。
 */
export async function POST() {
  const guard = await requireSession();
  if (guard) return guard;

  let gatewayModels: string[];
  let gatewaySubNames: string[];
  try {
    gatewayModels = await listGatewayModelNames();
    gatewaySubNames = await listGatewaySubModelNames();
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
  const current = await getKeyModelSettings(apps.flatMap((a) => (a.vkey_id ? [a.vkey_id] : [])));
  const ok: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const removed: { name: string; models: string[] }[] = [];

  for (const app of apps) {
    if (!app.vkey_id) continue;
    // 讀不到現況就不推。當成空清單處理的話，這把金鑰會被開成閘道全部模型。
    const setting = current[app.vkey_id];
    if (!setting) {
      const msg = "讀不到這把金鑰目前的設定，這次沒有更動";
      await markAclSynced(app.id, msg);
      failed.push({ name: app.name, error: msg });
      continue;
    }
    const { models, removed: gone } = resyncNonSubModels(
      setting.models,
      gatewayModels,
      VERTEX_PASSTHROUGH_PATTERN
    );
    const base = [...models];
    if (app.vertex_passthrough) base.push(VERTEX_PASSTHROUGH_PATTERN);
    try {
      await setKeyAllowedModels({
        key: app.vkey_id,
        nonSubPatterns: base,
        subModels: expandSubModels(app.subs ?? [], gatewaySubNames),
      });
      await markAclSynced(app.id);
      ok.push(app.name);
      if (gone.length > 0) removed.push({ name: app.name, models: gone });
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
    removed,
    // 退路清單只在 listGatewayModelNames 失敗時才會用到，這裡帶出來是為了
    // 讓呼叫端知道「正常路徑」與「退路」的差別，不是給它挑的。
    fallbackPatterns: NON_SUB_MODEL_PATTERNS,
  });
}

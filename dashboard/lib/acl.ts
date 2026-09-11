import { NON_SUB_MODEL_PATTERNS, VERTEX_PASSTHROUGH_PATTERN } from "@/lib/db";
import { listGatewayModelNames } from "@/lib/litellm";

/**
 * 算出一把金鑰的「非訂閱模型」白名單。
 *
 * 三個呼叫點共用（訂閱授權、重新簽發、全站重新同步），
 * 因為三邊算出不同的清單是遲早會發生而且很難發現的事——
 * 症狀會是「按了這個按鈕之後某個模型突然不能打了」。
 *
 * 正常路徑是拿閘道實際的部署名。取不到就退回萬用樣式：
 * **不能退回空陣列**，那會被 LiteLLM 當成「什麼都不准打」，
 * 一次同步失敗就讓所有軟體斷線。
 */
export async function resolveAllowedBase(opts: {
  vertexPassthrough: boolean;
}): Promise<{ models: string[]; usedFallback: boolean; reason: string | null }> {
  let models: string[];
  let usedFallback = false;
  let reason: string | null = null;

  try {
    models = await listGatewayModelNames();
    if (models.length === 0) {
      models = [...NON_SUB_MODEL_PATTERNS];
      usedFallback = true;
      reason = "閘道回了空的模型清單";
    }
  } catch (err) {
    models = [...NON_SUB_MODEL_PATTERNS];
    usedFallback = true;
    reason = err instanceof Error ? err.message : String(err);
  }

  if (opts.vertexPassthrough) models = [...models, VERTEX_PASSTHROUGH_PATTERN];
  return { models, usedFallback, reason };
}

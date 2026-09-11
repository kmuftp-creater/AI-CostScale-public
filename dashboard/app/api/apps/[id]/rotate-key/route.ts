import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listAppSubscriptions, retireAppVkey, markAclSynced, getAppForLimit } from "@/lib/db";
import { applyHardLimit } from "@/lib/hard-limit";
import { resolveAllowedBase } from "@/lib/acl";
import {
  generateVirtualKey,
  deleteVirtualKey,
  setKeyAllowedModels,
  renameVirtualKey,
  LiteLlmError,
} from "@/lib/litellm";

export const dynamic = "force-dynamic";

/**
 * 重新簽發某個軟體的虛擬金鑰。
 *
 * 為什麼需要這個：虛擬金鑰的明文**在系統裡任何地方都沒有存**——
 * LiteLLM 的 `LiteLLM_VerificationToken.token` 是 SHA-256 雜湊，
 * 只留一個遮罩提示（`sk-...Sknw`）。所以「把舊金鑰再顯示一次」做不到，
 * 弄丟之後唯一的路就是換一把新的。
 *
 * ## 為什麼要先幫舊金鑰改名
 *
 * **LiteLLM 要求金鑰別名全站唯一。** 第一版寫成「先發新的、再撤舊的」，
 * 兩把同名，第二把直接被回 400：
 *
 *     Key with alias 'rotate-test' already exists.
 *     Unique key aliases across all keys are required.
 *
 * 但「先撤舊的再發新的」也不行——中間若發新的那一步失敗，
 * 那個軟體會變成沒有任何可用金鑰，而且舊的已經撤了、救不回來。
 *
 * 所以順序是：**先把舊的改名讓出別名 → 發新的 → 記帳 → 才撤舊的**。
 * 任何一步失敗都還有一把可用的金鑰在，最壞情況只是留下一把孤兒金鑰。
 * 發新的那一步失敗時會把舊金鑰的名字改回去，不留下改到一半的狀態。
 *
 * ## 為什麼要把舊金鑰記進 retired_vkey_ids
 *
 * 歸戶是拿 `apps.vkey_id` 比對 `LiteLLM_SpendLogs.api_key`。舊 token 的
 * 歷史紀錄不會因為金鑰被撤而消失，但會對不回任何軟體——於是那個專案
 * 過去的花費從排行榜上消失、整批跑進「未歸戶」。
 * 數字加起來還是對的，只是歸錯地方，**而且沒有任何錯誤訊息**。
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/apps/[id]/rotate-key">) {
  const guard = await requireSession();
  if (guard) return guard;

  const { id } = await ctx.params;
  const appId = Number(id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  const apps = await listAppSubscriptions();
  const app = apps.find((a) => a.id === appId);
  if (!app) {
    return NextResponse.json({ error: "找不到這個軟體" }, { status: 404 });
  }

  const oldVkey = app.vkey_id;
  // 用 updated_at 秒數當後綴即可，只要唯一就好，不需要好看。
  const retiredAlias = `${app.name}-retired-${Math.floor(Date.now() / 1000)}`;

  // 1. 舊金鑰改名，讓出正式別名。
  if (oldVkey) {
    try {
      await renameVirtualKey(oldVkey, retiredAlias);
    } catch (err) {
      const msg = err instanceof LiteLlmError ? err.message : String(err);
      return NextResponse.json(
        { error: `舊金鑰改名失敗，什麼都沒變動：${msg}` },
        { status: 503 }
      );
    }
  }

  // 2. 發新的。失敗要把舊名字改回去，不留半套狀態。
  let generated;
  try {
    generated = await generateVirtualKey({
      keyAlias: app.name,
      metadata: { app: app.name, rotatedFrom: oldVkey ?? null },
    });
  } catch (err) {
    const msg = err instanceof LiteLlmError ? err.message : "呼叫 LiteLLM 管理 API 時發生未預期錯誤";
    let rollback = "";
    if (oldVkey) {
      try {
        await renameVirtualKey(oldVkey, app.name);
      } catch {
        rollback = `　另外：舊金鑰的別名已改成 ${retiredAlias} 且改不回來，需人工處理。`;
      }
    }
    return NextResponse.json(
      { error: `簽發新金鑰失敗，舊金鑰仍然有效：${msg}${rollback}` },
      { status: 503 }
    );
  }

  const newTokenId =
    (generated.token as string | undefined) ||
    (generated.key_name as string | undefined) ||
    generated.key;

  // 3. 把原本的模型白名單套到新金鑰上。
  //    失敗不中止——金鑰已經發出去了，中止只會留下更混亂的狀態。
  //    但要記進 acl_error 並回報：白名單沒套上＝這個軟體突然能打所有訂閱模型。
  let aclWarning: string | null = null;
  try {
    const base = await resolveAllowedBase({ vertexPassthrough: app.vertex_passthrough });
    await setKeyAllowedModels({
      key: newTokenId,
      nonSubPatterns: base.models,
      subModels: app.subs ?? [],
    });
    await markAclSynced(appId, base.usedFallback ? `已推送，但用的是退路清單：${base.reason}` : undefined);
  } catch (err) {
    aclWarning = err instanceof Error ? err.message : String(err);
    await markAclSynced(appId, aclWarning);
  }

  // 4. 記進資料庫：新金鑰生效，舊金鑰進 retired 名單（歸戶要用）。
  //    這一步失敗就別撤舊金鑰——撤了之後資料庫還指著舊的，等於兩把都不能用。
  const updated = await retireAppVkey(appId, oldVkey, newTokenId);
  if (!updated) {
    return NextResponse.json(
      {
        error: "新金鑰已簽發，但寫入資料庫失敗，舊金鑰保持有效。請記下新金鑰後人工處理。",
        key: generated.key,
      },
      { status: 500 }
    );
  }

  // 4.5 把每月硬上限套到新金鑰上（2026-09-10）。
  //     新金鑰什麼限制都沒有——不做這一步，換一次鑰上限就默默消失了。
  //     本期花費要連舊金鑰一起算，否則月中換鑰等於把計數歸零、上限多送一輪。
  //     失敗不中止（金鑰已經發出去了），但要講出來：這個軟體現在沒有上限。
  let limitWarning: string | null = null;
  const limitInfo = await getAppForLimit(appId);
  if (limitInfo?.hard_limit_usd != null) {
    try {
      await applyHardLimit({
        vkey: newTokenId,
        retiredVkeys: [oldVkey, ...limitInfo.retired_vkey_ids].filter(
          (v): v is string => !!v && v !== newTokenId
        ),
        usd: limitInfo.hard_limit_usd,
        previousUsd: null,
      });
    } catch (err) {
      limitWarning = err instanceof Error ? err.message : String(err);
    }
  }

  // 5. 最後才撤舊的。撤不掉只是留下一把孤兒金鑰，不影響新金鑰可用。
  let revokeWarning: string | null = null;
  if (oldVkey) {
    try {
      await deleteVirtualKey([oldVkey]);
    } catch (err) {
      revokeWarning = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    app: updated,
    key: generated.key,
    warning:
      [
        aclWarning ? `模型白名單推送失敗：${aclWarning}（這把新金鑰目前可能不受限制）` : null,
        limitWarning
          ? `每月上限沒有套到新金鑰：${limitWarning}（這個軟體目前沒有上限，請到本頁重新設定）`
          : null,
        revokeWarning
          ? `舊金鑰撤銷失敗：${revokeWarning}（舊金鑰仍然有效、別名為 ${retiredAlias}，需人工撤銷）`
          : null,
      ]
        .filter(Boolean)
        .join("；") || null,
  });
}

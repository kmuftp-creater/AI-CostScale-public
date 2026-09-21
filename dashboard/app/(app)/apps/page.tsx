import {
  listApps,
  getUsageSummary,
  listAppSubscriptions,
  getUnattributedUsage,
  listAppLimits,
  getFxRate,
  spendOfKeysSince,
  getKeyModelSettings,
  VERTEX_PASSTHROUGH_PATTERN,
} from "@/lib/db";
import { listGatewayModelNames, DEFAULT_ALIAS } from "@/lib/litellm";
import { resolveRange } from "@/lib/range";
import AppsClient from "./AppsClient";
import AppSubsClient from "./AppSubsClient";

export const dynamic = "force-dynamic";

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  // 這一頁原本寫死本月，頁首的日期選單按了完全沒反應（2026-08-26 修）。
  const params = await searchParams;
  const range = resolveRange(params);
  const [apps, summary, appSubs, unattributed, limitRows, fx] = await Promise.all([
    listApps(),
    getUsageSummary(new Date(range.from), new Date(range.to)),
    listAppSubscriptions(),
    getUnattributedUsage(new Date(range.from), new Date(range.to)),
    listAppLimits(),
    getFxRate(),
  ]);

  // 每個軟體的模型設定（2026-09-21）。真相在閘道那把金鑰上，這裡只是讀出來顯示。
  // 閘道連不上時 gatewayModels 會是空陣列，對話框就沒有東西可勾，而不是給一張錯的清單。
  const [keySettings, gatewayModels] = await Promise.all([
    getKeyModelSettings(apps.map((a) => a.vkey_id ?? "")),
    listGatewayModelNames().catch(() => [] as string[]),
  ]);
  const modelSettings: Record<number, { allowed: string[]; defaultModel: string | null }> = {};
  for (const a of apps) {
    const s = a.vkey_id ? keySettings[a.vkey_id] : undefined;
    if (!s) continue;
    modelSettings[a.id] = {
      // 訂閱通道、Vertex 直通樣式、別名本身都不是「可勾選的模型」
      allowed: s.models.filter(
        (m) => !m.startsWith("sub-") && m !== VERTEX_PASSTHROUGH_PATTERN && m !== DEFAULT_ALIAS
      ),
      defaultModel: s.aliases?.[DEFAULT_ALIAS] ?? null,
    };
  }

  // 每月硬上限（2026-09-10）。「本月已用」要跟閘道歸零的邊界一致：
  // 2026-09-12 起閘道設了 timezone: Asia/Taipei，月初是台北 1 日 00:00，
  // 直接用全站同一支 resolveRange 的「本月」，不再自己算。
  // 這裡**不用**頁首選的日期區間——那是看報表用的，上限只認閘道的那個月。
  // 連舊金鑰一起算：月中換過鑰的軟體，本月花費有一部分記在舊金鑰上。
  const monthStartUtc = new Date(resolveRange({}).from);
  const limits: Record<
    number,
    {
      hardLimitUsd: number | null;
      keySpendUsd: number | null;
      keyMaxBudgetUsd: number | null;
      budgetResetAt: string | null;
      monthSpendUsd: number | null;
    }
  > = {};
  await Promise.all(
    apps
      .filter((a) => a.status === "active" && a.vkey_id)
      .map(async (a) => {
        const row = limitRows.find((r) => r.appId === a.id);
        const month = await spendOfKeysSince(
          [a.vkey_id as string, ...(a.retired_vkey_ids ?? [])],
          monthStartUtc
        );
        limits[a.id] = {
          hardLimitUsd: row?.hardLimitUsd ?? null,
          keySpendUsd: row?.keySpendUsd ?? null,
          keyMaxBudgetUsd: row?.keyMaxBudgetUsd ?? null,
          budgetResetAt: row?.budgetResetAt ?? null,
          monthSpendUsd: month,
        };
      })
  );

  const costByVkey: Record<string, { spend: number; tokens: number }> = {};
  for (const row of summary.byApiKey) {
    costByVkey[row.apiKey] = { spend: row.spend, tokens: row.tokens };
  }

  return (
    <>
      <section className="block">
        <div className="panel-head" style={{ marginTop: "var(--space-lg)" }}>
          <span className="panel-title">應用程式</span>
          <span className="microlabel">軟體與虛擬金鑰管理</span>
        </div>
      </section>
      {/* 未歸戶的用量（D-8，2026-08-25）併進了軟體清單，不再是獨立面板。
          分開放的結果是看排行時不知道有多少沒被算進去。 */}
      <AppsClient
        initialApps={apps}
        costByVkey={costByVkey}
        unattributed={JSON.parse(JSON.stringify(unattributed))}
        limits={limits}
        modelSettings={modelSettings}
        gatewayModels={gatewayModels}
        gatewayUrl={(process.env.GATEWAY_PUBLIC_URL ?? "https://llm.example.com").replace(/\/+$/, "")}
        fx={fx.rate}
        fxNote={`1 美元＝${fx.rate.toFixed(2)} 台幣（${fx.day ?? "手動設定"}${
          fx.markupPct ? `，含手續費 ${fx.markupPct}%` : ""
        }${fx.stale ? "，**匯率超過兩天沒更新**" : ""}）`}
      />
      <AppSubsClient
        initial={appSubs.map((a) => ({
          ...a,
          acl_synced_at: a.acl_synced_at ? a.acl_synced_at.toISOString() : null,
        }))}
      />
    </>
  );
}

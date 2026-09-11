import { NextRequest, NextResponse } from "next/server";
import { evaluateBudgets, recordAlert, markAlertEmailed } from "@/lib/db";
import { monthRange, formatUsd } from "@/lib/format";
import { taipeiDay } from "@/lib/range";
import { sendMail, mailConfigured, alertRecipients } from "@/lib/mail";

export const dynamic = "force-dynamic";

/**
 * 預算檢查。由 VPS 上的 cron 定時呼叫，不走 Google 登入——
 * 那是給瀏覽器用的，cron 沒有 session。改用固定 token。
 *
 * 沒設定 ALERT_CRON_TOKEN 時一律拒絕，不要因為「還沒設定」就變成公開端點。
 */
function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.ALERT_CRON_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "伺服器未設定 ALERT_CRON_TOKEN，端點停用中" },
      { status: 503 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expected) {
    return NextResponse.json({ error: "token 不正確" }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const guard = authorize(request);
  if (guard) return guard;

  const dryRun = request.nextUrl.searchParams.get("dry") === "1";
  const range = monthRange(0);
  // 台北月初是前一天 16:00Z，直接切 ISO 字串會標成上個月（2026-09-12 改台北月份時一起修）
  const period = taipeiDay(new Date(range.from)).slice(0, 8) + "01";
  const statuses = await evaluateBudgets(new Date(range.from), new Date(range.to));

  const checked = statuses.filter((s) => s.enabled);
  const hits = checked.filter((s) => s.level !== "ok");

  const fired: Array<{
    budgetId: number;
    name: string;
    level: string;
    pct: number;
    emailed: boolean;
    emailError?: string;
  }> = [];
  // 寫入失敗要浮上來，不能跟「本月已發過」混為一談。
  const failures: Array<{ budgetId: number; name: string; error: string }> = [];

  for (const s of hits) {
    const name = s.label ?? (s.scope === "global" ? "全域" : (s.app_name ?? `#${s.id}`));
    if (dryRun) {
      fired.push({ budgetId: s.id, name, level: s.level, pct: s.pct, emailed: false });
      continue;
    }

    const recorded = await recordAlert({
      budgetId: s.id,
      period,
      level: s.level as "warn" | "critical" | "over",
      spend: s.spend,
      limit: s.monthly_limit,
      pct: s.pct,
    });
    if (recorded.status === "error") {
      failures.push({ budgetId: s.id, name, error: recorded.message });
      continue;
    }
    // duplicate 代表本月這個等級已經發過，不重複寄信。
    if (recorded.status === "duplicate") continue;
    const alertId = recorded.id;

    const subject =
      s.level === "over"
        ? `[CostScale] ${name} 已超出本月預算`
        : s.level === "critical"
          ? `[CostScale] ${name} 已用掉 ${s.pct.toFixed(0)}%，接近上限`
          : `[CostScale] ${name} 已用掉 ${s.pct.toFixed(0)}% 的本月預算`;

    const lines = [
      `預算：${name}（${s.scope === "global" ? "全域" : "單一軟體"}）`,
      `期間：${period.slice(0, 7)}`,
      `已花費：US$${formatUsd(s.spend)}`,
      `月上限：US$${formatUsd(s.monthly_limit)}`,
      `使用率：${s.pct.toFixed(1)}%（警示 ${s.warn_pct}%／嚴重 ${s.critical_pct}%）`,
      `　經閘道：US$${formatUsd(s.spendGateway)}` +
        (s.gcpAttributable ? `　Vertex 直連估算：US$${formatUsd(s.spendGcp)}` : ""),
      "",
      s.scope === "app"
        ? "註：單一軟體預算只計算經閘道的用量，Vertex 直連目前分不出軟體，未計入。"
        : s.include_gcp
          ? "註：本預算已併計 Vertex 直連的估算金額（Vertex 專案總量扣掉經閘道的部分）。"
          : "註：本預算只計算經閘道的用量，未併計 Vertex 直連。",
      "",
      `儀表板：${(process.env.AUTH_URL ?? "（未設定 AUTH_URL）").replace(/\/+$/, "")}/budgets`,
    ];

    const result = await sendMail(subject, lines.join("\n"));
    await markAlertEmailed(alertId, result.ok ? undefined : result.error);
    fired.push({
      budgetId: s.id,
      name,
      level: s.level,
      pct: s.pct,
      emailed: result.ok,
      emailError: result.ok ? undefined : result.error,
    });
  }

  return NextResponse.json({
    period: period.slice(0, 7),
    dryRun,
    checked: checked.length,
    hits: hits.length,
    newlyFired: fired.length,
    failed: failures.length,
    mail: { configured: mailConfigured(), recipients: alertRecipients().length },
    fired,
    failures,
  });
}

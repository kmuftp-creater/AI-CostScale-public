import { getBoardData, getSpendByProject, getFxRate, getSettings } from "@/lib/db";
import { resolveRange } from "@/lib/range";
import BoardClient from "./BoardClient";

export const metadata = { title: "專案看板 · AI CostScale" };
export const dynamic = "force-dynamic";

/**
 * Phase 5 A2：唯讀看板。
 *
 * 資料全部來自 PostgreSQL——卡片是 A1 遷移的，GitHub 側是排程同步的快取，
 * 這一頁不打 GitHub 也不打 Cloudflare。寫入功能（編輯、標記、新增）在 A3。
 *
 * 比 App Hub 多的一件事：專案卡直接掛上本月 AI 花費（gateway 側），
 * 對應靠 apps.board_project_name，沒對應的卡就不顯示金額，不猜。
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  // 這一頁原本寫死本月，頁首的日期選單按了完全沒反應（2026-08-26 修）。
  // 卡片上掛的是「該期間的 AI 花費」，所以區間本來就該跟著選單走。
  const params = await searchParams;
  const range = resolveRange(params);
  const fx = await getFxRate();
  const [board, spend, settings] = await Promise.all([
    getBoardData(),
    getSpendByProject(new Date(range.from), new Date(range.to), fx.rate),
    getSettings(),
  ]);

  // 編輯表單的下拉選單來源。解析失敗就給空陣列——設定壞掉不該讓整頁開不了。
  const parseList = (v: string | undefined): string[] => {
    if (!v) return [];
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  };

  // 看板專案名 → 本月花費。對應鍵是 status.json 的 name（App Hub README 明定，
  // 不是資料夾名）。閘道與 GCP 兩個數字分開帶，卡片端並列顯示、不相加——
  // 兩者在「經閘道打 Google」那段重疊，這條規則與 App Hub 的 spendLine 一致。
  const spendByBoardName = new Map<
    string,
    { gateway: number; billingGross: number | null; billingNet: number | null }
  >();
  for (const s of spend) {
    if (!s.boardProjectName) continue;
    const prev = spendByBoardName.get(s.boardProjectName);
    const addNullable = (a: number | null, b: number | null) =>
      a === null && b === null ? null : (a ?? 0) + (b ?? 0);
    spendByBoardName.set(s.boardProjectName, {
      gateway: (prev?.gateway ?? 0) + s.gatewayTwd,
      billingGross: addNullable(prev?.billingGross ?? null, s.billingGrossTwd),
      billingNet: addNullable(prev?.billingNet ?? null, s.billingNetTwd),
    });
  }

  const projects = board.projects.map((p) => {
    const sp = spendByBoardName.get(p.name);
    return {
      ...p,
      spendGatewayTwd: sp ? sp.gateway : null,
      spendBillingGrossTwd: sp ? sp.billingGross : null,
      spendBillingNetTwd: sp ? sp.billingNet : null,
    };
  });

  return (
    <BoardClient
      projects={projects}
      githubSyncedAt={board.githubSyncedAt ? board.githubSyncedAt.toISOString() : null}
      githubRepoCount={board.githubRepoCount}
      categoryOptions={parseList(settings.board_categories)}
      appOptions={parseList(settings.board_apps)}
      periodLabel={range.label}
    />
  );
}

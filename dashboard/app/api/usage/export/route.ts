import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getUsageExportRows } from "@/lib/db";
import { resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

const HEADERS = [
  ["day", "日期"],
  ["source", "來源"],
  ["app", "軟體"],
  ["model", "模型"],
  ["calls", "呼叫次數"],
  ["input_tokens", "輸入 token"],
  ["output_tokens", "輸出 token"],
  ["total_tokens", "總 token"],
  ["spend_usd", "花費美元"],
  ["cost_basis", "金額性質"],
] as const;

/** RFC 4180：含逗號、引號或換行的欄位要用雙引號包起來，內部引號加倍。 */
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard) return guard;

  const sp = request.nextUrl.searchParams;
  // 與頁面共用同一個解析器（2026-08-26）。
  // 原本這裡自己解 from／to，而且把它們當成「不含」的那一端，
  // 但頁首選單給的是使用者直覺的「含」——直接串會少算最後一天，
  // 而 CSV 少一天是最難發現的那種錯：檔案照樣打得開、數字照樣很合理。
  const range = resolveRange({
    range: sp.get("range") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  });
  if (range.invalid) {
    return NextResponse.json({ error: range.invalid }, { status: 400 });
  }
  const from = range.from;
  const to = range.to;
  const fromDate = new Date(from);
  const toDate = new Date(to);

  const rows = await getUsageExportRows(fromDate, toDate);

  const lines = [
    HEADERS.map(([, zh]) => csvCell(zh)).join(","),
    ...rows.map((r) =>
      HEADERS.map(([key]) => csvCell(r[key as keyof typeof r])).join(",")
    ),
  ];

  // Excel 讀 UTF-8 CSV 需要 BOM，否則中文欄位開出來是亂碼。
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
  // 檔名用「含」的兩端，跟畫面上顯示的區間一致。
  const filename = `costscale-usage-${range.fromDay}_${range.toDay}.csv`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

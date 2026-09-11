import { Orbitron } from "next/font/google";
import { getBigScreenData } from "@/lib/bigscreen";
import BigScreenClient from "./BigScreenClient";
import "./bigscreen.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "營運大屏 · AI CostScale" };

/**
 * 營運大屏（2026-09-12）。
 *
 * 放在 (app) 群組之外：大屏要全畫面，不要儀表板的頁首與導覽列。
 * 登入保護由 proxy.ts 負責（它擋的是 /api 以外的所有路徑），這裡不必再檢查。
 * 刻意不做免登入的公開網址——那等於把各專案的花費公開出去。
 */
const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["500", "700", "900"],
  variable: "--font-orbitron",
  display: "swap",
});

export default async function BigScreenPage() {
  const data = await getBigScreenData();
  return (
    <div className={`bs ${orbitron.variable}`}>
      {/* 把 next/font 產生的真實字型名稱傳下去給 ECharts。ECharts 量字寬用 canvas，
          看不懂 CSS 變數；傳 var(--font-orbitron) 的話它會用預設字型去量，
          實際畫出來的 Orbitron 比較寬，相鄰文字就疊在一起（2026-09-12 排行的金額）。 */}
      <BigScreenClient data={data} numFont={`${orbitron.style.fontFamily}, monospace`} />
    </div>
  );
}

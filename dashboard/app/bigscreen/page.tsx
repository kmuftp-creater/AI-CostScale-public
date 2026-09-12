import fs from "node:fs";
import path from "node:path";
import { Orbitron } from "next/font/google";
import { getBigScreenData } from "@/lib/bigscreen";
import BigScreenClient from "./BigScreenClient";
import { SKIN_CLASS, parseSkin, ASSET_SLOTS, type Assets } from "./skins";
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

/**
 * 網址可以指定外觀：/bigscreen?skin=nerv。沒指定時交給瀏覽器記住的那一個（在 BigScreenClient）。
 * 伺服器端就把 class 加上去，切換時才不會先閃一下另一種配色，無頭瀏覽器截圖也才拍得到指定的那一種。
 */
/**
 * 私有素材：public/private/ 底下放了圖就用，沒放就用原創徽章。
 * 那個目錄在 .gitignore 裡，所以**不會進版控、也不會出現在公開版**——
 * 公開版看到的是同一套造型配原創徽章。伺服器端檢查，客戶端才不會去要一個不存在的檔。
 */
function findAsset(base: string) {
  // 放 png、jpg 或 webp 都認得，回傳網址；沒放就 null
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const rel = `private/${base}.${ext}`;
    try { if (fs.existsSync(path.join(process.cwd(), "public", rel))) return "/" + rel; } catch { /* 讀不到就當沒放 */ }
  }
  return null;
}

/** 每個插槽找一次檔案。沒放的插槽就不會出現在畫面上。 */
function collectAssets(): Assets {
  const out: Assets = {};
  for (const slot of ASSET_SLOTS) {
    const url = findAsset(slot);
    if (url) out[slot] = url;
  }
  return out;
}

export default async function BigScreenPage({ searchParams }: { searchParams: Promise<{ skin?: string }> }) {
  const sp = await searchParams;
  const urlSkin = parseSkin(sp.skin);
  const data = await getBigScreenData();
  const assets = collectAssets();
  return (
    <div className={`bs ${urlSkin ? SKIN_CLASS[urlSkin].join(" ") : ""} ${orbitron.variable}`}>
      {/* 把 next/font 產生的真實字型名稱傳下去給 ECharts。ECharts 量字寬用 canvas，
          看不懂 CSS 變數；傳 var(--font-orbitron) 的話它會用預設字型去量，
          實際畫出來的 Orbitron 比較寬，相鄰文字就疊在一起（2026-09-12 排行的金額）。 */}
      <BigScreenClient data={data} numFont={`${orbitron.style.fontFamily}, monospace`} initialSkin={urlSkin} assets={assets} />
    </div>
  );
}

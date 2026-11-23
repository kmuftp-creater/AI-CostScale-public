import { connection } from "next/server";
import { currentSecurityWarnings } from "@/lib/security-env";

/**
 * 安全警告橫幅：AUTH_DISABLED=1、主金鑰或資料庫密碼還是範本值時，固定顯示在每一頁最上方。
 * 沒有任何警告時什麼都不渲染。樣式沿用預算橫幅的警示色（.budget-banner.critical），不另外配色。
 *
 * compact：大屏這類沒有頁首的全畫面頁面用，只顯示標籤與一句話，不列修正步驟。
 */
export default async function SecurityBanner({ compact = false }: { compact?: boolean }) {
  // 環境變數要在請求當下讀，不能在建置時就定死（建置時沒有 .env）。
  await connection();
  const warnings = currentSecurityWarnings();
  if (warnings.length === 0) return null;

  return (
    <div className={compact ? "sec-banners compact" : "sec-banners"} role="alert">
      {warnings.map((w) => (
        <div key={w.id} className="budget-banner critical sec-banner">
          <span className="budget-banner-tag">{w.tag}</span>
          <div className="sec-banner-body">
            <div>{w.summary}</div>
            {compact ? null : (
              <ol className="sec-banner-fix">
                {w.fix.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

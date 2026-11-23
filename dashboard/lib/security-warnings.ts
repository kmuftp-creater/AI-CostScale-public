/**
 * 儀表板的安全警告（純函式，不碰環境變數與其他檔案，方便用 node 直接跑測試：scripts/test-security-warnings.mjs）。
 *
 * 三種警告，都「不阻擋啟動」，只負責讓人看到：
 *   - auth-disabled：AUTH_DISABLED=1，所有頁面與 API 免登入。保留這個開關是為了測試，但不能無聲無息。
 *   - master-key-template：LITELLM_MASTER_KEY 還是 .env.example 的範本值（公開的）。
 *   - db-password-template：資料庫密碼還是 .env.example 的範本值（公開的）。
 *
 * 版面上固定顯示在每一頁最上方（components/SecurityBanner.tsx），啟動時與放行時另外留 log（lib/security-env.ts）。
 */

export type SecurityWarningId = "auth-disabled" | "master-key-template" | "db-password-template";

export type SecurityWarning = {
  id: SecurityWarningId;
  /** 橫幅左邊的短標籤。 */
  tag: string;
  /** 一句話講清楚「現在有什麼風險」。 */
  summary: string;
  /** 怎麼改回來，一步一行。 */
  fix: string[];
};

export type SecurityFlags = {
  authDisabled: boolean;
  /** LITELLM_MASTER_KEY 是範本值、空值時為 true。 */
  masterKeyTemplate: boolean;
  /** 資料庫密碼是範本值、空值時為 true。 */
  dbPasswordTemplate: boolean;
};

const VPS_UP = "cd /opt/costscale && docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile full up -d";

export function buildSecurityWarnings(flags: SecurityFlags, local: boolean): SecurityWarning[] {
  const out: SecurityWarning[] = [];

  if (flags.authDisabled) {
    out.push({
      id: "auth-disabled",
      tag: "登入檢查已關閉",
      summary:
        "目前設定了 AUTH_DISABLED=1：任何連得到這個網址的人，不用帳號密碼就能看到全部花費、替自己發金鑰。這個設定只能用在測試。",
      fix: local
        ? [
            "打開專案資料夾裡的 .env，找到 AUTH_DISABLED= 那一行，把等號後面改成 0，存檔。",
            "在專案資料夾執行：docker compose up -d dashboard",
            "也可以執行設定工具（docker compose -f docker-compose.setup.yml run --rm setup，選 1），它會把這一項改回 0。",
          ]
        : [
            "在主機上打開 /opt/costscale/.env，找到 AUTH_DISABLED= 那一行，把等號後面改成 0，存檔。",
            `執行：${VPS_UP} dashboard`,
          ],
    });
  }

  if (flags.masterKeyTemplate) {
    out.push({
      id: "master-key-template",
      tag: "主金鑰是範本值",
      summary:
        ".env 的 LITELLM_MASTER_KEY 還是範本裡的公開預設值：連得到閘道的人只要知道這個預設值，就能用管理介面發金鑰、查看全部紀錄。",
      fix: local
        ? [
            "執行設定工具：docker compose -f docker-compose.setup.yml run --rm setup，選 1，它會把範本值換成新的亂數。",
            "執行：docker compose up -d",
          ]
        : [
            "在主機執行：bash /opt/costscale/scripts/install.sh，它發現範本值會換成新的亂數並重建服務。",
          ],
    });
  }

  if (flags.dbPasswordTemplate) {
    out.push({
      id: "db-password-template",
      tag: "資料庫密碼是範本值",
      summary:
        ".env 的 DB_PASSWORD 還是範本裡的公開預設值。資料庫只綁在這台主機的 127.0.0.1，外部連不到，但主機上的任何程式都能用預設密碼登入。",
      fix: [
        "資料庫建好之後，只改 .env 的 DB_PASSWORD 會讓閘道與儀表板連不上資料庫，要先在資料庫內改密碼，再改 .env。",
        `完整步驟見 INSTALL.md「把範本值換掉」${local ? "（在專案資料夾執行，不需要 /opt/costscale）" : ""}。`,
      ],
    });
  }

  return out;
}

/**
 * 「AUTH_DISABLED=1 放行」的 log 節流。每次放行都呼叫 note()，但同一段時間內只真正印一行，
 * 並在那一行帶上期間放行的次數，避免每個請求都洗版。第一次放行一定會印。
 */
export class PassLogGate {
  private lastLogAt = 0;
  private skipped = 0;
  private readonly intervalMs: number;
  constructor(intervalMs: number = 5 * 60 * 1000) {
    this.intervalMs = intervalMs;
  }

  /** 回傳要印的訊息；這次不用印回 null。 */
  note(now: number = Date.now()): string | null {
    if (this.lastLogAt !== 0 && now - this.lastLogAt < this.intervalMs) {
      this.skipped += 1;
      return null;
    }
    const prev = this.skipped;
    this.lastLogAt = now;
    this.skipped = 0;
    return (
      "[security] 警告：AUTH_DISABLED=1，登入檢查已關閉，這個請求沒有經過驗證就被放行。" +
      `（每 ${Math.round(this.intervalMs / 60000)} 分鐘最多記一行${prev > 0 ? `；上一行之後另有 ${prev} 次放行` : ""}）` +
      "要改回需要登入：把 .env 的 AUTH_DISABLED 改成 0，再重建儀表板。"
    );
  }
}

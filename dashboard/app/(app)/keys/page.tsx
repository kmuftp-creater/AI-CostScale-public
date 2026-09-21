import { getKeyInventory, applyActualKeyCounts, type UpstreamKeyRow, type PricingType } from "@/lib/keys";
import Link from "next/link";
import { listQuotaPools } from "@/lib/db";
import QuotaPoolsClient from "./QuotaPoolsClient";
import AddUpstreamKeyClient from "./AddUpstreamKeyClient";
import RemoveUpstreamKeyClient from "./RemoveUpstreamKeyClient";
import { formatTokens, formatTaipei, sinceNow } from "@/lib/format";
import { Fragment } from "react";
import {
  readUpstreamModels,
  catalogFor,
  checkDeployments,
  unusedModels,
  type UpstreamModels,
} from "@/lib/upstream-models";

export const metadata = { title: "金鑰管理 · AI CostScale" };
export const dynamic = "force-dynamic";

/**
 * 上游金鑰盤點。
 *
 * 分工：這一頁只管**上游**（供應商那一側的金鑰），發給專案的虛擬金鑰在 /apps。
 *
 * 金鑰本體不經瀏覽器，一個位元組都不。這裡出現的是環境變數的「名字」
 * （GEMINI_FREE_KEY_3 這種），那不是機密，而且它才是輪換時真正要找的東西——
 * 知道「第三把在燒」但不知道它叫什麼，等於沒說。
 */

const PRICING_LABEL: Record<PricingType, string> = {
  free: "免費",
  payg: "隨用隨付",
  subscription: "訂閱",
  unknown: "未標示",
};

const PRICING_CLASS: Record<PricingType, string> = {
  free: "k-free",
  payg: "k-paid",
  subscription: "k-sub",
  unknown: "",
};

function barClass(pct: number | null): string {
  if (pct == null) return "bar-ok";
  if (pct >= 100) return "bar-over";
  if (pct >= 95) return "bar-crit";
  if (pct >= 80) return "bar-warn";
  return "bar-ok";
}

/**
 * 每個模型組現在掛了幾把。用來判斷某一把是不是「最後一把」。
 * 移掉最後一把等於讓整個模型名從閘道消失，指名它的呼叫端會全掛——
 * 那不是「移除一把金鑰」該有的後果，所以要在按下去之前就講清楚。
 */
function groupSizes(rows: UpstreamKeyRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of rows) {
    for (const d of new Set(k.deployments.map((x) => x.modelName))) {
      m.set(d, (m.get(d) ?? 0) + 1);
    }
  }
  return m;
}

/** 一把金鑰底下那一列「可用模型」（2026-09-21）。重點是標出閘道在用、但供應商清單已經沒有的那幾個。 */
function ModelsRow({ row, data }: { row: UpstreamKeyRow; data: UpstreamModels }) {
  const cat = catalogFor(data, row.envName);
  const checks = checkDeployments(cat, row.deployments);
  const gone = checks.filter((c) => c.present === false);
  const unused = unusedModels(cat, row.deployments);

  return (
    <tr className="k-models">
      <td colSpan={5}>
        <details>
          <summary>
            可用模型
            {cat?.ok ? ` ${cat.count} 個` : ""}
            {gone.length > 0 ? (
              <strong className="k-gone"> · {gone.length} 個閘道在用的已從供應商清單消失</strong>
            ) : null}
            {cat && !cat.ok ? <strong className="k-gone"> · 查詢失敗</strong> : null}
            {!cat ? " · 尚未抓取" : ""}
          </summary>
          {!cat ? (
            <p className="k-note">
              還沒有這把金鑰的清單。主機端排程每 6 小時抓一次
              （<code>scripts/fetch-upstream-models.py</code>）。
            </p>
          ) : !cat.ok ? (
            <p className="k-note">
              <strong className="k-gone">向供應商查詢失敗</strong>：{cat.error}
              <br />
              多半是這把金鑰已經失效。閘道輪替時不會跳過壞掉的那一把，留著會變成間歇性失敗。
            </p>
          ) : (
            <>
              <p className="k-note">
                閘道用到 {checks.length} 個：
                {checks.map((c) => (
                  <span key={c.backendModel} className={c.present === false ? "k-gone" : undefined}>
                    {" "}
                    {c.backendModel}
                    {c.present === false ? "（供應商已無）" : c.present === null ? "（萬用）" : ""}
                  </span>
                ))}
              </p>
              <p className="k-note">
                這把金鑰還能用、但閘道沒開的有 {unused.length} 個
                {unused.length > 0 ? `：${unused.slice(0, 40).join("、")}` : ""}
                {unused.length > 40 ? ` 等 ${unused.length} 個` : ""}
              </p>
            </>
          )}
        </details>
      </td>
    </tr>
  );
}

function KeyTable({ rows, upstream }: { rows: UpstreamKeyRow[]; upstream: UpstreamModels }) {
  const sizes = groupSizes(rows);
  return (
    <table className="ledger">
      <tbody>
        {rows.map((k) => {
          const models = [...new Set(k.deployments.map((d) => d.modelName))];
          const shown = models.slice(0, 4).join("、");
          const more = models.length > 4 ? ` 等 ${models.length} 個` : "";
          const missing = k.deployments.filter((d) => !d.deploymentId).length;
          const lastOf = models.filter((m) => (sizes.get(m) ?? 0) <= 1);
          const blocked =
            lastOf.length > 0
              ? `${k.envName} 是 ${lastOf.join("、")} 目前唯一的一把。` +
                "移掉的話這個模型會整個從閘道消失，指名它的呼叫端會立刻失敗。" +
                "先用上面的「新增上游金鑰」補一把，再回來移這把。"
              : null;
          return (
            <Fragment key={k.envName}>
            <tr>
              <td className="t-name">
                <code>{k.envName}</code>{k.tail ? <code className="key-tail">…{k.tail}</code> : null}
                <small>
                  {k.provider}
                  {k.slot ? ` · 第 ${k.slot}／${k.poolSize} 把` : ""} · {shown}
                  {more}
                  {missing > 0 ? ` · ${missing} 個部署閘道未載入` : ""}
                </small>
              </td>
              <td className={`t-kind ${PRICING_CLASS[k.pricing]}`}>〔{PRICING_LABEL[k.pricing]}〕</td>
              <td className="t-amt">
                {k.usage.todayCalls.toLocaleString("zh-TW")} 次
                <small style={{ display: "block", fontWeight: 400, color: "var(--muted)" }}>
                  今日 {formatTokens(k.usage.todayTokens)} tokens
                </small>
              </td>
              <td className="t-amt" style={{ fontWeight: 400 }}>
                {k.usage.lastSuccessAt ? (
                  <>
                    {sinceNow(k.usage.lastSuccessAt)}
                    <small style={{ display: "block", color: "var(--muted)" }}>
                      {formatTaipei(k.usage.lastSuccessAt)}
                    </small>
                  </>
                ) : (
                  <>
                    <span style={{ color: "var(--muted)" }}>從未成功</span>
                    <small style={{ display: "block", color: "var(--muted)" }}>
                      {k.usage.lastFailureAt
                        ? `最近失敗 ${formatTaipei(k.usage.lastFailureAt)}`
                        : "也沒有失敗紀錄"}
                    </small>
                  </>
                )}
              </td>
              <td className="t-act">
                <RemoveUpstreamKeyClient
                  envName={k.envName}
                  tail={k.tail}
                  modelNames={models}
                  blockedReason={blocked}
                />
              </td>
            </tr>
            <ModelsRow row={k} data={upstream} />
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function KeysPage() {
  const [inv, poolsRaw, upstreamModels] = await Promise.all([
    getKeyInventory(),
    listQuotaPools(),
    readUpstreamModels(),
  ]);
  // 把數跟著閘道設定走，不用手填值（2026-09-12）
  const pools = applyActualKeyCounts(poolsRaw, inv);

  const providerKeys = inv.keys.filter((k) => k.kind === "provider");
  const otherCreds = inv.keys.filter((k) => k.kind !== "provider");
  const providers = [...new Set(providerKeys.map((k) => k.provider))];
  const freeKeys = providerKeys.filter((k) => k.pricing === "free").length;
  const neverUsed = providerKeys.filter((k) => !k.usage.lastSuccessAt);

  return (
    <>
      {/* ── 總量 ───────────────────────────────── */}
      <section className="block">
        <div className="ledger-strip">
          <div className="ledger-cell">
            <span className="microlabel">上游金鑰</span>
            <div className="hero-figure">{providerKeys.length}</div>
            <div className="ledger-note">
              全部存在 VPS 的 <code>/opt/costscale/.env</code>，權限 600，不進版本控制
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">供應商</span>
            <div className="stat-figure">{providers.length}</div>
            <div className="ledger-note">{providers.join("、") || "—"}</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">免費額度的金鑰</span>
            <div className="stat-figure">{freeKeys}</div>
            <div className="ledger-note">其餘為隨用隨付，用多少算多少</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">檢查時間</span>
            <div className="stat-figure" style={{ fontSize: "1rem" }}>
              {formatTaipei(inv.checkedAt, true)}
            </div>
            <div className="ledger-note">每次開啟這一頁都重新問一次閘道</div>
          </div>
        </div>
      </section>

      {(inv.configError || inv.gatewayError || inv.unloaded > 0) && (
        <section className="block tight">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">資料來源有缺口</span>
              <span className="microlabel">先看這裡，下面的數字會不完整</span>
            </div>
            <div className="empty-state">
              <span className="microlabel">Warning</span>
              {inv.configError && (
                <>
                  讀不到閘道設定檔，所以對不出「哪一把金鑰掛在哪個模型」：{inv.configError}
                  <br />
                  排查起點：dashboard 容器有沒有掛到 <code>/app/litellm-config.yaml</code>。
                  <br />
                </>
              )}
              {inv.gatewayError && (
                <>
                  問不到閘道，所以看不出設定檔裡的金鑰是否真的載入：{inv.gatewayError}
                  <br />
                </>
              )}
              {inv.unloaded > 0 && (
                <>
                  設定檔寫了 {inv.unloaded} 個部署，閘道上找不到對應的。
                  代表 <code>litellm-config.yaml</code> 改過但閘道還沒重載。
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── 免費額度 ─────────────────────────────────
          D-6（2026-08-25）：這裡原本是唯讀面板，編輯器在設定頁。
          兩邊都由 listQuotaPools() 供資料，畫的是同一件事——
          「看得到的地方改不了、改得到的地方看不到」。合併成一個。 */}
      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">免費額度</span>
            <span className="microlabel">今日經閘道消耗／整池上限 · 可直接修改</span>
          </div>
          <QuotaPoolsClient initial={JSON.parse(JSON.stringify(pools))} />
          <div className="panel-foot">
            <strong>每日 token 上限（TPD）目前三池都是空的，所以 token 進度條畫不出來。</strong>
            不是漏做：Google AI Studio 免費層公布的是 RPM／TPM／RPD，沒有「每日 token」這個維度；
            Groq 有 TPD，但 2026-08-23 實測經閘道打 <code>groq-fast</code> 拿不到
            <code> x-ratelimit-*</code> 標頭（LiteLLM 不轉發），所以也量不到。
            要畫這條進度條，只能用上面的「改每日 token 上限」依你帳號後台的實際數字手填。
          </div>
        </div>
      </section>

      {/* ── 新增上游金鑰（2026-09-07）───────────────────
          放在明細之前：要加金鑰的人不必先捲過一整張清單才找得到入口。
          模型組選項直接從上面已經解析好的部署清單來，不另外再讀一次設定檔——
          兩份來源會漂移。 */}
      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">新增上游金鑰</span>
            <span className="microlabel">加進既有模型組當輪替的一把</span>
          </div>
          <AddUpstreamKeyClient
            options={(() => {
              // 每個模型組帶著「目前掛在它底下的環境變數名」一起送給前端，
              // 前端才算得出下一個該叫什麼（2026-09-07：原本要使用者自己想，
              // User 的回饋是「Gemini 不用填環境變數吧？」——他說得對，
              // 這種東西系統自己推得出來就不該問人）。
              const byGroup = new Map<
                string,
                {
                  modelName: string;
                  backendModel: string;
                  provider: string;
                  pricing: string;
                  envNames: string[];
                }
              >();
              for (const k of providerKeys) {
                for (const d of k.deployments) {
                  const cur = byGroup.get(d.modelName);
                  if (cur) {
                    if (!cur.envNames.includes(k.envName)) cur.envNames.push(k.envName);
                  } else {
                    byGroup.set(d.modelName, {
                      modelName: d.modelName,
                      backendModel: d.backendModel,
                      provider: k.provider,
                      pricing: k.pricing as string,
                      envNames: [k.envName],
                    });
                  }
                }
              }
              return Array.from(byGroup.values()).sort((a, b) =>
                a.modelName.localeCompare(b.modelName)
              );
            })()}
          />
        </div>
      </section>

      {/* ── 上游金鑰明細 ───────────────────────────────── */}
      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">上游金鑰</span>
            <span className="microlabel">{providerKeys.length} 把 · 依計價型態排序</span>
          </div>
          {providerKeys.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              對不出任何上游金鑰。原因見上方的資料來源缺口。
            </div>
          ) : (
            <KeyTable rows={providerKeys} upstream={upstreamModels} />
          )}
          <div className="panel-foot">
            右欄的「移除」把那把金鑰從輪替裡拿掉、並把 <code>.env</code> 那一行改成註解
            （<strong>值留著</strong>，按錯救得回來）。要讓金鑰真正作廢，還是得去供應商後台停用它——
            那件事這裡做不到，也不該做。
            <br />
            左欄是 <code>.env</code> 的<strong>變數名</strong>，不是金鑰值——金鑰本體一個位元組都不會離開 VPS。
            要輪換某一把時，改的就是這個名字對應的那一行。
            <br />
            同一個模型名底下的多把金鑰是 <code>simple-shuffle</code>
            <strong>隨機挑</strong>，沒有先後順位，所以額度是均勻消耗的，
            不會出現「第一把用完才換第二把」。
            <br />
            「第 N 把」的對應方式：設定檔第 N 筆對到閘道載入的第 N 個部署。
            這不是猜的——2026-08-23 在閘道容器內用 LiteLLM 自己的部署 id 演算法
            重算 <code>gemini-flash-free</code> 五把的雜湊，與線上五個 id 依序完全吻合。
          </div>
        </div>
      </section>

      {neverUsed.length > 0 && (
        <section className="block tight">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">從來沒成功用過的金鑰</span>
              <span className="microlabel">{neverUsed.length} 把</span>
            </div>
            <table className="ledger">
              <tbody>
                {neverUsed.map((k) => (
                  <tr key={k.envName}>
                    <td className="t-name">
                      <code>{k.envName}</code>{k.tail ? <code className="key-tail">…{k.tail}</code> : null}
                      <small>
                        {k.provider} · {[...new Set(k.deployments.map((d) => d.modelName))].join("、")}
                      </small>
                    </td>
                    <td className="t-amt" style={{ fontWeight: 400 }}>
                      {k.usage.totalFailures > 0
                        ? `${k.usage.totalFailures} 次失敗`
                        : "沒有任何呼叫紀錄"}
                      <small style={{ display: "block", color: "var(--muted)" }}>
                        {k.usage.lastFailureAt ? `最近失敗 ${formatTaipei(k.usage.lastFailureAt)}` : "—"}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="panel-foot">
              「有部署」不等於「打得通」。這裡列的是閘道確實載入、但帳目上找不到一次成功呼叫的金鑰。
              有失敗紀錄的多半是金鑰無效或占位字串；完全沒有紀錄的則可能只是還沒有人打過。
              兩者都不該被排進任何專案的備援鏈，除非先實打驗過。
            </div>
          </div>
        </section>
      )}

      {/* ── 非供應商金鑰的上游憑證 ───────────────────────────────── */}
      {otherCreds.length > 0 && (
        <section className="block tight">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">其他上游憑證</span>
              <span className="microlabel">不是供應商 API 金鑰，但同樣是上游要認的東西</span>
            </div>
            <KeyTable rows={otherCreds} upstream={upstreamModels} />
            <div className="panel-foot">
              <code>BRIDGE_TOKEN</code> 是閘道呼叫家用主機橋接服務時用的認證 token，
              吃的是<strong>訂閱額度</strong>而不是 API 計費；隧道斷掉時所有 <code>sub-*</code>
              一起不可用，狀態看<Link href="/channels">通道與用量</Link>。
              <br />
              <code>GOOGLE_APPLICATION_CREDENTIALS</code> 是 GCP 服務帳戶憑證檔
              （<code>/root/vertex-sa.json</code>，閘道唯讀掛載），所有 Vertex AI 部署都用它，
              沒有對應的 API 金鑰。它的花費在 <Link href="/billing">GCP 帳單</Link>。
            </div>
          </div>
        </section>
      )}
    </>
  );
}

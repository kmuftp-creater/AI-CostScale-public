"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 新增上游金鑰（2026-09-07）。
 *
 * 這個表單只把請求排進佇列，不直接改設定檔、不重啟閘道——
 * 那些由主機端的 apply-upstream-key.py 做，理由見 /api/upstream-keys 的註解。
 *
 * ── 2026-09-07 下午，User 看畫面之後回報三件，全部是實際缺陷 ──
 *
 *   1.「框內文字都卡到了」——`.sub-form` 是 minmax(150px, 1fr)，
 *      六個欄位擠在一列，長的提示文字被裁掉。改用自己的 grid（最小 240px）。
 *   2.「Gemini 不用填環境變數吧？」——**他是對的**。下一個變數名系統推得出來
 *      （看那個模型組現在掛了哪幾把、把尾碼加一），不該問人。改成自動帶入、可改。
 *   3.「驗證並排入套用 無反應」——按鈕原本 `disabled={!apiKey || !envVar}`，
 *      **停用的按鈕不會告訴人為什麼**。改成永遠可按，缺什麼就講什麼。
 *
 * 第三點是這三件裡最該記住的：**把按鈕停用當成驗證，等於把錯誤訊息藏起來。**
 */

type Option = {
  modelName: string;
  backendModel: string;
  provider: string;
  pricing: string;
  envNames: string[];
};

type Status = {
  id: string;
  state: string;
  message: string;
  at: string;
  envVar?: string;
  modelName?: string;
};

const PROVIDERS = [
  { id: "gemini", label: "Google AI Studio（Gemini）" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic（Claude）" },
  { id: "groq", label: "Groq" },
  { id: "openrouter", label: "OpenRouter" },
];

/**
 * 從「這個模型組現在掛的變數名」推出下一個。
 * 例：GEMINI_FREE_KEY_1..5 → GEMINI_FREE_KEY_6。
 * 推不出來（沒有數字結尾）就在後面接 _2，再不行就交給人填。
 */
function nextEnvName(envNames: string[]): string {
  const numbered = envNames
    .map((n) => /^(.*?)(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m);
  if (numbered.length > 0) {
    const prefix = numbered[0][1];
    const max = Math.max(...numbered.map((m) => Number(m[2])));
    return `${prefix}${max + 1}`;
  }
  if (envNames.length > 0) return `${envNames[0]}_2`;
  return "";
}

export default function AddUpstreamKeyClient({ options }: { options: Option[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState("gemini");
  const [modelName, setModelName] = useState(options[0]?.modelName ?? "");
  const [envVar, setEnvVar] = useState("");
  const [envTouched, setEnvTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [rpm, setRpm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [statuses, setStatuses] = useState<Status[]>([]);

  const chosen = useMemo(
    () => options.find((o) => o.modelName === modelName) ?? null,
    [options, modelName]
  );

  // 換模型組就重算建議的變數名。人動過那一格之後就不再覆蓋他打的東西。
  useEffect(() => {
    if (envTouched) return;
    setEnvVar(chosen ? nextEnvName(chosen.envNames) : "");
  }, [chosen, envTouched]);

  async function refresh() {
    try {
      const res = await fetch("/api/upstream-keys");
      if (!res.ok) return;
      const d = await res.json();
      setPending(d.pending ?? 0);
      setStatuses(Array.isArray(d.statuses) ? d.statuses : []);
    } catch {
      // 讀不到就不更新，不要洗掉畫面上已經有的東西
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);

    // 缺欄位要「講出來」，不是把按鈕變灰。
    if (!chosen) return setErr("要先選一個模型組。");
    if (!envVar.trim()) return setErr("環境變數名是空的。切換一次模型組會自動帶入建議值。");
    if (!apiKey.trim()) return setErr("金鑰是空的，請貼上供應商給你的那一串。");

    setBusy(true);
    try {
      const res = await fetch("/api/upstream-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          modelName,
          backendModel: chosen.backendModel,
          envVar: envVar.trim(),
          key: apiKey.trim(),
          rpm: rpm ? Number(rpm) : 0,
          pricingType: chosen.pricing,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.error ?? `送出失敗（${res.status}）`);
        return;
      }
      setMsg(d.message ?? "已排入佇列");
      setApiKey("");
      setRpm("");
      // 頁面資料要等主機端套用完（最多一分鐘）才會更新，
      // 在那之前建議值還是舊的——連按兩次就會撞名。
      // User 2026-09-07 就是這樣連續送了兩次 GEMINI_FREE_KEY_6。
      // 這裡先在前端往前推一個，套用完之後伺服器那邊會再校正。
      setEnvVar((cur) => nextEnvName([cur]));
      setEnvTouched(true);
      refresh();
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="key-form">
        <label>
          供應商
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          加進哪個模型組
          <select
            value={modelName}
            onChange={(e) => {
              setModelName(e.target.value);
              setEnvTouched(false);
            }}
          >
            {options.map((o) => (
              <option key={o.modelName} value={o.modelName}>
                {o.modelName}（現有 {o.envNames.length} 把）
              </option>
            ))}
          </select>
        </label>

        <label>
          金鑰
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="貼上金鑰"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label>
          每分鐘上限
          <input
            value={rpm}
            onChange={(e) => setRpm(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="選填"
            inputMode="numeric"
          />
        </label>

        <label>
          環境變數名（系統自動命名，通常不用改）
          <input
            value={envVar}
            onChange={(e) => {
              setEnvTouched(true);
              setEnvVar(e.target.value.toUpperCase());
            }}
            spellCheck={false}
          />
        </label>

        {/* 直接當 grid 子項，跟訂閱頁那顆一樣用 btn-primary。
            2026-09-07 第一版包了一層 div 又沒帶 class，畫面上是一段沒有框的文字，
            位置也跟欄位對不齊——User 回報「沒有看到按鈕框，放置的位置很奇怪」。 */}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "驗證中…" : "驗證並排入套用"}
        </button>
      </form>

      {err ? <div className="form-error">{err}</div> : null}
      {msg ? <div className="form-ok">{msg}</div> : null}

      <div className="panel-foot">
        {"送出前會先拿這把金鑰去打供應商的「列模型」端點，驗不過就不會寫進任何地方。驗過之後排進佇列，主機端每分鐘處理一次。"}
        <strong>　套用時閘道會重啟數秒，那期間所有請求會失敗，所以尖峰時段不要按。</strong>
        {"　套用失敗會自動把 .env 與設定檔回滾到原狀並把閘道重新拉起來。" +
          "這個表單只能把金鑰加進既有的模型組當輪替的一把；要新增模型組是另一個功能。"}
      </div>

      {pending > 0 ? (
        <div className="microlabel" style={{ marginTop: "0.5rem" }}>
          佇列中還有 {pending} 筆待套用，主機端每分鐘處理一次。
        </div>
      ) : null}

      {statuses.length > 0 ? (
        <table className="ledger" style={{ marginTop: "0.75rem" }}>
          <thead>
            <tr>
              <th>時間</th>
              <th>結果</th>
              <th>變數／模型組</th>
              <th>訊息</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.id}>
                <td className="microlabel">{s.at ? s.at.slice(0, 19).replace("T", " ") : "—"}</td>
                <td>{s.state === "applied" ? "成功" : "失敗"}</td>
                <td className="microlabel">
                  {s.envVar ?? "—"}
                  {s.modelName ? ` → ${s.modelName}` : ""}
                </td>
                <td className="microlabel">{s.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

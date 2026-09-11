"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { monthlyEquivalent } from "@/lib/format";

type Row = {
  id: number;
  service: string;
  plan: string | null;
  /** 該計費週期的金額：月繳是月費、年繳是年費。 */
  fee: string | number;
  currency: string;
  billing_cycle: "monthly" | "yearly";
  billing_day: number;
  billing_month: number | null;
  status: string;
  note: string | null;
};

function nextBilling(row: Row): string {
  const now = new Date();
  let next: Date;
  if (row.billing_cycle === "yearly") {
    const month = (row.billing_month ?? 1) - 1;
    next = new Date(now.getFullYear(), month, row.billing_day);
    if (next < now) next.setFullYear(next.getFullYear() + 1);
  } else {
    next = new Date(now.getFullYear(), now.getMonth(), row.billing_day);
    if (next < now) next.setMonth(next.getMonth() + 1);
  }
  const days = Math.ceil((next.getTime() - now.getTime()) / 86400000);
  return `${next.getMonth() + 1}/${next.getDate()}（${days} 天後）`;
}

/** 編輯中的暫存值。一律用字串，送出前才轉數字——輸入途中的半成品不該被迫合法。 */
type Draft = {
  service: string;
  plan: string;
  fee: string;
  currency: string;
  cycle: "monthly" | "yearly";
  day: string;
  month: string;
  note: string;
};

/**
 * 實際入帳與預期的差額標籤（2026-08-25，D-2）。
 * 只顯示差多少，不顯示百分比——單筆的百分比會被四捨五入放大，
 * 有意義的是彙總之後反推的手續費率，那個放在上面的統計格。
 */
function diffLabel(c: {
  amount_twd: string | number;
  actual_twd: string | number | null;
}): string {
  if (c.actual_twd == null) return "";
  const d = Number(c.actual_twd) - Number(c.amount_twd);
  if (Math.abs(d) < 0.005) return "0";
  const sign = d > 0 ? "＋" : "－";
  return `${sign}${Math.abs(d).toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const CYCLE_TEXT: Record<Row["billing_cycle"], string> = {
  monthly: "月繳",
  yearly: "年繳",
};

/**
 * 已發生的扣款。每一欄都是扣款當下的快照（2026-08-24，C-13）。
 * 這裡刻意不放「用現在匯率重算」的欄位——那正是這張表要防的事。
 */
type Charge = {
  id: number;
  service: string;
  charged_on: string;
  fee: string | number;
  currency: string;
  fx_rate: string | number;
  fx_source: string;
  markup_pct: string | number;
  amount_twd: string | number;
  /** 信用卡帳單上的實際入帳金額，人工填。null＝尚未對帳。 */
  actual_twd: string | number | null;
  reconciled_at: string | null;
};

export default function SubscriptionsClient({
  initial,
  charges: initialCharges,
  fx,
  fxBase,
  fxDay,
  fxStale,
}: {
  initial: Row[];
  charges: Charge[];
  fx: number;
  /** 現在的牌告匯率，未加手續費。用來跟凍結值比較。 */
  fxBase: number;
  fxDay: string | null;
  fxStale: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [service, setService] = useState("");
  const [plan, setPlan] = useState("");
  const [fee, setFee] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const [day, setDay] = useState("1");
  const [month, setMonth] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 正在編輯哪一列，以及那一列的暫存值（2026-08-22，C-7）。
   *
   * 先前沒有編輯功能，改月費的唯一辦法是刪掉重建。那個代價比看起來大：
   * subscription_charges.sub_id 是 ON DELETE CASCADE，
   * **刪掉訂閱會連同已發生的扣款紀錄一起消失**，而那些紀錄裡存的是
   * 扣款當下的匯率快照，重建之後補不回來。所以這裡做的是就地編輯，
   * 不是「刪除再新增」的包裝。
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 扣款歷史：正在填實際入帳金額的那一筆，以及輸入中的值。 */
  const [charges, setCharges] = useState(initialCharges);
  const [reconId, setReconId] = useState<number | null>(null);
  const [reconVal, setReconVal] = useState("");

  /** 每月等值的台幣金額。年繳先除 12，否則加總會把一筆年繳當成十二倍。 */
  const toTwd = (r: Row) => {
    const perMonth = monthlyEquivalent(Number(r.fee) || 0, r.billing_cycle);
    return r.currency === "TWD" ? perMonth : perMonth * fx;
  };
  const active = rows.filter((r) => r.status === "active");
  const monthlyTwd = active.reduce((s, r) => s + toTwd(r), 0);

  /**
   * 扣款歷史的三個數字（2026-08-24，C-13）。
   *
   * `chargeTotalTwd` 是帳面：把每一筆凍結好的 `amount_twd` 加起來，不重算。
   * `chargeTotalAtToday` 只用來對照——**同樣的手續費率**、只把匯率換成今天的，
   * 這樣差額才乾淨地只反映匯率，不會混進手續費調整。
   * 兩者的差就是「如果當初沒有凍結，帳面現在會被改寫多少」。
   */
  const chargeTotalTwd = charges.reduce((sum, c) => sum + Number(c.amount_twd), 0);
  const chargeTotalAtToday = charges.reduce((sum, c) => {
    if (c.currency === "TWD") return sum + Number(c.fee);
    return sum + Number(c.fee) * fxBase * (1 + Number(c.markup_pct) / 100);
  }, 0);
  const driftTwd = chargeTotalAtToday - chargeTotalTwd;

  /**
   * 從已對帳的紀錄反推「這張卡真實的外幣交易成本」（2026-08-25，D-2）。
   *
   * 算式：實際入帳 ÷（原幣金額 × 當時牌告匯率）− 1。
   * 這個比率涵蓋的不只是銀行手續費，還包含「發卡組織匯率與牌告匯率的差」，
   * 兩者分不開也不需要分開——要的是「刷一筆美金，台幣實際會被扣多少」。
   *
   * 只取非台幣、已對帳、匯率為正的紀錄。台幣扣款沒有換匯，放進來會把平均拉低。
   */
  const reconciled = charges.filter(
    (c) => c.currency !== "TWD" && c.actual_twd != null && Number(c.fx_rate) > 0
  );
  const impliedMarkupPct =
    reconciled.length === 0
      ? null
      : (reconciled.reduce((sum, c) => {
          const base = Number(c.fee) * Number(c.fx_rate);
          return sum + (Number(c.actual_twd) / base - 1);
        }, 0) /
          reconciled.length) *
        100;
  const assumedMarkupPct = charges.length > 0 ? Number(charges[0].markup_pct) : null;

  /** 填入（或清除）某一筆的實際入帳金額。 */
  async function saveActual(id: number, value: string) {
    setError(null);
    try {
      const res = await fetch(`/api/subscription-charges/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actualTwd: value.trim() === "" ? null : value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `對帳失敗（${res.status}）`);
        return;
      }
      setCharges((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, actual_twd: data.charge.actual_twd, reconciled_at: data.charge.reconciled_at }
            : c
        )
      );
      setReconId(null);
      router.refresh();
    } catch {
      setError("對帳請求失敗");
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!service.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: service.trim(),
          plan: plan.trim() || undefined,
          fee,
          billingCycle: cycle,
          billingMonth: cycle === "yearly" ? Number(month) : undefined,
          currency,
          billingDay: day,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `新增失敗（${res.status}）`);
        return;
      }
      setRows((p) => [...p, data.subscription]);
      setService("");
      setPlan("");
      setFee("");
      setDay("1");
      router.refresh();
    } catch {
      setError("網路請求失敗");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: Row) {
    setError(null);
    setEditingId(row.id);
    setDraft({
      service: row.service,
      plan: row.plan ?? "",
      fee: String(row.fee),
      currency: row.currency,
      cycle: row.billing_cycle,
      day: String(row.billing_day),
      month: String(row.billing_month ?? 1),
      note: row.note ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setError(null);
  }

  async function saveEdit(id: number) {
    if (!draft) return;
    if (!draft.service.trim()) {
      setError("服務名稱不可以是空的");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/subscriptions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: draft.service.trim(),
          plan: draft.plan.trim(),
          fee: draft.fee,
          currency: draft.currency,
          // 週期一定要送：後端收到它才會把月繳的 billing_month 清成 null，
          // 否則從年繳改月繳會留下一個沒有意義的月份，違反資料表的一致性約束。
          billingCycle: draft.cycle,
          ...(draft.cycle === "yearly" ? { billingMonth: Number(draft.month) } : {}),
          billingDay: draft.day,
          note: draft.note,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `儲存失敗（${res.status}）`);
        return;
      }
      setRows((p) => p.map((r) => (r.id === id ? data.subscription : r)));
      setEditingId(null);
      setDraft(null);
      router.refresh();
    } catch {
      setError("網路請求失敗");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: Row) {
    const next = row.status === "active" ? "cancelled" : "active";
    const res = await fetch(`/api/subscriptions/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      const data = await res.json();
      setRows((p) => p.map((r) => (r.id === row.id ? data.subscription : r)));
      router.refresh();
    }
  }

  async function remove(row: Row) {
    // 刪除會連 subscription_charges 的歷史扣款一起 CASCADE 掉，而且匯率快照補不回來。
    // 有了編輯功能之後，「要改資料」不再需要走刪除，所以這裡擋一次不算擾民。
    if (!window.confirm(`刪除「${row.service}」會連同它的扣款紀錄一起刪掉，且無法復原。確定嗎？`)) {
      return;
    }
    const res = await fetch(`/api/subscriptions/${row.id}`, { method: "DELETE" });
    if (res.ok) {
      setRows((p) => p.filter((r) => r.id !== row.id));
      router.refresh();
    }
  }

  return (
    <>
      <section className="block">
        <div className="ledger-strip">
          <div className="ledger-cell">
            <span className="microlabel">每月訂閱總支出 · Fixed</span>
            <div className="hero-figure">
              <span className="unit">NT$ </span>
              {Math.round(monthlyTwd).toLocaleString("zh-TW")}
            </div>
            <div className="ledger-note">
              {active.length} 個使用中訂閱（匯率 {fx}）
            </div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">年度預估</span>
            <div className="stat-figure">
              <span className="unit">NT$ </span>
              {Math.round(monthlyTwd * 12).toLocaleString("zh-TW")}
            </div>
            <div className="ledger-note">以目前使用中的訂閱推估</div>
          </div>
          <div className="ledger-cell">
            <span className="microlabel">已停用</span>
            <div className="stat-figure">{rows.length - active.length}</div>
            <div className="ledger-note">保留紀錄，不列入計算</div>
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">新增訂閱</span>
            <span className="microlabel">月繳或年繳的固定費用帳號</span>
          </div>
          <form onSubmit={create} className="sub-form">
            <label>
              服務名稱
              <input
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="例：Claude Max"
              />
            </label>
            <label>
              方案（選填）
              <input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="例：20x" />
            </label>
            <label>
              計費週期
              <select
                value={cycle}
                onChange={(e) => setCycle(e.target.value as "monthly" | "yearly")}
              >
                <option value="monthly">月繳</option>
                <option value="yearly">年繳</option>
              </select>
            </label>
            <label>
              {cycle === "yearly" ? "年費" : "月費"}
              <input
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                placeholder={cycle === "yearly" ? "1200" : "100"}
                inputMode="decimal"
              />
            </label>
            <label>
              幣別
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="USD">USD</option>
                <option value="TWD">TWD</option>
              </select>
            </label>
            {cycle === "yearly" && (
              <label>
                扣款月份
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {m} 月
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              扣款日
              <input
                value={day}
                onChange={(e) => setDay(e.target.value)}
                inputMode="numeric"
                placeholder="1"
              />
            </label>
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "新增中…" : "新增訂閱"}
            </button>
          </form>
          {error && <div className="form-error">{error}</div>}
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">訂閱清單</span>
            <span className="microlabel">{rows.length} 筆</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              尚未登記訂閱帳號，請用上方表單新增。
            </div>
          ) : (
            <table className="ledger">
              <tbody>
                {rows.map((r) =>
                  editingId === r.id && draft ? (
                    // 編輯中的那一列整列換成表單。用 colSpan 而不是逐格塞 input，
                    // 是因為欄位數比表格欄數多，硬塞會把金額那一欄擠到看不出對齊。
                    <tr key={r.id}>
                      <td colSpan={4}>
                        <form
                          className="sub-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveEdit(r.id);
                          }}
                        >
                          <label>
                            服務名稱
                            <input
                              value={draft.service}
                              onChange={(e) => setDraft({ ...draft, service: e.target.value })}
                            />
                          </label>
                          <label>
                            方案（選填）
                            <input
                              value={draft.plan}
                              onChange={(e) => setDraft({ ...draft, plan: e.target.value })}
                            />
                          </label>
                          <label>
                            計費週期
                            <select
                              value={draft.cycle}
                              onChange={(e) =>
                                setDraft({ ...draft, cycle: e.target.value as "monthly" | "yearly" })
                              }
                            >
                              <option value="monthly">月繳</option>
                              <option value="yearly">年繳</option>
                            </select>
                          </label>
                          <label>
                            {draft.cycle === "yearly" ? "年費" : "月費"}
                            <input
                              value={draft.fee}
                              inputMode="decimal"
                              onChange={(e) => setDraft({ ...draft, fee: e.target.value })}
                            />
                          </label>
                          <label>
                            幣別
                            <select
                              value={draft.currency}
                              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                            >
                              <option value="USD">USD</option>
                              <option value="TWD">TWD</option>
                            </select>
                          </label>
                          {draft.cycle === "yearly" && (
                            <label>
                              扣款月份
                              <select
                                value={draft.month}
                                onChange={(e) => setDraft({ ...draft, month: e.target.value })}
                              >
                                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                                  <option key={m} value={m}>
                                    {m} 月
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label>
                            扣款日
                            <input
                              value={draft.day}
                              inputMode="numeric"
                              onChange={(e) => setDraft({ ...draft, day: e.target.value })}
                            />
                          </label>
                          <label>
                            備註（選填）
                            <input
                              value={draft.note}
                              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                            />
                          </label>
                          <button className="btn-primary" type="submit" disabled={busy}>
                            {busy ? "儲存中…" : "儲存"}
                          </button>
                          <button className="btn-ghost" type="button" onClick={cancelEdit}>
                            取消
                          </button>
                        </form>
                      </td>
                    </tr>
                  ) : (
                  <tr key={r.id} style={r.status !== "active" ? { opacity: 0.5 } : undefined}>
                    <td className="t-name">
                      {r.service}
                      {r.plan ? ` · ${r.plan}` : ""}
                      <small>
                        {r.billing_cycle === "yearly"
                          ? `每年 ${r.billing_month ?? 1} 月 ${r.billing_day} 日扣款`
                          : `每月 ${r.billing_day} 日扣款`}
                        {r.status === "active" ? ` · 下次 ${nextBilling(r)}` : " · 已停用"}
                        {r.note ? ` · ${r.note}` : ""}
                      </small>
                    </td>
                    <td className="t-kind k-sub">
                      〔{r.currency}〕<small>{CYCLE_TEXT[r.billing_cycle]}</small>
                    </td>
                    <td className="t-amt">
                      {r.currency === "USD" ? "US$" : "NT$"}
                      {Number(r.fee).toLocaleString("zh-TW")}
                      <small>
                        {r.billing_cycle === "yearly" ? "／年 · 折合 " : ""}
                        NT$ {Math.round(toTwd(r)).toLocaleString("zh-TW")}／月
                      </small>
                    </td>
                    <td className="t-amt" style={{ whiteSpace: "nowrap" }}>
                      <button className="btn-ghost" type="button" onClick={() => startEdit(r)}>
                        編輯
                      </button>{" "}
                      <button className="btn-ghost" type="button" onClick={() => toggle(r)}>
                        {r.status === "active" ? "停用" : "啟用"}
                      </button>{" "}
                      <button className="btn-ghost" type="button" onClick={() => remove(r)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                  )
                )}
              </tbody>
            </table>
          )}
          {/* 中文段落一律用字串串接，不要讓 JSX 直接吃多行文字——
              原始碼的換行在 JSX 裡會變成一個半形空格，中文句子中間就會冒出
              莫名的空白（2026-08-24 在正式站上看到才發現）。 */}
          <div className="panel-foot">
            {"改月費、改扣款日請按「編輯」，不要刪掉重建——刪除會連同這筆訂閱的" +
              "歷史扣款紀錄一起消失，而那裡面存的是扣款當下的匯率快照，補不回來。" +
              "訂閱是固定費用，不隨用量變動，所以與 API 成本分開統計。" +
              "年繳的金額已折合成每月等值後才加總，避免一筆年繳被當成十二倍。" +
              "這些帳號實際消耗多少 token，請看「遙測」頁。"}
          </div>
        </div>
      </section>

      <section className="block tight">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">扣款歷史</span>
            <span className="microlabel">匯率已凍結，不隨今日匯率變動</span>
          </div>

          {charges.length === 0 ? (
            <div className="empty-state">
              <span className="microlabel">Empty</span>
              {"還沒有任何已發生的扣款紀錄。每天早上抓匯率時會檢查有沒有訂閱在當天扣款，" +
                "有的話就把當天的匯率連同金額一起凍結寫進這裡，之後不再重算。" +
                "第一筆會在最近一個扣款日出現。"}
            </div>
          ) : (
            <>
              <div className="ledger-strip">
                <div className="ledger-cell">
                  <span className="microlabel">已發生扣款合計 · 依當時匯率</span>
                  <div className="hero-figure">
                    <span className="unit">NT$ </span>
                    {Math.round(chargeTotalTwd).toLocaleString("zh-TW")}
                  </div>
                  <div className="ledger-note">
                    {`${charges.length} 筆，最新在 ${charges[0].charged_on}`}
                  </div>
                </div>
                <div className="ledger-cell">
                  <span className="microlabel">若全部用今日匯率重算</span>
                  <div className="stat-figure">
                    <span className="unit">NT$ </span>
                    {Math.round(chargeTotalAtToday).toLocaleString("zh-TW")}
                  </div>
                  <div className="ledger-note">
                    {driftTwd === 0
                      ? "與帳面相同"
                      : `帳面會被改寫 ${driftTwd > 0 ? "＋" : "－"}NT$${Math.abs(
                          Math.round(driftTwd)
                        ).toLocaleString("zh-TW")}`}
                    {/* 匯率的日期與新鮮度放在這裡，因為這一格是唯一用到「今日匯率」的地方。
                        超過兩天沒更新是真的警訊——拿三天前的匯率當今天算，差額會失真。 */}
                    <br />
                    <span className="microlabel">
                      今日匯率 {fxBase.toFixed(4)} · {fxDay ?? "無資料"}
                      {fxStale ? " · 已超過兩天沒更新" : ""}
                    </span>
                  </div>
                </div>
                <div className="ledger-cell">
                  <span className="microlabel">實際手續費率 · 反推</span>
                  <div className="stat-figure">
                    {impliedMarkupPct === null ? "—" : `${impliedMarkupPct.toFixed(2)}%`}
                  </div>
                  <div className="ledger-note">
                    {impliedMarkupPct === null
                      ? `尚未對帳，目前用假設值 ${assumedMarkupPct ?? "—"}%`
                      : `${reconciled.length} 筆已對帳 · 假設值 ${assumedMarkupPct ?? "—"}%`}
                  </div>
                </div>
              </div>

              <table className="ledger">
                <thead>
                  <tr>
                    <th>扣款日</th>
                    <th>服務</th>
                    <th>原幣金額</th>
                    <th>凍結匯率</th>
                    <th>台幣金額 · 預期</th>
                    <th>實際入帳</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((c) => {
                    const rate = Number(c.fx_rate);
                    const markup = Number(c.markup_pct);
                    const isTwd = c.currency === "TWD";
                    return (
                      <tr key={c.id}>
                        <td>{c.charged_on}</td>
                        <td>{c.service}</td>
                        <td>
                          {c.currency} {Number(c.fee).toLocaleString("zh-TW")}
                        </td>
                        <td>
                          {isTwd ? (
                            <span className="microlabel">本幣，不換匯</span>
                          ) : (
                            <>
                              {rate.toFixed(4)}
                              <span className="microlabel">
                                {" "}
                                ＋{markup}% 手續費 · {c.fx_source}
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          {/* 金額固定兩位小數。toLocaleString 預設會把 3166.80 印成
                              3,166.8，看起來像少了一位——帳目數字不該有這種歧義。 */}
                          NT$ {Number(c.amount_twd).toLocaleString("zh-TW", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td>
                          {reconId === c.id ? (
                            <form
                              style={{ display: "inline-flex", gap: "0.4rem" }}
                              onSubmit={(e) => {
                                e.preventDefault();
                                saveActual(c.id, reconVal);
                              }}
                            >
                              <input
                                autoFocus
                                value={reconVal}
                                onChange={(e) => setReconVal(e.target.value)}
                                placeholder="帳單金額"
                                inputMode="decimal"
                                style={{ width: "7rem" }}
                              />
                              <button className="btn-ghost" type="submit">
                                存
                              </button>
                              <button
                                className="btn-ghost"
                                type="button"
                                onClick={() => setReconId(null)}
                              >
                                取消
                              </button>
                            </form>
                          ) : c.actual_twd == null ? (
                            <button
                              className="btn-ghost"
                              type="button"
                              onClick={() => {
                                setReconId(c.id);
                                setReconVal("");
                              }}
                            >
                              對帳
                            </button>
                          ) : (
                            <button
                              className="btn-ghost"
                              type="button"
                              title="點一下可修改或清除"
                              onClick={() => {
                                setReconId(c.id);
                                setReconVal(String(c.actual_twd));
                              }}
                            >
                              NT${" "}
                              {Number(c.actual_twd).toLocaleString("zh-TW", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                              <span className="microlabel">
                                {" "}
                                差 {diffLabel(c)}
                              </span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          <div className="panel-foot">
            {"這張表是「已經發生的事」，上面的每月總支出是「還沒發生的預估」，兩者用的匯率不同，" +
              "這是刻意的。已發生的扣款用當時匯率，寫進去就不再重算——不這樣做的話，" +
              "回頭看上個月的台幣金額會被這個月的匯率改寫，跟信用卡帳單永遠對不起來，" +
              "而且對不起來時分不清是匯率造成的還是漏記造成的。" +
              "「若全部用今日匯率重算」那一格只是拿來看差多少，不是帳面數字。" +
              "手續費是國外交易手續費，預設 1.5%，實際依發卡行調整，在本頁最下方可改。"}
          </div>
        </div>
      </section>
    </>
  );
}

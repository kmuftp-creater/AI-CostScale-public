"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

const OPTIONS = [
  { value: "this", label: "本月" },
  { value: "last", label: "上月" },
] as const;

/**
 * 會依日期參數改變內容的頁面（2026-08-26）。
 *
 * 這個選單掛在頁首、每一頁都看得到，但**只有這些頁面真的會讀它**。
 * 在其他頁面按下去，網址會變、按鈕會亮，畫面上的數字卻一動也不動——
 * User 回報的「日期無反應」有一半是這個。
 *
 * 名單放在選單自己身上而不是散到各頁：「哪些頁面吃這個參數」是選單的事，
 * 散出去會漏掉新頁面。
 */
const RANGE_AWARE = ["/billing", "/channels", "/apps", "/projects"];

/** 與 lib/range.ts 的 MAX_DAYS 一致。改一邊記得改另一邊。 */
const MAX_DAYS = 366;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DateRangeSeg() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const wrapRef = useRef<HTMLDivElement>(null);

  const qsFrom = searchParams.get("from") ?? "";
  const qsTo = searchParams.get("to") ?? "";
  const isCustom = qsFrom !== "" || qsTo !== "";
  const current = isCustom ? "custom" : searchParams.get("range") === "last" ? "last" : "this";

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(qsFrom || todayISO().slice(0, 8) + "01");
  const [to, setTo] = useState(qsTo || todayISO());
  const [error, setError] = useState<string | null>(null);

  // 面板打開時點到外面就收起來。不加這個的話，選完日期再去按別的東西，
  // 面板會一直蓋在畫面上。
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const aware = pathname === "/" || RANGE_AWARE.some((r) => pathname.startsWith(r));

  function go(next: URLSearchParams) {
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function pick(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    // 切回本月／上月時一定要把自訂的兩個參數清掉，
    // 否則 from/to 還在，解析器會繼續當成自訂區間。
    params.delete("from");
    params.delete("to");
    if (value === "this") params.delete("range");
    else params.set("range", value);
    setOpen(false);
    go(params);
  }

  function applyCustom() {
    if (!from || !to) {
      setError("兩個日期都要填");
      return;
    }
    if (to < from) {
      setError("結束日不能早於開始日");
      return;
    }
    const days =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (days > MAX_DAYS) {
      setError(`最多 ${MAX_DAYS} 天，這個區間有 ${days} 天`);
      return;
    }
    setError(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("range");
    params.set("from", from);
    params.set("to", to);
    setOpen(false);
    go(params);
  }

  // 管不到的頁面直接不渲染。回傳 null 而不是 disabled：
  // 一顆灰掉的按鈕仍然在說「這裡有個功能」，而這裡沒有。
  if (!aware) return null;

  return (
    <div className="seg-wrap" ref={wrapRef}>
      <div className="seg" role="group" aria-label="日期區間">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={current === opt.value}
            onClick={() => pick(opt.value)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={current === "custom"}
          aria-expanded={open}
          onClick={() => {
            setError(null);
            setOpen((v) => !v);
          }}
        >
          自訂
        </button>
      </div>

      {open ? (
        <div className="seg-pop" role="dialog" aria-label="自訂日期區間">
          <label className="seg-pop-field">
            <span>開始</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="seg-pop-field">
            <span>結束</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="seg-pop-note">兩端都包含在內，最多 {MAX_DAYS} 天。</div>
          {error ? <div className="seg-pop-error">{error}</div> : null}
          <div className="seg-pop-actions">
            {isCustom ? (
              <button type="button" className="btn-ghost" onClick={() => pick("this")}>
                清除
              </button>
            ) : null}
            <button type="button" className="btn-primary" onClick={applyCustom}>
              套用
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

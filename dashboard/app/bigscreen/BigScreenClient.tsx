"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as echarts from "echarts/core";
import { LineChart, PieChart, GaugeChart, BarChart, LinesChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkPointComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { BigScreenData } from "@/lib/bigscreen";

echarts.use([LineChart, PieChart, GaugeChart, BarChart, LinesChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkPointComponent, SVGRenderer]);

/**
 * 營運大屏的畫面（2026-09-12）。預覽頁定稿之後搬進來，資料改成即時。
 *
 * - 1920×1080 設計，依視窗寬度等比縮放（大屏範本的標準做法）。
 * - 每 60 秒 router.refresh() 重新查一次。
 * - 動態效果可以在頁首切換：跟隨系統／開／關，存在這台電腦。
 *   User 2026-09-12：「設定有可以關閉減少動態效果的功能嗎？」——原本只跟著作業系統。
 * - 模型用藍紫色階（依流量由亮到暗）。2026-09-12 User 問「沒有藍紫色是因為最初的設計說不要的嗎？
 *   看久了沒有科幻的感覺」——8/19 否決紫色的是儀表板，大屏這裡改回藍紫。色階用 dataviz 驗證器跑過 ordinal 檢查。
 */

const MODEL_RAMP = ["#e8e2ff", "#bfb0ff", "#9a85ff", "#735ae8"];
const VIOLET = "#9a85ff";
const FAIL = "#c2414f";
const GRAY = "#56699a";
const C = { cy: "#22d3ee", good: "#2ee6a6", warn: "#ffb72b", crit: "#ff4d5e", ink: "#e2f1ff", ink2: "#a3c0ea", muted: "#6484b8", grid: "rgba(47,123,255,0.18)" };
const TIP = { backgroundColor: "rgba(4,20,60,0.94)", borderColor: "#1f6ad8", borderWidth: 1, textStyle: { color: C.ink, fontSize: 13 } };
const G = echarts.graphic.LinearGradient;
type Motion = "system" | "on" | "off";
const MOTION_KEY = "costscale-bigscreen-motion";

const tint = (hex: string, t: number) => {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0");
  return "#" + m(r) + m(g) + m(b);
};
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/** 翻牌數字。value 變了才捲；停止用經過的時間，不用跳動次數（背景分頁會放慢計時器）。 */
function Digits({ value, still, prefix, suffix }: { value: string; still: boolean; prefix?: string; suffix?: string }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (still) { setShown(value); return; }
    const chars = value.split("");
    const locked = chars.map(() => false);
    const iv = setInterval(() => {
      setShown(chars.map((c, i) => (locked[i] || !/\d/.test(c) ? c : String(Math.floor(Math.random() * 10)))).join(""));
    }, 55);
    const timers = chars.map((_, i) => setTimeout(() => { locked[i] = true; }, 450 + i * 70));
    const done = setTimeout(() => { clearInterval(iv); setShown(value); }, 450 + chars.length * 70 + 60);
    return () => { clearInterval(iv); timers.forEach(clearTimeout); clearTimeout(done); };
  }, [value, still]);
  return (
    <span className="bs-digits">
      {prefix ? <u>{prefix}</u> : null}
      {shown.split("").map((c, i) => (/\d/.test(c) ? <b key={i}>{c}</b> : <s key={i}>{c}</s>))}
      {suffix ? <u>{suffix}</u> : null}
    </span>
  );
}

function Box({ acc, title, note, src, idx, children, className = "" }: {
  acc: string; title: string; note?: string; src?: string; idx: number; children: React.ReactNode; className?: string;
}) {
  const style = { "--acc": acc, "--dur": `${7 + ((idx * 37) % 6)}s`, "--delay": `${-((idx * 1.7) % 7).toFixed(1)}s` } as React.CSSProperties;
  return (
    <section className={`bs-box ${src ? "bs-has-foot" : ""} ${className}`} style={style}>
      <div className="bs-bt"><i /><span>{title}</span>{note ? <em>{note}</em> : null}</div>
      <div className="bs-bc">{children}</div>
      {src ? <div className="bs-foot"><span className="bs-ticks" /><span className="bs-hud">{src}</span></div> : null}
    </section>
  );
}

export default function BigScreenClient({ data, numFont }: { data: BigScreenData; numFont: string }) {
  const router = useRouter();
  const vpRef = useRef<HTMLDivElement>(null);
  const stRef = useRef<HTMLDivElement>(null);
  const els = {
    daily: useRef<HTMLDivElement>(null), mix: useRef<HTMLDivElement>(null), free: useRef<HTMLDivElement>(null),
    topo: useRef<HTMLDivElement>(null), hour: useRef<HTMLDivElement>(null), apps: useRef<HTMLDivElement>(null),
  };
  const charts = useRef<Record<string, echarts.ECharts>>({});
  const [clock, setClock] = useState("--:--:--");
  const [dateLabel, setDateLabel] = useState("");
  const [motion, setMotion] = useState<Motion>("system");
  const [sysReduce, setSysReduce] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const still = motion === "off" || (motion === "system" && sysReduce);
  const FX = data.fx.rate;

  // ── 縮放（最先做：頁面高度靠它）──
  useEffect(() => {
    const fit = () => {
      const vp = vpRef.current, st = stRef.current;
      if (!vp || !st) return;
      const s = vp.clientWidth / 1920;
      st.style.transform = `scale(${s})`;
      vp.style.height = `${1080 * s}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // ── 動態偏好、系統設定、全螢幕狀態 ──
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MOTION_KEY);
      if (saved === "on" || saved === "off") setMotion(saved);
    } catch { /* 無痕視窗讀不到就用預設 */ }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSysReduce(mq.matches);
    const onMq = (e: MediaQueryListEvent) => setSysReduce(e.matches);
    mq.addEventListener("change", onMq);
    const onFs = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => { mq.removeEventListener("change", onMq); document.removeEventListener("fullscreenchange", onFs); };
  }, []);
  const chooseMotion = (m: Motion) => {
    setMotion(m);
    try { if (m === "system") localStorage.removeItem(MOTION_KEY); else localStorage.setItem(MOTION_KEY, m); } catch { /* 忽略 */ }
  };

  // ── 時鐘與自動更新 ──
  useEffect(() => {
    const wk = ["日", "一", "二", "三", "四", "五", "六"];
    const tick = () => {
      const tp = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
      setClock(tp.toTimeString().slice(0, 8));
      setDateLabel(`${tp.getFullYear()}-${String(tp.getMonth() + 1).padStart(2, "0")}-${String(tp.getDate()).padStart(2, "0")} 星期${wk[tp.getDay()]}`);
    };
    tick();
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(() => router.refresh(), 60_000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [router]);

  // ── 圖表：建立一次，資料或動態設定變了就整份重畫 ──
  useEffect(() => {
    let cancelled = false;
    const draw = () => {
    const init = (k: keyof typeof els) => {
      const el = els[k].current;
      if (!el) return null;
      if (!charts.current[k]) charts.current[k] = echarts.init(el, null, { renderer: "svg" });
      return charts.current[k];
    };
    const appColor = new Map(data.apps.map((a) => [a.name, a.color]));
    const modelColor = (name: string, kind: string, i: number) => (kind === "fail" ? FAIL : kind === "other" ? GRAY : MODEL_RAMP[Math.min(i, 3)]);

    // 每日花費
    const daily = data.daily;
    const dMax = Math.max(0.1, ...daily.map((d) => d.usd));
    init("daily")?.setOption({
      grid: { left: 58, right: 22, top: 30, bottom: 30 },
      tooltip: { ...TIP, trigger: "axis", formatter: (p: { dataIndex: number }[]) => { const d = daily[p[0].dataIndex]; return `${d.day}<br/><b style="font-size:15px">US$${d.usd.toFixed(4)}</b><br/>約 NT$${fmtInt(d.usd * FX)} · ${d.calls} 次呼叫`; } },
      xAxis: { type: "category", data: daily.map((d) => d.day), boundaryGap: false, axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.muted, interval: 5, fontSize: 12 } },
      yAxis: { type: "value", max: Math.ceil(dMax * 1.15 * 10) / 10, splitNumber: 4, splitLine: { lineStyle: { color: C.grid, type: "dashed" } }, axisLabel: { color: C.muted, fontSize: 12, formatter: (v: number) => (v ? "$" + v.toFixed(2) : "0") } },
      series: [{
        type: "line", smooth: true, showSymbol: false, data: daily.map((d) => d.usd),
        lineStyle: { width: 2.5, color: new G(0, 0, 1, 0, [{ offset: 0, color: "#4b88fd" }, { offset: 0.55, color: C.cy }, { offset: 1, color: VIOLET }]), shadowColor: "rgba(124,92,255,0.7)", shadowBlur: 12 },
        itemStyle: { color: C.cy },
        areaStyle: { color: new G(0, 0, 0, 1, [{ offset: 0, color: "rgba(34,211,238,0.45)" }, { offset: 0.7, color: "rgba(75,136,253,0.10)" }, { offset: 1, color: "rgba(75,136,253,0)" }]) },
        markPoint: { symbol: "pin", symbolSize: 44, itemStyle: { color: C.warn }, label: { color: "#1a1200", fontSize: 11, fontWeight: 700, formatter: "高點" }, data: [{ type: "max" }] },
      }],
    }, true);

    // 模型用量
    let mi = 0;
    const mix = data.models.map((m) => {
      const col = modelColor(m.name, m.kind, m.kind === "model" ? mi++ : 0);
      return { name: m.name, value: m.calls, col, itemStyle: { color: new G(0, 0, 1, 1, [{ offset: 0, color: tint(col, 0.25) }, { offset: 1, color: col }]) } };
    });
    init("mix")?.setOption({
      tooltip: { ...TIP, trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/><b>${fmtInt(p.value)} 次</b>（${p.percent}%）` },
      legend: { orient: "vertical", right: 12, top: "middle", itemWidth: 10, itemHeight: 10, itemGap: 13, textStyle: { color: C.ink2, fontSize: 13 },
        data: mix.map((m) => ({ name: m.name, itemStyle: { color: m.col } })),
        formatter: (n: string) => `${n}  ${fmtInt(mix.find((m) => m.name === n)?.value ?? 0)}` },
      title: { text: fmtInt(data.month.calls), subtext: "本月呼叫", left: "24%", top: "40%", textAlign: "center",
        textStyle: { color: "#fff", fontFamily: numFont, fontSize: 24, fontWeight: 700 }, subtextStyle: { color: C.muted, fontSize: 12 } },
      series: [
        { type: "pie", radius: ["59%", "63%"], center: ["24%", "52%"], silent: true, label: { show: false }, data: [{ value: 1, itemStyle: { color: "rgba(154,133,255,0.32)" } }] },
        { type: "pie", radius: ["42%", "56%"], center: ["24%", "52%"], padAngle: 2, itemStyle: { borderColor: "#041a4a", borderWidth: 2 }, label: { show: false }, data: mix },
      ],
    }, true);

    // 免費額度
    const pools = data.pools.slice(0, 3);
    init("free")?.setOption({
      series: pools.map((p, i) => {
        const max = p.limit ?? Math.max(1, p.used);
        return {
          type: "gauge", center: [`${pools.length === 1 ? 50 : 17 + i * (66 / Math.max(1, pools.length - 1))}%`, "50%"], radius: "56%",
          startAngle: 90, endAngle: -270, min: 0, max,
          pointer: { show: false }, progress: { show: true, roundCap: true, width: 10, itemStyle: { color: new G(0, 0, 1, 1, [{ offset: 0, color: C.good }, { offset: 1, color: C.cy }]) } },
          axisLine: { lineStyle: { width: 10, color: [[1, "rgba(46,230,166,0.16)"]] } },
          axisTick: { show: true, distance: -22, length: 4, splitNumber: 3, lineStyle: { color: "rgba(46,230,166,0.35)" } },
          splitLine: { show: false }, axisLabel: { show: false },
          title: { offsetCenter: [0, "118%"], color: C.ink2, fontSize: 13 },
          detail: { offsetCenter: [0, "-4%"], formatter: (v: number) => `{a|${v}}\n{b|/ ${p.limit ?? "未設"} 次}`,
            rich: { a: { fontFamily: numFont, fontSize: 26, fontWeight: 700, color: "#fff" }, b: { fontSize: 12, color: C.muted, padding: [4, 0, 0, 0] } } },
          data: [{ value: p.used, name: `${p.name}（${p.keys} 把）` }],
        };
      }),
    }, true);

    // 流量拓撲
    const leftApps = data.apps.slice(0, 8);
    const hub = [50, 50];
    const yAt = (i: number, n: number) => (n <= 1 ? 50 : 92 - (i * 84) / (n - 1));
    const w = (c: number) => (c ? 1.2 + Math.log10(c + 1) * 2.3 : 0);
    const nodes: object[] = [];
    const series: object[] = [];
    leftApps.forEach((a, i) => {
      const p = [8, yAt(i, leftApps.length)];
      nodes.push({ name: a.name, value: p, symbolSize: a.calls ? 11 + Math.log10(a.calls + 1) * 5 : 8,
        itemStyle: { color: a.idle ? "#3a4a72" : a.color, borderColor: tint(a.color, 0.5), borderWidth: 2, shadowBlur: a.calls ? 14 : 0, shadowColor: a.color },
        label: { show: true, position: "left", distance: 10, color: a.calls ? C.ink : C.muted, fontSize: 13.5,
          formatter: `{n|${a.name}}  {c|${a.calls ? fmtInt(a.calls) : "閒置"}}`,
          rich: { n: { fontSize: 13.5 }, c: { fontFamily: numFont, fontSize: 12, color: a.calls ? tint(a.color, 0.35) : C.muted } } } });
      if (a.calls) series.push({ type: "lines", coordinateSystem: "cartesian2d", zlevel: 1,
        lineStyle: { curveness: 0.18, opacity: 0.8, width: w(a.calls), color: new G(0, 0, 1, 0, [{ offset: 0, color: a.color }, { offset: 1, color: VIOLET }]) },
        effect: { show: !still, period: 3.2, trailLength: 0.4, symbol: "circle", symbolSize: 5, color: tint(a.color, 0.55) },
        data: [{ coords: [p, hub], value: a.calls, name: a.name }] });
    });
    let ri = 0;
    const mLines: object[] = [];
    data.models.forEach((m, i) => {
      const col = modelColor(m.name, m.kind, m.kind === "model" ? ri++ : 0);
      const p = [92, yAt(i, data.models.length)];
      nodes.push({ name: m.name, value: p, symbolSize: 11 + Math.log10(m.calls + 1) * 5,
        itemStyle: { color: col, shadowBlur: m.kind === "model" ? 14 : 0, shadowColor: col },
        label: { show: true, position: "right", distance: 10, color: m.kind === "other" ? C.muted : C.ink, fontSize: 13.5,
          formatter: `{c|${fmtInt(m.calls)}}  {n|${m.name}}`,
          rich: { n: { fontSize: 13.5 }, c: { fontFamily: numFont, fontSize: 12, color: col } } } });
      mLines.push({ coords: [hub, p], value: m.calls, name: m.name, lineStyle: { width: w(m.calls), color: new G(0, 0, 1, 0, [{ offset: 0, color: VIOLET }, { offset: 1, color: col }]) } });
    });
    series.push({ type: "lines", coordinateSystem: "cartesian2d", zlevel: 1, lineStyle: { curveness: 0.18, opacity: 0.7 },
      effect: { show: !still, period: 3.2, trailLength: 0.4, symbol: "circle", symbolSize: 5, color: "#f1edff" }, data: mLines });
    series.push({ type: "scatter", coordinateSystem: "cartesian2d", zlevel: 2, data: nodes });
    init("topo")?.setOption({
      // 上下、左右都對稱：閘道（座標 50,50）才會落在容器正中央，跟 CSS 的投影台對齊
      grid: { left: 190, right: 190, top: 34, bottom: 34 },
      xAxis: { type: "value", min: 0, max: 100, show: false }, yAxis: { type: "value", min: 0, max: 100, show: false },
      tooltip: { ...TIP, trigger: "item", formatter: (p: { seriesType: string; name: string; data: { name: string; value: number } }) =>
        p.seriesType === "lines" ? `${p.data.name}<br/><b>${fmtInt(p.data.value)} 次</b>` : p.name },
      series,
    }, true);

    // 近 24 小時每小時（2026-09-12：原本是「今日」，午夜一過就是空的）
    const hourRows = data.hourly;
    const hours = hourRows.map((r) => r.calls);
    const peakH = hours.indexOf(Math.max(...hours));
    const hMax = Math.max(5, ...hours);
    init("hour")?.setOption({
      grid: { left: 46, right: 20, top: 26, bottom: 30 },
      tooltip: { ...TIP, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(46,230,166,0.08)" } }, formatter: (p: { dataIndex: number; value: number }[]) => `${hourRows[p[0].dataIndex].tip}<br/><b>${p[0].value} 次</b>` },
      xAxis: { type: "category", data: hourRows.map((r) => r.label), axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 12, interval: 2 } },
      yAxis: { type: "value", max: Math.ceil(hMax * 1.25), splitNumber: 4, splitLine: { lineStyle: { color: C.grid, type: "dashed" } }, axisLabel: { color: C.muted, fontSize: 12 } },
      series: [{
        type: "bar", barWidth: 16,
        data: hours.map((v, h) => ({ value: v, itemStyle: { color: h === peakH && v > 0
          ? new G(0, 0, 0, 1, [{ offset: 0, color: "#ffd66b" }, { offset: 1, color: "rgba(255,154,61,0.2)" }])
          : new G(0, 0, 0, 1, [{ offset: 0, color: "#7ff5c8" }, { offset: 0.5, color: C.good }, { offset: 1, color: "rgba(34,211,238,0.12)" }]) } })),
        label: { show: true, position: "top", color: C.ink2, fontSize: 11, formatter: (p: { dataIndex: number; value: number }) => (p.dataIndex === peakH && p.value > 0 ? "高峰 " + p.value : "") },
      }],
    }, true);

    // 軟體費用排行（由花費多到少，最多 7 列）
    const spend = [...data.apps].sort((a, b) => b.spendUsd - a.spendUsd).slice(0, 7).reverse();
    const sMax = Math.max(0.01, ...spend.map((s) => s.spendUsd)) * 1.05;
    init("apps")?.setOption({
      grid: { left: 136, right: 150, top: 14, bottom: 14 },
      tooltip: { ...TIP, trigger: "item", formatter: (p: { dataIndex: number }) => { const s = spend[p.dataIndex]; return `${s.name}<br/><b>US$${s.spendUsd.toFixed(4)}</b><br/>約 NT$${fmtInt(s.spendUsd * FX)} · ${fmtInt(s.calls)} 次`; } },
      xAxis: { type: "value", max: sMax, show: false },
      yAxis: { type: "category", data: spend.map((s) => s.name), axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 13.5, color: C.ink, formatter: (n: string) => `{d${spend.findIndex((s) => s.name === n)}|■} ${n}`,
          rich: Object.fromEntries(spend.map((s, i) => [`d${i}`, { color: appColor.get(s.name) ?? GRAY, fontSize: 12 }])) } },
      series: [
        // 底條畫滿格；金額掛在底條尾端，所以每列金額對齊在同一欄（2026-09-11 修過錯位）
        { type: "bar", barWidth: 12, silent: true, barGap: "-100%", data: spend.map(() => sMax), itemStyle: { color: "rgba(47,123,255,0.13)" },
          label: { show: true, position: "right", distance: 12,
            formatter: (p: { dataIndex: number }) => { const v = spend[p.dataIndex].spendUsd; return `{v|US$${v.toFixed(2)}}  {t|≈NT$${fmtInt(v * FX)}}`; },
            rich: { v: { color: "#ffffff", fontFamily: numFont, fontSize: 13, fontWeight: 600 }, t: { color: C.warn, fontSize: 12 } } } },
        { type: "bar", barWidth: 12, data: spend.map((s) => ({ value: s.spendUsd,
          itemStyle: { color: new G(0, 0, 1, 0, [{ offset: 0, color: s.color }, { offset: 1, color: tint(s.color, 0.45) }]), shadowColor: s.color, shadowBlur: 8 } })) },
      ],
    }, true);
    };
    draw();
    // 等數字字型真的載入後再畫一次：ECharts 量字寬用的是當下可用的字型，
    // 字型還沒到就量，文字會跟相鄰文字疊在一起（2026-09-12 排行的金額就是這樣疊到的）。
    document.fonts?.ready.then(() => { if (!cancelled) draw(); });
    return () => { cancelled = true; };
  }, [data, still, numFont]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => Object.values(charts.current).forEach((c) => c.resize());
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); Object.values(charts.current).forEach((c) => c.dispose()); charts.current = {}; };
  }, []);

  const poolManual = data.pools.find((p) => !p.auto);
  const saved = data.savings.apiTwd - data.savings.feeTwd;
  const apiMax = Math.max(1, ...data.savings.rows.map((r) => Math.max(r.apiTwd, r.feeTwd)));
  const updated = useMemo(() => new Date(new Date(data.generatedAt).getTime() + 8 * 3_600_000).toISOString().slice(11, 19), [data.generatedAt]);
  const evRows = data.events.length ? data.events : [{ at: data.generatedAt, level: "good" as const, text: "最近沒有失敗的請求，也沒有預算告警" }];
  const evTime = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

  return (
    <div className={`bs-root ${still ? "bs-still" : ""}`}>
      <div className="bs-viewport" ref={vpRef}>
        <div className="bs-stage" ref={stRef}>
          <header className="bs-head">
            <svg viewBox="0 0 1920 92" width="1920" height="92" aria-hidden="true">
              <defs>
                <linearGradient id="bs-hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b44b0" stopOpacity="0.9" /><stop offset="1" stopColor="#041a55" stopOpacity="0.15" /></linearGradient>
                <linearGradient id="bs-hl" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#22d3ee" stopOpacity="0" /><stop offset="0.3" stopColor="#22d3ee" /><stop offset="0.5" stopColor="#ffffff" />
                  <stop offset="0.7" stopColor="#2ee6a6" /><stop offset="1" stopColor="#2ee6a6" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M560 0 H1360 L1316 66 H604 Z" fill="url(#bs-hg)" stroke="#2a8cff" strokeWidth="1.5" />
              <path d="M0 40 H470 L530 70 H604" fill="none" stroke="#1f6ad8" strokeWidth="2" />
              <path d="M1920 40 H1450 L1390 70 H1316" fill="none" stroke="#1f6ad8" strokeWidth="2" />
              <path d="M604 66 H1316" stroke="url(#bs-hl)" strokeWidth="3" />
              <path className="bs-flow" d="M0 40 H470 L530 70 H1390 L1450 40 H1920" fill="none" stroke="#9ff6ff" strokeWidth="2.5" />
              <rect x="516" y="10" width="22" height="6" transform="skewX(-35)" fill="#22d3ee" />
              <rect x="546" y="10" width="14" height="6" transform="skewX(-35)" fill="#ff9a3d" />
              <rect x="1386" y="10" width="14" height="6" transform="skewX(35)" fill="#ff9a3d" />
              <rect x="1404" y="10" width="22" height="6" transform="skewX(35)" fill="#2ee6a6" />
            </svg>
            <div className="bs-sub-l"><span>{dateLabel}</span><span>AI 用量與成本</span></div>
            <h1>CostScale AI 閘道營運大屏</h1>
            <div className="bs-sub-r">
              <span className={data.gateway.ok ? "bs-ok" : "bs-bad"}><span className="bs-dot" /> 閘道 {data.gateway.detail}</span>
              <span className="bs-clock">{clock}</span>
            </div>
            <div className="bs-tools-l">資料更新 {updated} · 每 60 秒自動更新 · 本月、每日、每小時都以台北時間計</div>
            <div className="bs-tools-r">
              <span className="bs-seg" role="group" aria-label="動態效果">
                <span className="bs-seg-lab">動態</span>
                {(["system", "on", "off"] as Motion[]).map((m) => (
                  <button key={m} type="button" aria-pressed={motion === m} onClick={() => chooseMotion(m)}>
                    {m === "system" ? `跟隨系統${sysReduce ? "（關）" : "（開）"}` : m === "on" ? "開" : "關"}
                  </button>
                ))}
              </span>
              <button type="button" className="bs-btn" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())}>
                {isFull ? "離開全螢幕" : "全螢幕"}
              </button>
              <Link className="bs-btn" href="/">返回儀表板</Link>
            </div>
          </header>

          <div className="bs-col bs-left">
            <Box idx={0} acc="#22d3ee" title="每日閘道花費" note="近 30 天 · 台北日 · 美元" src="SRC · SpendLogs · 日">
              <div className="bs-chart" ref={els.daily} />
            </Box>
            <Box idx={1} acc="#bfb0ff" title="模型用量" note="本月 · 依呼叫次數" src="SRC · SpendLogs · model_group">
              <div className="bs-chart" ref={els.mix} />
            </Box>
            <Box idx={2} acc="#2ee6a6" title="免費額度" note="今日 · 台北 00:00 起" src="SRC · quota_pools × 金鑰盤點">
              <div className="bs-chart" ref={els.free} />
              {poolManual ? <span className="bs-warn-chip">讀不到閘道設定，{poolManual.name} 暫用手填的 {poolManual.keys} 把</span> : null}
            </Box>
          </div>

          <div className="bs-col bs-mid">
            <div className="bs-counters">
              <section className="bs-box bs-counter" style={{ "--acc": "#22d3ee" } as React.CSSProperties}>
                <span className="bs-lab">本月呼叫</span>
                <Digits value={fmtInt(data.month.calls)} still={still} suffix="次" />
                <span className="bs-alt">失敗 <b>{fmtInt(data.month.failed)}</b> 次（{data.month.calls ? ((data.month.failed / data.month.calls) * 100).toFixed(1) : "0"}%）</span>
              </section>
              <section className="bs-box bs-counter" style={{ "--acc": "#2ee6a6" } as React.CSSProperties}>
                <span className="bs-lab">本月 Token</span>
                <Digits value={fmtInt(data.month.tokens)} still={still} />
                <span className="bs-alt">經閘道的部分</span>
              </section>
              <section className="bs-box bs-counter" style={{ "--acc": "#ff9a3d" } as React.CSSProperties}>
                <span className="bs-lab">本月閘道花費</span>
                <Digits value={data.month.spendUsd.toFixed(2)} still={still} prefix="US$" />
                <span className="bs-alt">約 <b>NT${fmtInt(data.month.spendUsd * FX)}</b> · 匯率 {FX.toFixed(2)}{data.fx.stale ? "（匯率超過兩天沒更新）" : ""}</span>
              </section>
            </div>

            <Box idx={3} acc="#9a85ff" title="流量拓撲" note="軟體 → 閘道 → 模型 · 本月呼叫次數 · 線越粗越多" src="SRC · SpendLogs × apps" className="bs-topo">
              <div className="bs-floor" />
              <div className="bs-holo"><span className="d1" /><span className="d2" /><span className="d3" /></div>
              <div className="bs-beam" />
              <div className="bs-core" />
              <div className="bs-chart" ref={els.topo} />
              <div className="bs-hub"><b>閘道</b><small>{fmtInt(data.month.calls)}</small></div>
              <div className="bs-legend"><span><b>左</b> 軟體（各自的顏色）</span><span><b>右</b> 模型（藍紫，越亮流量越大）</span></div>
            </Box>

            <Box idx={4} acc="#2ee6a6" title="近 24 小時每小時呼叫" note={`台北時間 · 截至 ${data.hourlyThrough}`} src="SRC · SpendLogs · 台北時區">
              <div className="bs-chart" ref={els.hour} />
            </Box>
          </div>

          <div className="bs-col bs-right">
            <Box idx={5} acc="#ff9a3d" title="軟體費用排行" note="本月 · 美元（約台幣）" src="SRC · SpendLogs × apps">
              <div className="bs-chart" ref={els.apps} />
            </Box>
            <Box idx={6} acc="#2ee6a6" title="訂閱省下多少" note="官方 API 價目換算" src="SRC · cli_session_usage">
              <div className="bs-save">
                <div className="bs-big"><strong>NT${fmtInt(saved)}</strong><span>本月省下</span></div>
                {data.savings.rows.filter((r) => !r.noData).map((r) => (
                  <div className="bs-srow" key={r.provider}>
                    <span className="nm">{r.provider}</span>
                    <span className="tr api"><i style={{ width: `${Math.max(0.3, (r.apiTwd / apiMax) * 100)}%` }} /></span><span className="v">NT${fmtInt(r.apiTwd)}</span>
                    <span className="tr fee"><i style={{ width: `${Math.max(0.2, (r.feeTwd / apiMax) * 100)}%` }} /></span><span className="v fee">月費 NT${fmtInt(r.feeTwd)}</span>
                  </div>
                ))}
                <div className="bs-save-foot">
                  綠青條＝同樣的 token 走 API 要付多少，琥珀條＝實際月費，同一把尺。
                  {data.savings.rows.filter((r) => r.noData).map((r) => r.provider).join("、") ? `${data.savings.rows.filter((r) => r.noData).map((r) => r.provider).join("、")} 拿不到 token，不列，但月費已計入。` : ""}
                </div>
              </div>
            </Box>
            <Box idx={7} acc="#ff6aa8" title="最近異常" note="失敗的請求＋預算告警 · 滑過暫停" src="SRC · SpendLogs · budget_alerts">
              <div className="bs-events">
                <div className="bs-track">
                  {[0, 1].map((k) => (
                    <ul key={k} aria-hidden={k === 1}>
                      {evRows.map((e, i) => (
                        <li key={i}><time>{evTime(e.at)}</time><span className={`sv ${e.level}`} /><span>{e.text}</span></li>
                      ))}
                    </ul>
                  ))}
                </div>
              </div>
            </Box>
          </div>

          <div className="bs-note">
            {data.problems.length ? `有 ${data.problems.length} 塊資料讀不到：${data.problems.join("、")}` : "所有數字即時取自正式機資料庫"}
          </div>
        </div>
      </div>
    </div>
  );
}

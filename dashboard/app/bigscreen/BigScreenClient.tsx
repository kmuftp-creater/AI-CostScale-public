"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as echarts from "echarts/core";
import { LineChart, PieChart, GaugeChart, BarChart, LinesChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkPointComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { BigScreenData } from "@/lib/bigscreen";
import { SKIN_KEY, SKIN_ORDER, SKIN_NAME, SKIN_CLASS, type Skin } from "./skins";

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

const G = echarts.graphic.LinearGradient;
// 動態效果只有開／關。原本還有「跟隨系統」，2026-09-12 User：「跟隨系統這應該不用吧」——
// 三個選項要使用者先搞懂「系統現在是開還是關」才知道自己選到什麼，多一層不必要的理解成本。
// 系統設定仍然尊重：**第一次打開**時若系統要求減少動態，預設就是「關」。
type Motion = "on" | "off";
const MOTION_KEY = "costscale-bigscreen-motion";

/**
 * 兩套外觀，頁首「風格」按一下換下一種，選擇存在這台電腦（2026-09-12 User 要求）。
 *
 * nerv 取的是《新世紀福音戰士》指揮所那種視覺語言——黑底、橘色警戒條、稜角切邊、
 * 綠色終端字。**刻意不使用作品裡的標誌、名稱或任何美術資產**，只有配色與造型語彙。
 *
 * 兩套的軟體類別色與模型色階都用 dataviz 的驗證器跑過（深色底，類別與 ordinal 兩種模式）：
 * nerv 的第一版橘／琥珀／紅彼此只差 ΔE 3，色盲與一般視力都分不出來，退回現在這組才全過。
 */
/** 伺服器端配色（lib/bigscreen.ts）給「不分配顏色」的軟體用的灰，換皮時要原樣保留灰。 */
const SERVER_GRAY = "#56699a";

const SKINS = {
  cyber: {
    ramp: ["#e8e2ff", "#bfb0ff", "#9a85ff", "#735ae8"],
    hub: "#9a85ff",
    fail: "#c2414f",
    gray: SERVER_GRAY,
    idle: "#3a4a72",
    line: "#f1edff",
    apps: null as string[] | null,
    // flat＝扁平：不用漸層、不用光暈、節點用方塊。第二種外觀的造型靠它，不只是換色。
    flat: false,
    C: { cy: "#22d3ee", good: "#2ee6a6", warn: "#ffb72b", crit: "#ff4d5e", ink: "#e2f1ff", ink2: "#a3c0ea", muted: "#6484b8", grid: "rgba(47,123,255,0.18)" },
    tip: { bg: "rgba(4,20,60,0.94)", border: "#1f6ad8" },
    daily: ["#4b88fd", "#22d3ee", "#9a85ff"],
    dailyGlow: "rgba(124,92,255,0.7)",
    dailyArea: ["rgba(34,211,238,0.45)", "rgba(75,136,253,0.10)", "rgba(75,136,253,0)"],
    hourBar: ["#7ff5c8", "#2ee6a6", "rgba(34,211,238,0.12)"],
    hourPeak: ["#ffd66b", "rgba(255,154,61,0.2)"],
    ring: "rgba(154,133,255,0.32)",
    pieBorder: "#041a4a",
    track: "rgba(47,123,255,0.13)",
    gaugeTrack: "rgba(46,230,166,0.16)",
    gaugeTick: "rgba(46,230,166,0.35)",
    modelWord: "藍紫",
    head: { g1: "#0b44b0", g2: "#041a55", edge: "#2a8cff", rail: "#1f6ad8", l1: "#22d3ee", l2: "#ffffff", l3: "#2ee6a6", flow: "#9ff6ff", chipA: "#22d3ee", chipB: "#ff9a3d", chipC: "#2ee6a6" },
    acc: { daily: "#22d3ee", mix: "#bfb0ff", free: "#2ee6a6", calls: "#22d3ee", tokens: "#2ee6a6", spend: "#ff9a3d", topo: "#9a85ff", hour: "#2ee6a6", rank: "#ff9a3d", save: "#2ee6a6", events: "#ff6aa8" },
  },
  nerv: {
    ramp: ["#ffd9a8", "#ffb056", "#f2801a", "#b85500"],
    hub: "#ff6a00",
    fail: "#ff1f0f",
    gray: "#6f6a5c",
    idle: "#43403a",
    line: "#ffe9c7",
    apps: ["#d4640c", "#0f9c84", "#bb8d16", "#cf4540", "#7d6ad9", "#7f9234"] as string[] | null,
    flat: true,
    C: { cy: "#ff6a00", good: "#7ee787", warn: "#ffcc00", crit: "#ff1f0f", ink: "#f6ead8", ink2: "#c8b79c", muted: "#8a7c66", grid: "rgba(255,106,0,0.18)" },
    tip: { bg: "#0b0805", border: "#ff6a00" },
    daily: ["#b85500", "#ff7a18", "#ffcc00"],
    dailyGlow: "rgba(255,122,24,0.55)",
    dailyArea: ["rgba(255,122,24,0.40)", "rgba(255,122,24,0.10)", "rgba(255,122,24,0)"],
    hourBar: ["#b6f0b6", "#7ee787", "rgba(126,231,135,0.10)"],
    hourPeak: ["#ffcc00", "rgba(255,122,24,0.2)"],
    ring: "rgba(255,122,24,0.30)",
    pieBorder: "#120c06",
    track: "rgba(255,122,24,0.12)",
    gaugeTrack: "rgba(126,231,135,0.14)",
    gaugeTick: "rgba(126,231,135,0.35)",
    modelWord: "橘",
    head: { g1: "#c24a00", g2: "#160a03", edge: "#ff7a18", rail: "#8a4a10", l1: "#ff7a18", l2: "#ffe9c7", l3: "#7ee787", flow: "#ffd9a8", chipA: "#ff7a18", chipB: "#ffcc00", chipC: "#7ee787" },
    // 紅色留給「有事」的那幾塊：異常、失敗、告警（2026-09-12 User：「而且沒有紅色」）
    acc: { daily: "#ff7a18", mix: "#ffb056", free: "#7ee787", calls: "#ff6a00", tokens: "#7ee787", spend: "#ffcc00", topo: "#f2801a", hour: "#7ee787", rank: "#ffcc00", save: "#7ee787", events: "#ff1f0f" },
  },
  // 作戰指揮：骨架與黑橘警戒相同（樣式靠 bs-nerv），這裡只調圖表用得到的幾個顏色——
  // 白色進來當第三個顏色（面板標題、主要數字），紅色出現得更多。
  cmd: {
    ramp: ["#ffffff", "#ffd9a8", "#ff9a3d", "#c24a00"],
    hub: "#ff6a00",
    fail: "#ff1f0f",
    gray: "#7b7468",
    idle: "#403c36",
    line: "#ffffff",
    apps: ["#ff6a00", "#ffffff", "#7ee787", "#ff1f0f", "#ffcc00", "#9a85ff"] as string[] | null,
    flat: true,
    C: { cy: "#ff6a00", good: "#7ee787", warn: "#ffcc00", crit: "#ff1f0f", ink: "#ffffff", ink2: "#d8cec0", muted: "#8a7c66", grid: "rgba(255,255,255,0.12)" },
    tip: { bg: "#0b0805", border: "#ffffff" },
    daily: ["#c24a00", "#ff6a00", "#ffffff"],
    dailyGlow: "rgba(255,106,0,0.45)",
    dailyArea: ["rgba(255,106,0,0.34)", "rgba(255,106,0,0.08)", "rgba(255,106,0,0)"],
    hourBar: ["#ffffff", "#7ee787", "rgba(126,231,135,0.10)"],
    hourPeak: ["#ff1f0f", "rgba(255,31,15,0.2)"],
    ring: "rgba(255,255,255,0.22)",
    pieBorder: "#0b0805",
    track: "rgba(255,255,255,0.10)",
    gaugeTrack: "rgba(255,255,255,0.12)",
    gaugeTick: "rgba(255,255,255,0.30)",
    modelWord: "橘",
    head: { g1: "#c24a00", g2: "#160a03", edge: "#ffffff", rail: "#8a4a10", l1: "#ff6a00", l2: "#ffffff", l3: "#ff1f0f", flow: "#ffffff", chipA: "#ff6a00", chipB: "#ffffff", chipC: "#ff1f0f" },
    acc: { daily: "#ff6a00", mix: "#ffffff", free: "#7ee787", calls: "#ffffff", tokens: "#7ee787", spend: "#ffcc00", topo: "#ff6a00", hour: "#7ee787", rank: "#ffcc00", save: "#7ee787", events: "#ff1f0f" },
  },
} as const;

const tint = (hex: string, t: number) => {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0");
  return "#" + m(r) + m(g) + m(b);
};
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * 七段式數字（電子碼表那種）。2026-09-12 User 指定：「電子碼表格式阿」。
 *
 * 沒亮的段也畫出來、只是很暗——真的液晶顯示器就是這樣，全黑反而像印刷字。
 * 七段顯示器是通用的工業零件造型，不屬於任何作品。
 */
const SEG_SHAPES: Record<string, string> = {
  a: "8,2 52,2 46,10 14,10",
  b: "54,4 58,10 58,46 52,50 48,44 48,12",
  c: "58,54 58,90 54,96 48,88 48,56 52,50",
  d: "52,98 8,98 14,90 46,90",
  e: "2,54 2,90 6,96 12,88 12,56 8,50",
  f: "6,4 2,10 2,46 8,50 12,44 12,12",
  g: "14,46 46,46 52,50 46,54 14,54 8,50",
};
const SEG_ON: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function SevenSeg({ ch }: { ch: string }) {
  const on = SEG_ON[ch] ?? "";
  return (
    <svg className="bs-seg7" viewBox="0 0 60 100" aria-hidden="true">
      {Object.entries(SEG_SHAPES).map(([k, pts]) => (
        <polygon key={k} points={pts} className={on.includes(k) ? "on" : "off"} />
      ))}
    </svg>
  );
}

/**
 * 徽章（只有黑橘警戒外觀會顯示）。六角形外框、裡面三個節點連成三角形、我們自己的字。
 *
 * **刻意不是任何作品裡的標誌**——那些有版權。這裡取的是「機構徽章」這個通用形式：
 * 六角形＋三節點是很常見的圖解造型（三個節點對應這套系統的三段：軟體 → 閘道 → 模型）。
 */
function Emblem() {
  // 外圈刻度：24 格，用算的不要手寫 24 條線
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI * 2) / 24 - Math.PI / 2;
    const r1 = i % 6 === 0 ? 54 : 60;
    return { x1: 70 + Math.cos(a) * r1, y1: 70 + Math.sin(a) * r1, x2: 70 + Math.cos(a) * 66, y2: 70 + Math.sin(a) * 66 };
  });
  // 放射葉脈：從下方一點扇形展開到上緣，像徽章上那種線條
  const veins = [
    [44, 46], [52, 41], [60, 38], [70, 36], [80, 38], [88, 41], [96, 46],
  ];
  return (
    <div className="bs-emblem">
      <svg viewBox="0 0 140 140" aria-hidden="true">
        <g className="tick">
          {ticks.map((t, i) => <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />)}
        </g>
        <polygon className="hex2" points="70,8 123,39 123,101 70,132 17,101 17,39" />
        <polygon className="hex" points="70,18 115,44 115,96 70,122 25,96 25,44" />
        <g className="vein">
          {veins.map(([x, y], i) => <line key={i} x1={70} y1={104} x2={x} y2={y} />)}
          <path d="M44 46 Q70 30 96 46" />
        </g>
        <polygon className="tri" points="70,44 96,92 44,92" />
        <g className="node">
          <circle cx="70" cy="44" r="7" />
          <circle cx="96" cy="92" r="7" />
          <circle cx="44" cy="92" r="7" />
        </g>
        <circle className="core" cx="70" cy="76" r="4.5" />
      </svg>
      <span><b>閘道管制</b><i>GATEWAY CONTROL</i></span>
    </div>
  );
}

/** 翻牌數字。value 變了才捲；停止用經過的時間，不用跳動次數（背景分頁會放慢計時器）。 */
function Digits({ value, still, prefix, suffix, seg }: { value: string; still: boolean; prefix?: string; suffix?: string; seg?: boolean }) {
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
      {shown.split("").map((c, i) =>
        /\d/.test(c) ? (seg ? <SevenSeg key={i} ch={c} /> : <b key={i}>{c}</b>) : <s key={i}>{c}</s>
      )}
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

export default function BigScreenClient({ data, numFont, initialSkin, assets }: {
  data: BigScreenData;
  numFont: string;
  initialSkin?: Skin | null;
  /** public/private/ 底下的素材網址（page.tsx 在伺服器端找 png／jpg／webp）。沒放就是 null，改用原創徽章。 */
  assets?: { logo: string | null; mark: string | null };
}) {
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
  const [motion, setMotion] = useState<Motion>("on");
  const [skin, setSkin] = useState<Skin>(initialSkin ?? "cyber");
  const [isFull, setIsFull] = useState(false);
  const still = motion === "off";
  const FX = data.fx.rate;
  const P = SKINS[skin];
  const C = P.C;
  const A = P.acc;
  const TIP = { backgroundColor: P.tip.bg, borderColor: P.tip.border, borderWidth: 1, textStyle: { color: C.ink, fontSize: 13 } };

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
      // 沒選過的話看系統：要求減少動態就預設關
      else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMotion("off");
      // 網址指定了風格（?skin=nerv，伺服器端已經套用）就記住它；沒指定才用上次記的。
      if (initialSkin) {
        localStorage.setItem(SKIN_KEY, initialSkin);
      } else {
        const sk = localStorage.getItem(SKIN_KEY);
        if (sk === "cyber" || sk === "nerv" || sk === "cmd") setSkin(sk as Skin);
      }
    } catch { /* 無痕視窗讀不到就用預設 */ }
    const onFs = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => { document.removeEventListener("fullscreenchange", onFs); };
  }, []);
  /** 按一下換下一種外觀。頁首的「切換到大屏」也是同一套輪流（components/BigScreenLink.tsx）。 */
  const cycleSkin = () => {
    const next = SKIN_ORDER[(SKIN_ORDER.indexOf(skin) + 1) % SKIN_ORDER.length];
    setSkin(next);
    try { localStorage.setItem(SKIN_KEY, next); } catch { /* 無痕視窗寫不進去就算了 */ }
  };

  // CSS 變數定義在外層的 .bs（在 page.tsx，是伺服器元件，拿不到這裡的狀態），
  // 所以外觀的 class 由這裡掛上去。
  useEffect(() => {
    const root = vpRef.current?.closest(".bs");
    if (!root) return;
    for (const s of SKIN_ORDER) for (const c of SKIN_CLASS[s]) root.classList.remove(c);
    for (const c of SKIN_CLASS[skin]) root.classList.add(c);
  }, [skin]);

  const chooseMotion = (m: Motion) => {
    setMotion(m);
    try { localStorage.setItem(MOTION_KEY, m); } catch { /* 無痕視窗寫不進去就算了 */ }
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
    // 軟體顏色：cyber 用伺服器算好的（依建立順序固定分配），nerv 換成自己那組，
    // 但伺服器判定「不分配顏色」的那些（ops-manual、未歸戶）兩套都維持灰。
    const appColor = new Map<string, string>();
    let apSlot = 0;
    for (const a of data.apps) {
      appColor.set(a.name, !P.apps ? a.color : a.color === SERVER_GRAY ? P.gray : P.apps[apSlot++ % P.apps.length]);
    }
    const colOf = (a: { name: string; color: string }) => appColor.get(a.name) ?? P.gray;
    const modelColor = (name: string, kind: string, i: number) => (kind === "fail" ? P.fail : kind === "other" ? P.gray : P.ramp[Math.min(i, 3)]);

    // 每日花費
    const daily = data.daily;
    const dMax = Math.max(0.1, ...daily.map((d) => d.usd));
    init("daily")?.setOption({
      grid: { left: 58, right: 22, top: 30, bottom: 30 },
      tooltip: { ...TIP, trigger: "axis", formatter: (p: { dataIndex: number }[]) => { const d = daily[p[0].dataIndex]; return `${d.day}<br/><b style="font-size:15px">US$${d.usd.toFixed(4)}</b><br/>約 NT$${fmtInt(d.usd * FX)} · ${d.calls} 次呼叫`; } },
      xAxis: { type: "category", data: daily.map((d) => d.day), boundaryGap: false, axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.muted, interval: 5, fontSize: 12 } },
      yAxis: { type: "value", max: Math.ceil(dMax * 1.15 * 10) / 10, splitNumber: 4, splitLine: { lineStyle: { color: C.grid, type: "dashed" } }, axisLabel: { color: C.muted, fontSize: 12, formatter: (v: number) => (v ? "$" + v.toFixed(2) : "0") } },
      series: [{
        type: "line", smooth: !P.flat, showSymbol: false, data: daily.map((d) => d.usd),
        // 扁平外觀不用漸層、不用外光：那兩樣是另一種外觀的語彙
        lineStyle: P.flat
          ? { width: 2, color: P.daily[1] }
          : { width: 2.5, color: new G(0, 0, 1, 0, [{ offset: 0, color: P.daily[0] }, { offset: 0.55, color: P.daily[1] }, { offset: 1, color: P.daily[2] }]), shadowColor: P.dailyGlow, shadowBlur: 12 },
        itemStyle: { color: C.cy },
        areaStyle: { color: P.flat ? P.dailyArea[0] : new G(0, 0, 0, 1, [{ offset: 0, color: P.dailyArea[0] }, { offset: 0.7, color: P.dailyArea[1] }, { offset: 1, color: P.dailyArea[2] }]) },
        markPoint: { symbol: "pin", symbolSize: 44, itemStyle: { color: C.warn }, label: { color: "#1a1200", fontSize: 11, fontWeight: 700, formatter: "高點" }, data: [{ type: "max" }] },
      }],
    }, true);

    // 模型用量
    let mi = 0;
    const mix = data.models.map((m) => {
      const col = modelColor(m.name, m.kind, m.kind === "model" ? mi++ : 0);
      return { name: m.name, value: m.calls, col, itemStyle: { color: P.flat ? col : new G(0, 0, 1, 1, [{ offset: 0, color: tint(col, 0.25) }, { offset: 1, color: col }]) } };
    });
    init("mix")?.setOption({
      tooltip: { ...TIP, trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/><b>${fmtInt(p.value)} 次</b>（${p.percent}%）` },
      legend: { orient: "vertical", right: 12, top: "middle", itemWidth: 10, itemHeight: 10, itemGap: 13, textStyle: { color: C.ink2, fontSize: 13 },
        data: mix.map((m) => ({ name: m.name, itemStyle: { color: m.col } })),
        formatter: (n: string) => `${n}  ${fmtInt(mix.find((m) => m.name === n)?.value ?? 0)}` },
      title: { text: fmtInt(data.month.calls), subtext: "本月呼叫", left: "24%", top: "40%", textAlign: "center",
        textStyle: { color: "#fff", fontFamily: numFont, fontSize: 24, fontWeight: 700 }, subtextStyle: { color: C.muted, fontSize: 12 } },
      series: [
        { type: "pie", radius: ["59%", "63%"], center: ["24%", "52%"], silent: true, label: { show: false }, data: [{ value: 1, itemStyle: { color: P.ring } }] },
        { type: "pie", radius: ["42%", "56%"], center: ["24%", "52%"], padAngle: 2, itemStyle: { borderColor: P.pieBorder, borderWidth: 2 }, label: { show: false }, data: mix },
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
          pointer: { show: false }, progress: { show: true, roundCap: !P.flat, width: 10, itemStyle: { color: P.flat ? C.good : new G(0, 0, 1, 1, [{ offset: 0, color: C.good }, { offset: 1, color: C.cy }]) } },
          axisLine: { lineStyle: { width: 10, color: [[1, P.gaugeTrack]] } },
          axisTick: { show: true, distance: -22, length: 4, splitNumber: 3, lineStyle: { color: P.gaugeTick } },
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
      const ac = colOf(a);
      nodes.push({ name: a.name, value: p, symbol: P.flat ? "rect" : "circle", symbolSize: a.calls ? 11 + Math.log10(a.calls + 1) * 5 : 8,
        itemStyle: { color: a.idle ? P.idle : ac, borderColor: P.flat ? "#0b0805" : tint(ac, 0.5), borderWidth: 2, shadowBlur: P.flat ? 0 : (a.calls ? 14 : 0), shadowColor: ac },
        label: { show: true, position: "left", distance: 10, color: a.calls ? C.ink : C.muted, fontSize: 13.5,
          formatter: `{n|${a.name}}  {c|${a.calls ? fmtInt(a.calls) : "閒置"}}`,
          rich: { n: { fontSize: 13.5 }, c: { fontFamily: numFont, fontSize: 12, color: a.calls ? tint(ac, 0.35) : C.muted } } } });
      if (a.calls) series.push({ type: "lines", coordinateSystem: "cartesian2d", zlevel: 1,
        lineStyle: { curveness: P.flat ? 0 : 0.18, opacity: P.flat ? 0.95 : 0.8, width: w(a.calls), color: P.flat ? ac : new G(0, 0, 1, 0, [{ offset: 0, color: ac }, { offset: 1, color: P.hub }]) },
        // 扁平外觀不用 ECharts 的 lines effect：它在 SVG 渲染下不是畫一顆小方塊，
        // 而是沿線畫出一整段實色線，與 CSS 的流動虛線疊在一起，看起來像每條線都多一條黃線
        // （2026-09-12 User：「流量拓撲長得不一樣」）。扁平外觀的流動改由 CSS 虛線負責。
        effect: P.flat
          ? { show: false }
          : { show: !still, period: 3.2, trailLength: 0.4, symbol: "circle", symbolSize: 5, color: tint(ac, 0.55) },
        data: [{ coords: [p, hub], value: a.calls, name: a.name }] });
    });
    let ri = 0;
    const mLines: object[] = [];
    data.models.forEach((m, i) => {
      const col = modelColor(m.name, m.kind, m.kind === "model" ? ri++ : 0);
      const p = [92, yAt(i, data.models.length)];
      nodes.push({ name: m.name, value: p, symbol: P.flat ? "rect" : "circle", symbolSize: 11 + Math.log10(m.calls + 1) * 5,
        itemStyle: { color: col, borderColor: P.flat ? "#0b0805" : col, borderWidth: P.flat ? 2 : 0, shadowBlur: P.flat ? 0 : (m.kind === "model" ? 14 : 0), shadowColor: col },
        label: { show: true, position: "right", distance: 10, color: m.kind === "other" ? C.muted : C.ink, fontSize: 13.5,
          formatter: `{c|${fmtInt(m.calls)}}  {n|${m.name}}`,
          rich: { n: { fontSize: 13.5 }, c: { fontFamily: numFont, fontSize: 12, color: col } } } });
      mLines.push({ coords: [hub, p], value: m.calls, name: m.name, lineStyle: { width: w(m.calls), color: P.flat ? col : new G(0, 0, 1, 0, [{ offset: 0, color: P.hub }, { offset: 1, color: col }]) } });
    });
    series.push({ type: "lines", coordinateSystem: "cartesian2d", zlevel: 1, lineStyle: { curveness: P.flat ? 0 : 0.18, opacity: P.flat ? 0.9 : 0.7 },
      effect: P.flat
        ? { show: false }
        : { show: !still, period: 3.2, trailLength: 0.4, symbol: "circle", symbolSize: 5, color: P.line }, data: mLines });
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
        data: hours.map((v, h) => ({ value: v, itemStyle: { color: P.flat
          ? (h === peakH && v > 0 ? P.hourPeak[0] : P.hourBar[1])
          : (h === peakH && v > 0
            ? new G(0, 0, 0, 1, [{ offset: 0, color: P.hourPeak[0] }, { offset: 1, color: P.hourPeak[1] }])
            : new G(0, 0, 0, 1, [{ offset: 0, color: P.hourBar[0] }, { offset: 0.5, color: P.hourBar[1] }, { offset: 1, color: P.hourBar[2] }])) } })),
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
          rich: Object.fromEntries(spend.map((s, i) => [`d${i}`, { color: colOf(s), fontSize: 12 }])) } },
      series: [
        // 底條畫滿格；金額掛在底條尾端，所以每列金額對齊在同一欄（2026-09-11 修過錯位）
        { type: "bar", barWidth: 12, silent: true, barGap: "-100%", data: spend.map(() => sMax), itemStyle: { color: P.track },
          label: { show: true, position: "right", distance: 12,
            formatter: (p: { dataIndex: number }) => { const v = spend[p.dataIndex].spendUsd; return `{v|US$${v.toFixed(2)}}  {t|≈NT$${fmtInt(v * FX)}}`; },
            rich: { v: { color: "#ffffff", fontFamily: numFont, fontSize: 13, fontWeight: 600 }, t: { color: C.warn, fontSize: 12 } } } },
        { type: "bar", barWidth: 12, data: spend.map((s) => ({ value: s.spendUsd,
          itemStyle: P.flat
            ? { color: colOf(s) }
            : { color: new G(0, 0, 1, 0, [{ offset: 0, color: colOf(s) }, { offset: 1, color: tint(colOf(s), 0.45) }]), shadowColor: colOf(s), shadowBlur: 8 } })) },
      ],
    }, true);
    };
    draw();
    // 等數字字型真的載入後再畫一次：ECharts 量字寬用的是當下可用的字型，
    // 字型還沒到就量，文字會跟相鄰文字疊在一起（2026-09-12 排行的金額就是這樣疊到的）。
    document.fonts?.ready.then(() => { if (!cancelled) draw(); });
    return () => { cancelled = true; };
  }, [data, still, numFont, skin]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {skin === "cmd" ? (
            <>
              {/* 側邊直排字與警戒橫幅：純造型，字是我們自己的 */}
              <div className="bs-edge bs-edge-l" aria-hidden="true">監 視 中</div>
              <div className="bs-edge bs-edge-r" aria-hidden="true">記 錄 中</div>
              {/* 失敗數是真的資料：有失敗才亮紅幅，沒有就顯示正常 */}
              <div className={`bs-alarm ${data.month.failed ? "on" : ""}`}>
                {data.month.failed
                  ? `本月偵測到 ${fmtInt(data.month.failed)} 筆失敗請求`
                  : "本月無失敗請求"}
              </div>
            </>
          ) : null}
          <header className="bs-head">
            <svg viewBox="0 0 1920 92" width="1920" height="92" aria-hidden="true">
              <defs>
                <linearGradient id="bs-hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P.head.g1} stopOpacity="0.9" /><stop offset="1" stopColor={P.head.g2} stopOpacity="0.15" /></linearGradient>
                <linearGradient id="bs-hl" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor={P.head.l1} stopOpacity="0" /><stop offset="0.3" stopColor={P.head.l1} /><stop offset="0.5" stopColor={P.head.l2} />
                  <stop offset="0.7" stopColor={P.head.l3} /><stop offset="1" stopColor={P.head.l3} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M560 0 H1360 L1316 66 H604 Z" fill="url(#bs-hg)" stroke={P.head.edge} strokeWidth="1.5" />
              <path d="M0 40 H470 L530 70 H604" fill="none" stroke={P.head.rail} strokeWidth="2" />
              <path d="M1920 40 H1450 L1390 70 H1316" fill="none" stroke={P.head.rail} strokeWidth="2" />
              <path d="M604 66 H1316" stroke="url(#bs-hl)" strokeWidth="3" />
              <path className="bs-flow" d="M0 40 H470 L530 70 H1390 L1450 40 H1920" fill="none" stroke={P.head.flow} strokeWidth="2.5" />
              <rect x="516" y="10" width="22" height="6" transform="skewX(-35)" fill={P.head.chipA} />
              <rect x="546" y="10" width="14" height="6" transform="skewX(-35)" fill={P.head.chipB} />
              <rect x="1386" y="10" width="14" height="6" transform="skewX(35)" fill={P.head.chipB} />
              <rect x="1404" y="10" width="22" height="6" transform="skewX(35)" fill={P.head.chipC} />
            </svg>
            {P.flat ? (assets?.logo ? (
              // 私有素材：檔案在 public/private/logo.png（不進版控）。沒有檔就走原創徽章。
              <div className="bs-emblem bs-emblem-img"><img src={assets.logo} alt="" /></div>
            ) : <Emblem />) : null}
            <div className="bs-sub-l"><span>{dateLabel}</span><span>AI 用量與成本</span></div>
            <h1>CostScale AI 閘道營運大屏</h1>
            <div className="bs-sub-r">
              <span className={data.gateway.ok ? "bs-ok" : "bs-bad"}><span className="bs-dot" /> 閘道 {data.gateway.detail}</span>
              <span className="bs-clock">{clock}</span>
            </div>
            <div className="bs-tools-l">資料更新 {updated} · 每 60 秒自動更新 · 本月、每日、每小時都以台北時間計</div>
            <div className="bs-tools-r">
              <button type="button" className="bs-btn bs-skin" onClick={cycleSkin} title="按一下換下一種大屏風格">風格 · {SKIN_NAME[skin]}</button>
              <span className="bs-seg" role="group" aria-label="動態效果">
                <span className="bs-seg-lab">動態</span>
                {(["on", "off"] as Motion[]).map((m) => (
                  <button key={m} type="button" aria-pressed={motion === m} onClick={() => chooseMotion(m)}>
                    {m === "on" ? "開" : "關"}
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
            <Box idx={0} acc={A.daily} title="每日閘道花費" note="近 30 天 · 台北日 · 美元" src="SRC · SpendLogs · 日">
              <div className="bs-chart" ref={els.daily} />
            </Box>
            <Box idx={1} acc={A.mix} title="模型用量" note="本月 · 依呼叫次數" src="SRC · SpendLogs · model_group">
              <div className="bs-chart" ref={els.mix} />
            </Box>
            <Box idx={2} acc={A.free} title="免費額度" note="今日 · 台北 00:00 起" src="SRC · quota_pools × 金鑰盤點">
              <div className="bs-chart" ref={els.free} />
              {poolManual ? <span className="bs-warn-chip">讀不到閘道設定，{poolManual.name} 暫用手填的 {poolManual.keys} 把</span> : null}
            </Box>
          </div>

          <div className="bs-col bs-mid">
            <div className="bs-counters">
              <section className="bs-box bs-counter" style={{ "--acc": A.calls } as React.CSSProperties}>
                <span className="bs-lab">本月呼叫</span>
                <Digits value={fmtInt(data.month.calls)} still={still} suffix="次" seg={P.flat} />
                <span className="bs-alt">失敗 <b>{fmtInt(data.month.failed)}</b> 次（{data.month.calls ? ((data.month.failed / data.month.calls) * 100).toFixed(1) : "0"}%）</span>
              </section>
              <section className="bs-box bs-counter" style={{ "--acc": A.tokens } as React.CSSProperties}>
                <span className="bs-lab">本月 Token</span>
                <Digits value={fmtInt(data.month.tokens)} still={still} seg={P.flat} />
                <span className="bs-alt">經閘道的部分</span>
              </section>
              <section className="bs-box bs-counter" style={{ "--acc": A.spend } as React.CSSProperties}>
                <span className="bs-lab">本月閘道花費</span>
                <Digits value={data.month.spendUsd.toFixed(2)} still={still} prefix="US$" seg={P.flat} />
                <span className="bs-alt">約 <b>NT${fmtInt(data.month.spendUsd * FX)}</b> · 匯率 {FX.toFixed(2)}{data.fx.stale ? "（匯率超過兩天沒更新）" : ""}</span>
              </section>
            </div>

            <Box idx={3} acc={A.topo} title="流量拓撲" note="軟體 → 閘道 → 模型 · 本月呼叫次數 · 線越粗越多" src="SRC · SpendLogs × apps" className="bs-topo">
              {/* 私有素材：舞台其他地方都被面板蓋住，放這裡才看得到（壓得很暗，只當氣氛） */}
              {skin === "cmd" && assets?.mark ? <img className="bs-pmark" src={assets.mark} alt="" aria-hidden="true" /> : null}
              <div className="bs-floor" />
              <div className="bs-holo"><span className="d1" /><span className="d2" /><span className="d3" /></div>
              <div className="bs-beam" />
              <div className="bs-core" />
              <div className="bs-chart" ref={els.topo} />
              <div className="bs-hub"><b>閘道</b><small>{fmtInt(data.month.calls)}</small></div>
              <div className="bs-legend"><span><b>左</b> 軟體（各自的顏色）</span><span><b>右</b> 模型（{P.modelWord}，越亮流量越大）</span></div>
            </Box>

            <Box idx={4} acc={A.hour} title="近 24 小時每小時呼叫" note={`台北時間 · 截至 ${data.hourlyThrough}`} src="SRC · SpendLogs · 台北時區">
              <div className="bs-chart" ref={els.hour} />
            </Box>
          </div>

          <div className="bs-col bs-right">
            <Box idx={5} acc={A.rank} title="軟體費用排行" note="本月 · 美元（約台幣）" src="SRC · SpendLogs × apps">
              <div className="bs-chart" ref={els.apps} />
            </Box>
            <Box idx={6} acc={A.save} title="訂閱省下多少" note="官方 API 價目換算" src="SRC · cli_session_usage">
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
            <Box idx={7} className="bs-ev" acc={A.events} title="最近異常" note="失敗的請求＋預算告警 · 滑過暫停" src="SRC · SpendLogs · budget_alerts">
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

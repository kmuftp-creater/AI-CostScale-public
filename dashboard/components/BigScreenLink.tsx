"use client";

import { useRouter } from "next/navigation";
import { SKIN_KEY, SKIN_ORDER, SKIN_NAME, type Skin } from "@/app/bigscreen/BigScreenClient";

/**
 * 頁首的「切換到大屏」（2026-09-12）。
 *
 * User 要的是「按一下就換下一種風格」：所以這顆不是單純的連結，
 * 它先把下一種外觀寫進這台電腦的記憶，再進大屏。連按就一直換下去。
 * 大屏裡面也有同一套（頁首的「風格」），兩邊讀寫同一個鍵。
 *
 * 用 <button> 不是 <a>：它會改變狀態，而且不希望被當成可以另開分頁的連結——
 * 另開分頁時新分頁讀到的還是舊值，按鈕的語意才對得上實際行為。
 */
export default function BigScreenLink() {
  const router = useRouter();

  const go = () => {
    let next: Skin = SKIN_ORDER[0];
    try {
      const now = localStorage.getItem(SKIN_KEY) as Skin | null;
      const i = now ? SKIN_ORDER.indexOf(now) : -1;
      next = SKIN_ORDER[(i + 1) % SKIN_ORDER.length];
      localStorage.setItem(SKIN_KEY, next);
    } catch {
      /* 無痕視窗讀寫不到就用預設那一種，不要因此進不去大屏 */
    }
    router.push("/bigscreen");
  };

  return (
    <button type="button" className="btn-ghost" onClick={go} title={`切換到全畫面的營運大屏（按一下換下一種風格：${SKIN_ORDER.map((s) => SKIN_NAME[s]).join("／")}）`}>
      切換到大屏
    </button>
  );
}

"use client";

import { useSyncExternalStore } from "react";

/**
 * 亮暗切換。
 *
 * 原本是 useState ＋ useEffect 讀 DOM 回填，ESLint 的 react-hooks/set-state-in-effect
 * 會擋（在 effect 裡直接 setState）。而且那寫法有個更根本的問題：
 * **主題的真實來源是 `<html data-theme>`，不是這個元件的 state**，
 * 兩份狀態並存就有不同步的可能（例如別處改了屬性，按鈕還顯示舊的）。
 *
 * 改用 useSyncExternalStore：DOM 屬性是唯一真實來源，元件只是訂閱它。
 * 伺服器端沒有 DOM，getServerSnapshot 回暗色；補水之後 React 會自己
 * 用 getSnapshot 重讀一次並更新——這正是這個 hook 設計來處理的情境，
 * 不會產生 hydration 不一致的警告。
 */
const STORAGE_KEY = "costscale-theme";
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): boolean {
  return document.documentElement.getAttribute("data-theme") !== "light";
}

// 伺服器端沒有 document。預設暗色，與 layout 的初始值一致。
function getServerSnapshot(): boolean {
  return true;
}

export default function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    // 直接讀 DOM 而不是用 dark 這個變數：避免閉包拿到過期的值。
    const next =
      document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage 不可用時忽略，僅影響本次瀏覽的記憶
    }
    for (const notify of listeners) notify();
  }

  return (
    <button className="btn-ghost" onClick={toggle} type="button" aria-pressed={!dark}>
      {dark ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
      <span>{dark ? "亮色" : "暗色"}</span>
    </button>
  );
}

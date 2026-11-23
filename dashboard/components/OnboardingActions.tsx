"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ONBOARDING_COOKIE } from "@/lib/onboarding-core";

/**
 * 上手清單的三顆互動按鈕：收起、展開、複製指令。
 * 「收起」只記在這個瀏覽器的 cookie，不寫資料庫——換瀏覽器會再看到清單，這是刻意的。
 */

function setHidden(hidden: boolean) {
  const base = `${ONBOARDING_COOKIE}=${hidden ? "1" : ""}; path=/; SameSite=Lax`;
  document.cookie = hidden ? `${base}; max-age=31536000` : `${base}; max-age=0`;
}

export function OnboardingToggle({ hide, children }: { hide: boolean; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={hide ? "btn-ghost" : "onboard-linkbtn"}
      onClick={() => {
        setHidden(hide);
        router.refresh();
      }}
    >
      {children}
    </button>
  );
}

export function OnboardingCopy({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("ok");
        } catch {
          // clipboard API 要 https 或 localhost。失敗要講出來，請使用者自己框選。
          setState("fail");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "ok" ? "已複製" : state === "fail" ? "複製失敗，請自己框選" : "複製指令"}
    </button>
  );
}

import Link from "next/link";
import { cookies } from "next/headers";
import { getOnboarding } from "@/lib/onboarding";
import { ONBOARDING_COOKIE, type OnboardingStep } from "@/lib/onboarding-core";
import { OnboardingCopy, OnboardingToggle } from "@/components/OnboardingActions";

/**
 * 總覽頁最上方的「上手清單」。伺服器元件：每次開頁都現場查狀態，不存任何進度。
 *
 * 顯示規則：
 *   - 四步都確認完成：不顯示（除非網址帶 ?onboarding=1）。
 *   - 有任何一步未完成或無法確認：顯示。
 *   - 使用者按「先收起」後（cookie），縮成一行小字；?onboarding=1 一律展開。
 */

function StateIcon({ done }: { done: boolean | null }) {
  if (done === true) {
    return (
      <svg className="onboard-icon is-done" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 10.4l2.8 2.8L14.2 7.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (done === null) {
    return (
      <svg className="onboard-icon is-unknown" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2.5" />
        <path d="M7.8 8.2a2.3 2.3 0 114 1.4c-.7.7-1.8 1-1.8 2.2M10 14.2v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="onboard-icon is-todo" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const STATE_LABEL = (d: boolean | null) => (d === true ? "已完成" : d === null ? "無法確認" : "未完成");

function StepRow({
  step,
  index,
  curl,
}: {
  step: OnboardingStep;
  index: number;
  curl: { bash: string; powershell: string } | null;
}) {
  const state = step.done === true ? "done" : step.done === null ? "unknown" : "todo";
  return (
    <li className={`onboard-step is-${state}`} data-step={step.id} data-state={state}>
      <StateIcon done={step.done} />
      <div className="onboard-body">
        <div className="onboard-title">
          <span className="onboard-num">{index + 1}</span>
          <span>{step.title}</span>
          <span className={`onboard-state is-${state}`}>{STATE_LABEL(step.done)}</span>
        </div>
        <p className="onboard-desc">{step.desc}</p>
        <p className="onboard-note">{step.note}</p>
        {curl ? (
          <>
            <div className="microlabel" style={{ display: "block", margin: "0.6rem 0 0.25rem" }}>
              Windows PowerShell
            </div>
            <div className="onboard-curl" data-shell="powershell">
              <pre>
                <code>{curl.powershell}</code>
              </pre>
              <OnboardingCopy text={curl.powershell} />
            </div>
            <div className="microlabel" style={{ display: "block", margin: "0.6rem 0 0.25rem" }}>
              macOS／Linux（Windows 的 Git Bash 也可以）
            </div>
            <div className="onboard-curl" data-shell="bash">
              <pre>
                <code>{curl.bash}</code>
              </pre>
              <OnboardingCopy text={curl.bash} />
            </div>
          </>
        ) : null}
        {step.done === true ? null : (
          <Link className="btn-primary onboard-go" href={step.href}>
            {step.linkLabel}
          </Link>
        )}
      </div>
    </li>
  );
}

export default async function OnboardingCard({ force }: { force: boolean }) {
  let data;
  try {
    data = await getOnboarding();
  } catch (err) {
    // getOnboarding 已經保證不丟例外；這一層是最後防線，總覽頁不能因為這張卡片掛掉。
    console.warn("[onboarding] card failed:", err instanceof Error ? err.message : err);
    return null;
  }
  if (data.allDone && !force) return null;

  const hidden = !force && (await cookies()).get(ONBOARDING_COOKIE)?.value === "1";
  if (hidden) {
    return (
      <div className="onboard-folded" data-onboarding="folded">
        <span>上手清單還有 {data.remaining} 步未完成</span>
        <OnboardingToggle hide={false}>展開</OnboardingToggle>
      </div>
    );
  }

  const callStep = data.steps.find((s) => s.id === "first-call");
  return (
    <section className="block tight" data-onboarding="card">
      <div className="panel onboard-panel">
        <div className="panel-head">
          <span className="panel-title">
            上手清單　{data.doneCount}／{data.total}
          </span>
          <span className="microlabel">依實際狀態顯示，做完會自動打勾</span>
          <span className="spacer" />
          {force ? null : <OnboardingToggle hide>先收起</OnboardingToggle>}
        </div>
        <ol className="onboard-steps">
          {data.steps.map((s, i) => (
            <StepRow
              key={s.id}
              step={s}
              index={i}
              curl={
                s.id === "first-call" && callStep?.done !== true
                  ? { bash: data.curl.command, powershell: data.curl.powershell }
                  : null
              }
            />
          ))}
        </ol>
        <div className="onboard-optional">
          <div className="onboard-optional-head">接下來可以做（選用，不計入完成度）</div>
          <ul>
            {data.optional.map((o) => (
              <li key={o.id}>
                <div>
                  <strong>{o.title}</strong>
                  <span className="onboard-note">{o.desc}</span>
                </div>
                <Link className="btn-ghost" href={o.href}>
                  {o.linkLabel}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

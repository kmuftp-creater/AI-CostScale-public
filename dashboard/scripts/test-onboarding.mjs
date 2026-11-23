// 上手清單狀態函式的單元層級驗證。不需要資料庫與閘道。
// 執行（Node 22.18 以上可直接讀 .ts）：  node scripts/test-onboarding.mjs
import assert from "node:assert/strict";
import { evaluateOnboarding, summarizeProviderKeys, FALLBACK_MODEL } from "../lib/onboarding-core.ts";

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });
const ctx = { gatewayUrl: "https://gw.example.com/" };
const states = (r) => r.steps.map((s) => (s.done === true ? "done" : s.done === null ? "unknown" : "todo")).join(",");

const cases = {
  全未完成: {
    sig: {
      providerKeys: ok({ realCount: 0, totalCount: 12, model: null }),
      appCount: ok(0),
      successCalls: ok(0),
      fxAgeHours: ok(null),
    },
    expect: { states: "todo,todo,todo,todo", doneCount: 0, allDone: false, remaining: 4, model: FALLBACK_MODEL },
  },
  部分完成: {
    sig: {
      providerKeys: ok({ realCount: 1, totalCount: 12, model: "gemini-flash-free" }),
      appCount: ok(1),
      successCalls: ok(0),
      fxAgeHours: ok(30),
    },
    expect: { states: "done,done,todo,todo", doneCount: 2, allDone: false, remaining: 2, model: "gemini-flash-free" },
  },
  全完成: {
    sig: {
      providerKeys: ok({ realCount: 2, totalCount: 12, model: "groq-fast" }),
      appCount: ok(3),
      successCalls: ok(5),
      fxAgeHours: ok(3.5),
    },
    expect: { states: "done,done,done,done", doneCount: 4, allDone: true, remaining: 0, model: "groq-fast" },
  },
  某訊號丟例外: {
    sig: {
      providerKeys: ok({ realCount: 1, totalCount: 12, model: "gemini-flash-free" }),
      appCount: bad("connect ECONNREFUSED"),
      successCalls: bad("connect ECONNREFUSED"),
      fxAgeHours: ok(2),
    },
    expect: { states: "done,unknown,unknown,done", doneCount: 2, allDone: false, remaining: 2, model: "gemini-flash-free" },
  },
  全部查詢失敗: {
    sig: {
      providerKeys: bad("閘道逾時"),
      appCount: bad("db down"),
      successCalls: bad("db down"),
      fxAgeHours: bad("db down"),
    },
    expect: { states: "unknown,unknown,unknown,unknown", doneCount: 0, allDone: false, remaining: 4, model: FALLBACK_MODEL },
  },
  排程剛好26小時: {
    sig: {
      providerKeys: ok({ realCount: 1, totalCount: 1, model: null }),
      appCount: ok(1),
      successCalls: ok(1),
      fxAgeHours: ok(26),
    },
    expect: { states: "done,done,done,done", doneCount: 4, allDone: true, remaining: 0, model: FALLBACK_MODEL },
  },
};

let failed = 0;
for (const [name, c] of Object.entries(cases)) {
  try {
    const r = evaluateOnboarding(c.sig, ctx); // 不得丟例外
    assert.equal(states(r), c.expect.states);
    assert.equal(r.doneCount, c.expect.doneCount);
    assert.equal(r.allDone, c.expect.allDone);
    assert.equal(r.remaining, c.expect.remaining);
    assert.equal(r.curl.model, c.expect.model);
    assert.ok(r.curl.command.includes("https://gw.example.com/v1/chat/completions"), "curl 網址");
    assert.ok(r.curl.command.includes("sk-你的虛擬金鑰"), "curl 金鑰位置");
    for (const s of r.steps) {
      assert.ok([...s.title].length <= 16, `標題超過 16 字：${s.title}`);
      assert.ok(s.href.startsWith("/"), "每步都有連結");
      assert.ok(!/也許|可能|大概|通常/.test(s.title + s.desc + s.note), "不得有模糊詞");
    }
    if (c.expect.states.includes("unknown")) {
      const u = r.steps.find((s) => s.done === null);
      assert.ok(u.note.includes("查不到"), "無法確認要有說明");
    }
    console.log(`PASS ${name}: ${states(r)}  完成度 ${r.doneCount}/${r.total}  allDone=${r.allDone}  model=${r.curl.model}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
// T-01：金鑰盤點的摘要（閘道錯誤、橋接權杖不得算成供應商金鑰）。
const dep = (modelName) => ({ modelName, deploymentId: null });
const row = (envName, kind, tail, models) => ({ envName, kind, tail, deployments: models.map(dep) });
const probeOf = (inv) => {
  try {
    return ok(summarizeProviderKeys(inv));
  } catch (e) {
    return bad(e.message);
  }
};
const t01 = {
  "T-01 閘道錯誤時為無法確認": () => {
    // 閘道不通時橋接被歸成 provider，且 BRIDGE_TOKEN 尾碼是真值；不得算成已完成。
    const inv = {
      configError: null,
      gatewayError: "fetch failed",
      keys: [row("BRIDGE_TOKEN", "provider", "7d21", ["sub-claude", "sub-codex"])],
    };
    const r = evaluateOnboarding({ ...cases.全完成.sig, providerKeys: probeOf(inv) }, ctx);
    assert.equal(r.steps[0].done, null);
    assert.ok(r.steps[0].note.includes("查不到"));
  },
  "T-01 只有橋接權杖沒有供應商金鑰時為未完成": () => {
    const inv = {
      configError: null,
      gatewayError: null,
      keys: [
        row("BRIDGE_TOKEN", "bridge", "7d21", ["sub-claude"]),
        row("GEMINI_FREE_KEY_1", "provider", "lder", ["gemini-flash-free"]),
      ],
    };
    const r = evaluateOnboarding({ ...cases.全完成.sig, providerKeys: probeOf(inv) }, ctx);
    assert.equal(r.steps[0].done, false);
  },
  "T-01 閘道正常時橋接不計入": () => {
    const s = summarizeProviderKeys({
      configError: null,
      gatewayError: null,
      keys: [
        row("BRIDGE_TOKEN", "bridge", "7d21", ["sub-claude"]),
        row("GEMINI_FREE_KEY_1", "provider", "0Ows", ["gemini-flash-free"]),
      ],
    });
    assert.equal(s.realCount, 1);
    assert.equal(s.totalCount, 1);
  },
  "T-01 kind 被誤判為 provider 時仍靠變數名排除橋接": () => {
    const s = summarizeProviderKeys({
      configError: null,
      gatewayError: null,
      keys: [row("BRIDGE_TOKEN", "provider", "7d21", ["sub-claude"]), row("GROQ_KEY_1", "provider", "abcd", ["groq-fast"])],
    });
    assert.equal(s.realCount, 1);
  },
  "T-03 fx 空表與過期為兩種文案": () => {
    const empty = evaluateOnboarding({ ...cases.全未完成.sig, fxAgeHours: ok(null) }, ctx).steps[3].note;
    const stale = evaluateOnboarding({ ...cases.全未完成.sig, fxAgeHours: ok(40) }, ctx).steps[3].note;
    assert.ok(empty.includes("還沒有任何排程寫入的紀錄"));
    assert.ok(stale.includes("超過 26 小時"));
    assert.ok(!/也許|可能|大概|通常/.test(empty + stale));
  },
  "本機模式的步驟 1、4 說明改成本機做法，不叫人去主機設 cron": () => {
    const lctx = { ...ctx, local: true };
    const r = evaluateOnboarding(cases.全未完成.sig, lctx);
    const t = r.steps.map((x) => x.desc + x.note).join(" ");
    assert.ok(r.steps[0].note.includes("docker-compose.setup.yml"), "步驟 1 要教本機加金鑰的做法");
    assert.ok(!r.steps[0].note.includes("驗證並排入套用"), "步驟 1 不得叫人用網頁新增上游金鑰");
    assert.ok(r.steps[3].desc.includes("scheduler"), "步驟 4 要說是排程容器");
    assert.ok(r.steps[3].note.includes("docker compose logs scheduler"));
    assert.ok(!/INSTALL.md 第 7 節|crontab|主機上的排程/.test(t), "本機模式不得提到主機排程");
    assert.ok(!/也許|可能|大概|通常/.test(t));
    const stale = evaluateOnboarding({ ...cases.全未完成.sig, fxAgeHours: ok(40) }, lctx).steps[3].note;
    assert.ok(stale.includes("Docker Desktop") && stale.includes("超過 26 小時"));
    // 沒帶 local 時維持原樣
    const v = evaluateOnboarding(cases.全未完成.sig, ctx);
    assert.ok(v.steps[0].note.includes("驗證並排入套用") && v.steps[3].note.includes("INSTALL.md 第 7 節"));
  },
};
for (const [name, fn] of Object.entries(t01)) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(failed ? `${failed} 個案例失敗` : "全部通過");
process.exit(failed ? 1 : 0);

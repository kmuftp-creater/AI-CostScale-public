// 上手清單狀態函式的單元層級驗證。不需要資料庫與閘道。
// 執行（Node 22.18 以上可直接讀 .ts）：  node scripts/test-onboarding.mjs
import assert from "node:assert/strict";
import { evaluateOnboarding, FALLBACK_MODEL } from "../lib/onboarding-core.ts";

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
console.log(failed ? `${failed} 個案例失敗` : "全部通過");
process.exit(failed ? 1 : 0);

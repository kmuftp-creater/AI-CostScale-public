/**
 * 訂閱模型失效檢查（2026-11-10）。
 *
 * 起因：sub-agy-claude 指定的模型被上游移除後，通道一直回 502，
 * 沒有任何通知，要到有人實測才發現。
 *
 * 兩種偵測來源，都不消耗訂閱額度：
 *   1. 每日比對清單：Antigravity 問 `agy models`，Codex 讀 CLI 自己的 models_cache.json。
 *   2. 監看實際呼叫：CLI 回「模型不存在」時記下來，同一個模型之後成功就清掉。
 *      Claude Code 沒有可讀的模型清單，只能靠這條。
 *
 * 「讀不到清單」要算問題，不能當成沒事，否則檢查壞掉時看起來一切正常。
 * 同一組問題只通知一次，問題改變或全部解除時才再寄。寄送失敗下一輪重試。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILURE_TTL_MS = 3 * DAY;
const CODEX_CACHE_MAX_AGE_MS = 7 * DAY;
const FIRST_RUN_DELAY_MS = 60_000;

const INVALID_MODEL_RE =
  /unrecognized_model|issue with the selected model|not recognized as a known model|invalid model|model.{0,60}(not found|does not exist|not supported)/i;

/** 讀 Codex CLI 的模型快取。太舊要報錯，舊清單比對出來的「沒問題」不可信。 */
function readCodexSlugs({ cachePath = path.join(os.homedir(), ".codex", "models_cache.json"), now = Date.now() } = {}) {
  const d = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const slugs = (d.models || []).map((m) => m.slug).filter(Boolean);
  if (slugs.length === 0) throw new Error("模型快取是空的");
  const age = now - Date.parse(d.fetched_at);
  if (!(age < CODEX_CACHE_MAX_AGE_MS)) throw new Error(`模型快取超過 7 天沒更新（${d.fetched_at}）`);
  return slugs;
}

/** 解析 `agy models` 的輸出：每行「模型 id<Tab>顯示名稱」。 */
function parseAgyModels(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.split("\t")[0].trim())
    .filter((id) => /^[a-z0-9][a-z0-9.-]*$/.test(id));
}

/** VPS 的 SSH 位址，與 supervisor.ps1 讀同一個使用者環境變數 COSTSCALE_VPS_SSH。 */
function vpsHostFromSupervisor() {
  const host = (process.env.COSTSCALE_VPS_SSH || "").trim();
  if (!host) throw new Error("沒有設定 COSTSCALE_VPS_SSH，無法寄送通知（設定方式見 INSTALL.md）");
  return host;
}

/** 走 VPS 既有的告警端點寄信，本機不存 SMTP 帳密。成功回 true。 */
function sendAlertViaVps(subject, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ subject, body }), "utf8").toString("base64");
    const script = [
      "set -u",
      "cd /opt/costscale || exit 1",
      "set -a; . ./.env; set +a",
      `echo '${payload}' | base64 -d | curl -s -m 30 -X POST -H "Authorization: Bearer $ALERT_CRON_TOKEN" -H "Content-Type: application/json" --data-binary @- -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/api/alerts/bridge`,
      "",
    ].join("\n");
    let host;
    try {
      host = vpsHostFromSupervisor();
    } catch (e) {
      console.error(`[model-check] ${e.message}`);
      resolve(false);
      return;
    }
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "bash -s"], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(out.trim().endsWith("200")));
    child.stdin.end(script);
  });
}

function createModelCheck({ providers, statePath, listAgyModels, readCodex = readCodexSlugs, sendAlert = sendAlertViaVps, now = () => Date.now() }) {
  let state = { lastCheckAt: 0, listProblems: [], unavailable: [], failures: {}, alertedKey: "" };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
  } catch {
    // 第一次執行沒有狀態檔，用預設值。
  }

  function save() {
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error(`[model-check] 寫不進狀態檔：${e.message}`);
    }
  }

  async function checkLists() {
    const listProblems = [];
    const unavailable = [];
    const compare = (cli, source, ids) => {
      for (const [model, p] of Object.entries(providers)) {
        if (p.cli === cli && p.cliModel && !ids.includes(p.cliModel)) {
          listProblems.push({ model, cliModel: p.cliModel, source });
        }
      }
    };
    try {
      compare("gemini", "Antigravity", await listAgyModels());
    } catch (e) {
      unavailable.push({ source: "Antigravity", message: e.message });
    }
    try {
      compare("codex", "Codex", readCodex());
    } catch (e) {
      unavailable.push({ source: "Codex", message: e.message });
    }
    state.listProblems = listProblems;
    state.unavailable = unavailable;
    state.lastCheckAt = now();
  }

  function compose() {
    const dead = new Map();
    for (const p of state.listProblems) dead.set(p.model, `${p.source} 的清單已沒有 ${p.cliModel}`);
    for (const [model, f] of Object.entries(state.failures)) {
      if (!dead.has(model)) dead.set(model, `實際呼叫回報模型不存在：${f.message}`);
    }
    const key = [
      ...[...dead.keys()].sort().map((m) => `dead:${m}`),
      ...state.unavailable.map((u) => `unavailable:${u.source}`).sort(),
    ].join("|");
    return { dead, key };
  }

  async function tick() {
    if (now() - state.lastCheckAt >= DAY) await checkLists();
    for (const [model, f] of Object.entries(state.failures)) {
      if (now() - f.at > FAILURE_TTL_MS) delete state.failures[model];
    }
    const { dead, key } = compose();
    if (key !== state.alertedKey) {
      const lines = [];
      if (dead.size > 0) {
        lines.push("以下訂閱模型目前打不通：", "");
        for (const [model, why] of dead) lines.push(`- ${model}：${why}`);
        lines.push("", "處理方式：在 Claude Code 請它把這個模型改指向新模型，或從清單下架。改指向的話專案不用動。");
      }
      if (state.unavailable.length > 0) {
        lines.push("", "以下來源這次無法檢查，結果不代表正常：", "");
        for (const u of state.unavailable) lines.push(`- ${u.source}：${u.message}`);
      }
      const subject = key
        ? `CostScale 訂閱模型需要處理（失效 ${dead.size} 個，無法檢查 ${state.unavailable.length} 個）`
        : "CostScale 訂閱模型問題已解除";
      const text = key ? lines.join("\n").trim() : "先前回報的訂閱模型問題都已解除。";
      if (await sendAlert(subject, text)) state.alertedKey = key;
      else console.error("[model-check] 通知寄送失敗，下一輪重試");
    }
    save();
  }

  function safeTick() {
    tick().catch((e) => console.error(`[model-check] 檢查失敗：${e.message}`));
  }

  return {
    tick,
    state: () => state,
    noteFailure(model, message) {
      if (providers[model] && INVALID_MODEL_RE.test(String(message))) {
        state.failures[model] = { message: String(message).slice(0, 200), at: now() };
        save();
      }
    },
    noteSuccess(model) {
      if (state.failures[model]) {
        delete state.failures[model];
        save();
      }
    },
    start() {
      setTimeout(safeTick, FIRST_RUN_DELAY_MS).unref();
      setInterval(safeTick, HOUR).unref();
    },
  };
}

module.exports = { createModelCheck, parseAgyModels, readCodexSlugs, sendAlertViaVps, vpsHostFromSupervisor };

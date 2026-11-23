#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/litellm-entry.py 的單元驗證：只填 1 把金鑰時佔位部署被拿掉，填滿時什麼都不動。
執行：python -I scripts/test-litellm-entry.py
（filter_deployments 是純函式，不需要 yaml 模組；build_config 的部分在有 yaml 模組時才跑。）
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("litellm_entry", os.path.join(HERE, "litellm-entry.py"))
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

passed = 0


def ok(name):
    global passed
    passed += 1
    print("  通過  " + name)


def dep(name, env=None, model="gemini/x"):
    p = {"model": model}
    if env:
        p["api_key"] = "os.environ/" + env
    return {"model_name": name, "litellm_params": p}


GEMINI = ["GEMINI_FREE_KEY_%d" % i for i in range(1, 6)]
GROQ = ["GROQ_KEY_%d" % i for i in range(1, 4)]


def sample():
    ml = [dep("gemini-flash-free", e) for e in GEMINI]
    ml += [dep("groq-large", e) for e in GROQ] + [dep("groq-fast", e) for e in GROQ]
    ml += [dep("openrouter-auto", "OPENROUTER_API_KEY"), dep("gemini-studio-paid", "GEMINI_PAID_KEY")]
    ml += [dep("gemini-3.1-flash-lite", None, "vertex_ai/x"), dep("sub-claude", "BRIDGE_TOKEN")]
    return ml


def names(ml, model):
    return [d["litellm_params"]["api_key"].split("/")[1] for d in ml if d["model_name"] == model]


# 1. 只填 1 把 Gemini：另外 4 個佔位部署被拿掉
env = {k: "placeholder" for k in GEMINI + GROQ + ["OPENROUTER_API_KEY", "GEMINI_PAID_KEY"]}
env["GEMINI_FREE_KEY_1"] = "AIza-fake-real-key-1"
env["BRIDGE_TOKEN"] = "a" * 48
kept, dropped = entry.filter_deployments(sample(), env)
assert names(kept, "gemini-flash-free") == ["GEMINI_FREE_KEY_1"], names(kept, "gemini-flash-free")
assert sorted(e for n, e in dropped if n == "gemini-flash-free") == GEMINI[1:]
ok("只填 1 把：gemini-flash-free 只剩第 1 個部署")

# 2. 一把真金鑰都沒有的模型維持原狀（Groq 沒填、OpenRouter 沒填、付費金鑰沒填）
assert names(kept, "groq-large") == GROQ and names(kept, "groq-fast") == GROQ
assert names(kept, "openrouter-auto") == ["OPENROUTER_API_KEY"]
assert names(kept, "gemini-studio-paid") == ["GEMINI_PAID_KEY"]
ok("沒有任何真金鑰的模型（Groq、OpenRouter、付費金鑰）維持原狀，行為與以前相同")

# 3. 沒有 api_key 的部署（Vertex）與橋接不受影響
assert any(d["model_name"] == "gemini-3.1-flash-lite" for d in kept)
assert names(kept, "sub-claude") == ["BRIDGE_TOKEN"]
ok("Vertex 部署與橋接部署不受影響")

# 4. 填滿 5 把：沒有任何部署被拿掉，回傳的清單與原本一模一樣
env2 = dict(env)
for i, k in enumerate(GEMINI):
    env2[k] = "AIza-fake-%d" % i
kept2, dropped2 = entry.filter_deployments(sample(), env2)
assert [e for n, e in dropped2 if n == "gemini-flash-free"] == []
assert names(kept2, "gemini-flash-free") == GEMINI
ok("填滿 5 把：沒有部署被拿掉，順序不變")

# 5. 填第 1、3 把：保留 1、3，順序不變
env3 = dict(env)
env3["GEMINI_FREE_KEY_3"] = "AIza-fake-3"
kept3, _ = entry.filter_deployments(sample(), env3)
assert names(kept3, "gemini-flash-free") == ["GEMINI_FREE_KEY_1", "GEMINI_FREE_KEY_3"]
ok("填第 1、3 把：保留這兩個，順序不變")

# 6. Groq 只填 1 把：groq-large 與 groq-fast 都只剩那一把
env4 = dict(env)
env4["GROQ_KEY_2"] = "gsk-fake"
kept4, _ = entry.filter_deployments(sample(), env4)
assert names(kept4, "groq-large") == ["GROQ_KEY_2"] and names(kept4, "groq-fast") == ["GROQ_KEY_2"]
ok("Groq 只填 1 把：兩個模型都只剩那一把")

# 7. 各種佔位寫法
for v in (None, "", "   ", "placeholder", "PLACEHOLDER", "change-me", "Change-Me-xx", "sk-change-me"):
    assert entry.is_placeholder(v), repr(v)
for v in ("AIzaSyReal", "gsk_abc", "sk-abc"):
    assert not entry.is_placeholder(v), repr(v)
ok("佔位值的判斷：空值、placeholder、change-me 開頭（不分大小寫）")

# 8. build_config：有 yaml 模組時，實際讀寫設定檔
try:
    import yaml  # noqa: F401
except ImportError:
    print("  略過  build_config（這個環境沒有 yaml 模組）")
else:
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "config.yaml")
        dst = os.path.join(d, "out.yaml")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 註解\nmodel_list:\n" + "".join(
                "  - model_name: gemini-flash-free\n    litellm_params:\n      model: gemini/x\n      api_key: os.environ/%s\n      rpm: 10\n" % k
                for k in GEMINI) + "general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n")
        e = {k: "placeholder" for k in GEMINI}
        e["GEMINI_FREE_KEY_1"] = "real"
        out = entry.build_config(src, dst, e)
        assert out == dst
        cfg = yaml.safe_load(open(dst, encoding="utf-8"))
        assert [x["litellm_params"]["api_key"] for x in cfg["model_list"]] == ["os.environ/GEMINI_FREE_KEY_1"]
        assert cfg["model_list"][0]["litellm_params"]["rpm"] == 10
        assert cfg["general_settings"]["master_key"] == "os.environ/LITELLM_MASTER_KEY"
        assert "real" not in open(dst, encoding="utf-8").read(), "暫存設定檔不得含金鑰值"
        e2 = {k: "k%d" % i for i, k in enumerate(GEMINI)}
        assert entry.build_config(src, os.path.join(d, "out2.yaml"), e2) == src, "填滿時要直接用原檔"
        assert not os.path.exists(os.path.join(d, "out2.yaml"))
        assert entry.build_config(os.path.join(d, "不存在.yaml"), dst, e2) == os.path.join(d, "不存在.yaml")
    ok("build_config：只留真金鑰的部署、其餘設定原樣、不寫入金鑰值；填滿與讀不到檔都退回原檔")

print("\n全部通過（%d 組）" % passed)

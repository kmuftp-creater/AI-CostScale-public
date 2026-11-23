#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本機設定工具（scripts/local-setup.py）的行為驗證：在暫存資料夾用非互動模式實際執行它。
執行：python -I scripts/test-local-setup.py
用到的金鑰與密碼都是測試用的假值，只存在暫存資料夾，測完刪除。
"""
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(HERE, "local-setup.py")
FAKE_PW = "test-only-password-123"
FAKE_KEY_A = "AIzaFAKE-test-key-AAAAAAAAAAAAAAAAAAAA0001"
FAKE_KEY_B = "AIzaFAKE-test-key-BBBBBBBBBBBBBBBBBBBB0002"

passed = 0


def ok(name):
    global passed
    passed += 1
    print("  通過  " + name)


def run(work, extra_env=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CS_")}
    env.update({"CS_WORK_DIR": work, "CS_NONINTERACTIVE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"})
    env.update(extra_env or {})
    r = subprocess.run([sys.executable, "-I", "-X", "utf8", "-u", TOOL], env=env, capture_output=True, text=True, encoding="utf-8",
                       stdin=subprocess.DEVNULL, timeout=120)
    return r.returncode, r.stdout + r.stderr


def read_env(work):
    d = {}
    with open(os.path.join(work, ".env"), encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line.rstrip("\n"))
            if m:
                d[m.group(1)] = m.group(2)
    return d


def new_work():
    w = tempfile.mkdtemp(prefix="cs-setup-test-")
    for f in (".env.example", "litellm-config.yaml"):
        shutil.copy(os.path.join(ROOT, f), os.path.join(w, f))
    return w


def tails(work):
    with open(os.path.join(work, "spool", "upstream-keys", "_tails.json"), encoding="utf-8") as f:
        return json.load(f)["tails"]


work = new_work()
try:
    # 1. 建立新 .env：網段是隨機的私有 /24，閘道是 .1，避開常撞的範圍
    code, out = run(work, {"CS_ADMIN_PASSWORD": FAKE_PW, "CS_GEMINI_FREE_KEY": FAKE_KEY_A})
    assert code == 0, out
    env = read_env(work)
    net = ipaddress.ip_network(env["COSTSCALE_SUBNET"])
    assert net.prefixlen == 24 and net.is_private and net.network_address.packed[0] == 10, net
    assert env["COSTSCALE_GATEWAY"] == str(net.network_address + 1)
    for bad in ("10.0.0.0/24", "10.87.213.0/24", "192.168.0.0/24", "192.168.1.0/24", "172.16.0.0/12"):
        assert not net.overlaps(ipaddress.ip_network(bad)), "%s 撞到 %s" % (net, bad)
    assert FAKE_KEY_A not in out and FAKE_PW not in out, "畫面輸出不得含金鑰與密碼"
    assert "第一次要下載映像並建置" in out, "第一次建立 .env 要說明第一次建置"
    ok("新建 .env：隨機私有 /24，閘道為 .1，避開常撞的範圍；畫面沒有金鑰與密碼")

    # 2. 連挑 200 次，都合格且不全相同
    spec = importlib.util.spec_from_file_location("local_setup", TOOL)
    mod = importlib.util.module_from_spec(spec)
    os.environ["CS_WORK_DIR"] = work
    spec.loader.exec_module(mod)
    picked = set()
    for _ in range(200):
        n, g = mod.pick_subnet()
        nn = ipaddress.ip_network(n)
        assert nn.is_private and nn.prefixlen == 24 and g == str(nn.network_address + 1)
        assert not mod.subnet_problem(nn)
        picked.add(n)
    assert len(picked) > 100, len(picked)
    ok("連挑 200 次：全部合格，且有 %d 種不同結果" % len(picked))

    # 3. 使用者給的網段：合格接受，不合格拒絕
    assert mod.valid_subnet("10.97.45.0/24") == ("10.97.45.0/24", "10.97.45.1")
    for bad in ("10.97.45.0/16", "8.8.8.0/24", "abc", "10.97.45.5/24", "192.168.1.0/24", "172.20.0.0/24", "10.87.213.0/24"):
        try:
            mod.valid_subnet(bad)
        except mod.Fail:
            continue
        raise AssertionError("應該拒絕：" + bad)
    ok("CS_SUBNET 檢查：私有 /24 接受；非私有、非 /24、格式錯、落在常撞範圍都拒絕")

    # 4. 尾碼表：只有供應商金鑰，沒有主金鑰與橋接 token，也沒有 VERTEX_PROJECT 這類非金鑰
    t = tails(work)
    assert "LITELLM_MASTER_KEY" not in t and "BRIDGE_TOKEN" not in t, sorted(t)
    assert t.get("GEMINI_FREE_KEY_1") == FAKE_KEY_A[-4:]
    assert t.get("GEMINI_FREE_KEY_2") == "lder"
    assert all(re.fullmatch(r"(GEMINI|GROQ)_.*KEY.*|OPENROUTER_API_KEY|GEMINI_PAID_KEY", k) for k in t), sorted(t)
    ok("_tails.json 只含供應商金鑰（%d 欄），不含主金鑰與橋接 token" % len(t))
    if os.name == "posix":
        mode = os.stat(os.path.join(work, "spool", "upstream-keys", "_tails.json")).st_mode & 0o777
        assert mode in (0o640, 0o644), oct(mode)
        ok("_tails.json 權限 %s（其他人不可寫）" % oct(mode))

    # 5. 補第 2 把金鑰，再移除它：改回 placeholder，尾碼表跟著更新，其他金鑰不動
    code, out = run(work, {"CS_ACTION": "add-key", "CS_GEMINI_FREE_KEY": FAKE_KEY_B})
    assert code == 0 and read_env(work)["GEMINI_FREE_KEY_2"] == FAKE_KEY_B, out
    assert FAKE_KEY_B not in out
    code, out = run(work, {"CS_ACTION": "remove-key", "CS_REMOVE_KEY": "GEMINI_FREE_KEY_2"})
    assert code == 0, out
    env = read_env(work)
    assert env["GEMINI_FREE_KEY_2"] == "placeholder" and env["GEMINI_FREE_KEY_1"] == FAKE_KEY_A
    assert tails(work)["GEMINI_FREE_KEY_2"] == "lder" and tails(work)["GEMINI_FREE_KEY_1"] == FAKE_KEY_A[-4:]
    assert "docker compose up -d" in out and FAKE_KEY_B not in out
    ok("移除金鑰：欄位改回 placeholder、其他金鑰不動、尾碼表更新、畫面不含金鑰")

    # 6. 移除的錯誤情形
    code, out = run(work, {"CS_ACTION": "remove-key", "CS_REMOVE_KEY": "GEMINI_FREE_KEY_2"})
    assert code == 1 and "Status" in out and "沒有金鑰" in out, out
    code, out = run(work, {"CS_ACTION": "remove-key", "CS_REMOVE_KEY": "LITELLM_MASTER_KEY"})
    assert code == 1 and "金鑰欄位名" in out, out
    code, out = run(work, {"CS_ACTION": "remove-key"})
    assert code == 1 and "CS_REMOVE_KEY" in out, out
    ok("移除金鑰的錯誤：沒有金鑰、不是金鑰欄位、沒指定，都以 Status／Root Cause 格式拒絕")

    # 7. 換網段：隨機與指定，.env 其他內容不動
    before = read_env(work)
    code, out = run(work, {"CS_ACTION": "subnet"})
    assert code == 0, out
    after = read_env(work)
    assert after["COSTSCALE_SUBNET"] != before["COSTSCALE_SUBNET"]
    assert after["COSTSCALE_GATEWAY"] == str(ipaddress.ip_network(after["COSTSCALE_SUBNET"]).network_address + 1)
    assert {k: v for k, v in after.items() if not k.startswith("COSTSCALE_")} == {k: v for k, v in before.items() if not k.startswith("COSTSCALE_")}
    assert "docker compose down" in out
    code, out = run(work, {"CS_ACTION": "subnet", "CS_SUBNET": "10.97.45.0/24"})
    assert code == 0 and read_env(work)["COSTSCALE_SUBNET"] == "10.97.45.0/24" and read_env(work)["COSTSCALE_GATEWAY"] == "10.97.45.1", out
    code, out = run(work, {"CS_ACTION": "subnet", "CS_SUBNET": "192.168.1.0/24"})
    assert code == 1 and "Status" in out, out
    ok("換網段：隨機與指定都只動兩個網段欄位；不合格的網段被拒絕；提示 down 再 up")

    # 8. 已有 .env 重跑：結尾不再說第一次要下載映像並建置
    code, out = run(work)
    assert code == 0, out
    assert "第一次要下載映像" not in out and "--build" not in out, out
    assert "docker compose up -d" in out
    ok("已有 .env 重跑：結尾只提 docker compose up -d，不再說第一次要建置")

    # 9. 非互動又缺密碼：提示改在 PowerShell 或終端機執行
    w2 = new_work()
    try:
        code, out = run(w2, {})
        assert code == 1 and "PowerShell 或終端機" in out and "CS_ADMIN_PASSWORD" in out, out
        assert not os.path.exists(os.path.join(w2, ".env")), "失敗時不得留下 .env"
    finally:
        shutil.rmtree(w2, ignore_errors=True)
    ok("非互動又缺密碼：訊息提示改在 PowerShell 或終端機執行，且不留下半份 .env")

    # 10. 舊 .env（沒有網段欄位）重跑：不自動加網段，避免改動既有安裝
    with open(os.path.join(work, ".env"), encoding="utf-8") as f:
        lines = [l for l in f.read().split("\n") if not l.startswith("COSTSCALE_SUBNET=") and not l.startswith("COSTSCALE_GATEWAY=")]
    with open(os.path.join(work, ".env"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    code, out = run(work)
    assert code == 0 and "COSTSCALE_SUBNET" not in read_env(work), out
    ok("舊 .env 沒有網段欄位：重跑不會自動加，維持預設網段")
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n全部通過（%d 組）" % passed)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本機安裝模式的設定工具（在容器裡執行，不需要 bash，Windows、Mac、Linux 的做法相同）。

用法（在專案資料夾執行，只需要 Docker）：
    docker compose -f docker-compose.setup.yml run --rm setup

做的事：
    1. 還沒有 .env：問管理員帳號、密碼、一把 AI 金鑰（可跳過），產生 .env（亂數祕密自動產生）。
    2. 已經有 .env：不覆蓋。互動時給選單（補欄位、新增 AI 金鑰、改帳號或密碼、改埠），
       非互動時只補缺少的欄位，另外依 CS_ACTION 做指定的動作。
    3. 把每把金鑰的尾 4 碼寫進 spool/upstream-keys/_tails.json，儀表板的上手清單與金鑰管理頁靠它判斷
       「金鑰有沒有填」（雲端主機版是 scripts/apply-upstream-key.py 寫的，本機模式沒有那支排程）。

非互動（環境變數，缺必要值會報錯結束）：
    CS_ACTION           init（預設）| add-key | password | ports
    CS_ADMIN_USER       管理員帳號，省略時沿用 .env 現有的，沒有就是 admin
    CS_ADMIN_PASSWORD   管理員密碼（至少 10 個字元）。init 在 .env 還沒有可用帳密時必填；password 必填
    CS_GEMINI_FREE_KEY  Gemini 免費金鑰（填進第一個還是空的 GEMINI_FREE_KEY_n）
    CS_GROQ_KEY         Groq 金鑰（GROQ_KEY_n）
    CS_OPENROUTER_KEY   OpenRouter 金鑰（OPENROUTER_API_KEY）
    CS_GEMINI_PAID_KEY  Gemini 付費金鑰（GEMINI_PAID_KEY）
    CS_DASH_PORT、CS_GATEWAY_PORT、CS_DB_PORT   儀表板、閘道、資料庫在這台電腦上的埠（預設 3000、4000、5442）

密碼與金鑰不會印到畫面，.env 只存密碼的 scrypt 雜湊。
雜湊算法與 scripts/set-admin-password.sh 相同（N=16384、r=8、p=1、32 位元組、16 位元組亂數 salt），
格式要與 dashboard/lib/admin-password.ts 相容，由 dashboard/scripts/test-admin-password.mjs 驗證互通。

只用 Python 標準函式庫，在 python:3.12-slim 裡執行。檔案本身對 CRLF 不敏感（Python 直譯器兩種換行都收）。
"""
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
from datetime import datetime

WORK = os.environ.get("CS_WORK_DIR", "/work")
ENV_PATH = os.path.join(WORK, ".env")
EXAMPLE_PATH = os.path.join(WORK, ".env.example")
CONFIG_PATH = os.path.join(WORK, "litellm-config.yaml")
SPOOL_DIR = os.path.join(WORK, "spool", "upstream-keys")

ADMIN_MIN_PASSWORD = 10
ADMIN_MAX_PASSWORD = 256
ADMIN_USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")
ADMIN_USER_RULE = "只收英數與 . _ -，要以英數開頭，3 到 32 個字元"
HASH_FORMAT_RE = re.compile(r"^scrypt:(16384|32768|65536):[1-8]:[1-4]:[0-9a-f]{32,128}:[0-9a-f]{64}$")
AUTH_SECRET_MIN_LENGTH = 32

DEFAULT_PORTS = {"DASH_PORT": 3000, "GATEWAY_PORT": 4000, "DB_PORT": 5442}
PORT_LABELS = {"DASH_PORT": "儀表板", "GATEWAY_PORT": "閘道", "DB_PORT": "資料庫"}
PORT_ENV = {"DASH_PORT": "CS_DASH_PORT", "GATEWAY_PORT": "CS_GATEWAY_PORT", "DB_PORT": "CS_DB_PORT"}

# 供應商 → (選單名稱, 環境變數名清單, 非互動用的環境變數)
PROVIDERS = [
    ("gemini", "Google AI Studio 免費額度（Gemini）", ["GEMINI_FREE_KEY_%d" % i for i in range(1, 6)], "CS_GEMINI_FREE_KEY"),
    ("groq", "Groq", ["GROQ_KEY_%d" % i for i in range(1, 4)], "CS_GROQ_KEY"),
    ("openrouter", "OpenRouter", ["OPENROUTER_API_KEY"], "CS_OPENROUTER_KEY"),
    ("gemini-paid", "Google AI Studio 付費金鑰（Gemini）", ["GEMINI_PAID_KEY"], "CS_GEMINI_PAID_KEY"),
]

RANDOM_FIELDS = ["DB_PASSWORD", "AUTH_SECRET", "ALERT_CRON_TOKEN", "OTEL_INGEST_TOKEN", "BRIDGE_TOKEN"]

INTERACTIVE = sys.stdin.isatty() and sys.stdout.isatty() and os.environ.get("CS_NONINTERACTIVE") != "1"


class Fail(Exception):
    """要讓使用者知道的錯誤。訊息不得含密碼與金鑰。"""


def say(msg=""):
    print(msg, flush=True)


# ───────────────────────── 雜湊與檢查（要與 set-admin-password.sh、secret-check.ts 一致）─────────────────────────

def make_hash(password):
    salt = os.urandom(16)
    h = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return "scrypt:16384:8:1:%s:%s" % (salt.hex(), h.hex())


def secret_unset(value):
    v = (value or "").strip().lower()
    return v == "" or v == "placeholder" or v.startswith("change-me") or v.startswith("sk-change-me")


def auth_secret_bad(value):
    return secret_unset(value) or len((value or "").strip()) < AUTH_SECRET_MIN_LENGTH


def password_problem(pw):
    """回傳不合格的原因；合格回 None。長度以字元數算（與 bash 版、儀表板一致）。"""
    if len(pw) < ADMIN_MIN_PASSWORD:
        return "密碼至少要 %d 個字元（現在 %d 個）" % (ADMIN_MIN_PASSWORD, len(pw))
    if len(pw) > ADMIN_MAX_PASSWORD:
        return "密碼最多 %d 個字元" % ADMIN_MAX_PASSWORD
    if re.search(r"[\x00-\x1f\x7f]", pw):
        return "密碼不能含換行或其他控制字元"
    return None


def key_problem(value):
    """AI 金鑰的檢查：會原樣寫進 .env，所以不能含空白、引號、$、反引號。"""
    if not value:
        return "金鑰是空的"
    if len(value) > 400:
        return "金鑰太長（最多 400 個字元）"
    if re.search(r"[\s'\"$`]", value):
        return "金鑰不能含空白、引號、$ 與反引號"
    if value[0] == "<" or value[-1] == ">":
        return "金鑰前後有角括號。只貼值本身，不要連符號一起貼"
    if secret_unset(value):
        return "這看起來是範本的佔位字，不是真的金鑰"
    return None


# ───────────────────────── .env 讀寫 ─────────────────────────

class EnvFile:
    """以「行」為單位的 .env 模型：只改指定欄位，其他行（含註解）原樣保留。"""

    def __init__(self, text=""):
        text = text.lstrip("﻿")
        self.lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if self.lines and self.lines[-1] == "":
            self.lines.pop()
        self.changed = False

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            return cls(f.read())

    def _index(self, key):
        prefix = key + "="
        for i, line in enumerate(self.lines):
            if line.startswith(prefix):
                return i
        return -1

    def has(self, key):
        return self._index(key) >= 0

    def get(self, key):
        i = self._index(key)
        if i < 0:
            return ""
        v = self.lines[i][len(key) + 1:].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        return v

    def set(self, key, value):
        if "\n" in value or "\r" in value:
            raise Fail("欄位 %s 的值含有換行，無法寫入 .env" % key)
        line = "%s=%s" % (key, value)
        i = self._index(key)
        if i >= 0:
            if self.lines[i] == line:
                return False
            self.lines[i] = line
        else:
            self.lines.append(line)
        self.changed = True
        return True

    def append_comment(self, *comments):
        self.lines.extend(comments)
        self.changed = True

    def pairs(self):
        out = {}
        for line in self.lines:
            m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
            if m:
                v = m.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[m.group(1)] = v
        return out

    def render(self):
        return "\n".join(self.lines) + "\n"


def owner_of_work():
    try:
        st = os.stat(WORK)
        return st.st_uid, st.st_gid
    except OSError:
        return None


def fix_owner(path):
    """設定容器以 root 執行，建立的檔案要交還給專案資料夾的擁有者（Linux 上才有差別）。"""
    own = owner_of_work()
    if own is None:
        return
    try:
        os.chown(path, own[0], own[1])
    except (OSError, AttributeError):
        pass


def atomic_write(path, text, mode=0o600):
    """寫到同目錄暫存檔，設好權限，再取代目標。中途失敗不會留下半份檔案。"""
    d = os.path.dirname(path)
    tmp = os.path.join(d, ".%s.tmp.%s" % (os.path.basename(path), secrets.token_hex(4)))
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        fix_owner(tmp)
        os.replace(tmp, path)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise Fail("寫入 %s 失敗（%s）。原本的檔案沒有被更動。" % (os.path.basename(path), e.strerror or e))


def save_env(env):
    atomic_write(ENV_PATH, env.render(), 0o600)


# ───────────────────────── 尾碼表（給儀表板看的）─────────────────────────

def write_tails(env):
    """寫 spool/upstream-keys/_tails.json：設定檔引用到的每個環境變數的「尾 4 碼」。格式與 apply-upstream-key.py 相同。"""
    names = set()
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            names = set(re.findall(r"os\.environ/([A-Z][A-Z0-9_]*)", f.read()))
    except OSError:
        pass
    pairs = env.pairs()
    tails = {k: v[-4:] for k, v in pairs.items() if k in names}
    os.makedirs(SPOOL_DIR, exist_ok=True)
    for d in (os.path.join(WORK, "spool"), SPOOL_DIR):
        fix_owner(d)
        try:
            os.chmod(d, 0o755)
        except OSError:
            pass
    p = os.path.join(SPOOL_DIR, "_tails.json")
    atomic_write(p, json.dumps({"tails": tails, "at": datetime.now().astimezone().isoformat()}), 0o644)


# ───────────────────────── 問答 ─────────────────────────

def ask(prompt, default=""):
    if not INTERACTIVE:
        raise Fail("目前不是互動模式，沒辦法問「%s」。請改用環境變數提供。" % prompt)
    try:
        v = input(prompt).strip()
    except EOFError:
        raise Fail("讀不到輸入。")
    return v or default


def ask_secret(prompt):
    if not INTERACTIVE:
        raise Fail("目前不是互動模式，沒辦法問「%s」。請改用環境變數提供。" % prompt)
    try:
        return getpass.getpass(prompt)
    except EOFError:
        raise Fail("讀不到輸入。")


def take_env(name):
    """讀一個環境變數並立刻從本行程的環境移除，之後啟動的子行程看不到它。"""
    v = os.environ.pop(name, None)
    return v if v else None


def get_admin_user(env, from_env_user):
    cur = env.get("AUTH_ADMIN_USER") if env else ""
    default = cur or "admin"
    if from_env_user is not None:
        if not ADMIN_USER_RE.match(from_env_user):
            raise Fail("帳號格式不對：%s。" % ADMIN_USER_RULE)
        return from_env_user
    if not INTERACTIVE:
        return default
    while True:
        u = ask("管理員帳號（直接按 Enter 用 %s）：" % default, default)
        if ADMIN_USER_RE.match(u):
            return u
        say("  帳號格式不對：%s。請再輸入一次。" % ADMIN_USER_RULE)


def get_admin_password(from_env_pw, label="管理員密碼"):
    if from_env_pw is not None:
        why = password_problem(from_env_pw)
        if why:
            raise Fail(why + "。")
        return from_env_pw
    if not INTERACTIVE:
        raise Fail("缺少 CS_ADMIN_PASSWORD：非互動模式一定要提供%s（至少 %d 個字元）。" % (label, ADMIN_MIN_PASSWORD))
    while True:
        pw = ask_secret("%s（至少 %d 個字元，輸入時畫面不會顯示）：" % (label, ADMIN_MIN_PASSWORD))
        why = password_problem(pw)
        if why:
            say("  %s。請再輸入一次。" % why)
            continue
        if ask_secret("再輸入一次：") != pw:
            say("  兩次輸入不一樣。請重新輸入。")
            continue
        return pw


def valid_port(text):
    if not re.fullmatch(r"[0-9]{1,5}", str(text)):
        return None
    n = int(text)
    return n if 1024 <= n <= 65535 else None


def collect_ports(env, interactive_ask):
    """決定三個埠：環境變數 > .env 現有值 > 預設。互動且 interactive_ask 為真時逐一詢問。"""
    ports = {}
    for key, default in DEFAULT_PORTS.items():
        cur = valid_port(env.get(key)) if env and env.get(key) else None
        want = os.environ.get(PORT_ENV[key], "").strip()
        base = cur or default
        if want:
            n = valid_port(want)
            if n is None:
                raise Fail("%s 要是 1024 到 65535 的整數（現在是 %s）。" % (PORT_ENV[key], want))
            ports[key] = n
        elif interactive_ask and INTERACTIVE:
            while True:
                t = ask("%s的埠（直接按 Enter 用 %d）：" % (PORT_LABELS[key], base), str(base))
                n = valid_port(t)
                if n is not None:
                    ports[key] = n
                    break
                say("  埠要是 1024 到 65535 的整數。")
        else:
            ports[key] = base
    if len(set(ports.values())) != 3:
        raise Fail("儀表板、閘道、資料庫的埠不能相同（現在是 %s）。" % "、".join("%s %d" % (PORT_LABELS[k], v) for k, v in ports.items()))
    return ports


# ───────────────────────── 欄位操作 ─────────────────────────

def read_example():
    if not os.path.isfile(EXAMPLE_PATH):
        raise Fail("找不到 .env.example。請確認有在專案資料夾執行，而且程式碼完整（用 git clone 或解壓整個 zip）。")
    return EnvFile.load(EXAMPLE_PATH)


LOCAL_SECTION_HEADER = [
    "",
    "# ── 本機安裝模式（由 docker-compose.setup.yml 的設定工具寫入）──",
    "# COSTSCALE_MODE=local：儀表板知道自己裝在自己電腦上（金鑰管理頁的說明、上手清單的文字會跟著變）。",
    "# COMPOSE_PROFILES：讓 docker compose up -d 直接啟動儀表板與排程容器，不必再加 --profile。",
    "# DASH_PORT、GATEWAY_PORT、DB_PORT：這台電腦上的埠，被別的程式佔用時改這裡，再執行 docker compose up -d。",
    "# 埠一律只綁 127.0.0.1（只有這台電腦連得到）。要給別台電腦用，請改用雲端主機安裝（INSTALL.md「快速安裝」）。",
]


def set_local_fields(env, ports, report, only_missing):
    """寫入本機模式專用欄位。only_missing 為真時，已有的欄位不動。"""
    wanted = [("COSTSCALE_MODE", "local"), ("COMPOSE_PROFILES", "full,local")]
    wanted += [(k, str(v)) for k, v in ports.items()]
    wrote_header = False
    for k, v in wanted:
        if env.has(k):
            if only_missing:
                continue
            if env.set(k, v):
                report.append("%s 已更新" % k)
            continue
        if not wrote_header and not any(l.startswith("# ── 本機安裝模式") for l in env.lines):
            env.append_comment(*LOCAL_SECTION_HEADER)
            wrote_header = True
        env.set(k, v)
        report.append("補上 %s" % k)


def fill_random_fields(env, report):
    for k in RANDOM_FIELDS:
        if not env.has(k) or secret_unset(env.get(k)):
            env.set(k, secrets.token_hex(24))
            report.append("%s 原本沒有或還是範本值，已產生新的亂數" % k)
    if auth_secret_bad(env.get("AUTH_SECRET")):
        env.set("AUTH_SECRET", secrets.token_hex(24))
        report.append("AUTH_SECRET 短於 %d 個字元，已換成新的亂數（登入中的瀏覽器需要重新登入）" % AUTH_SECRET_MIN_LENGTH)
    if not env.has("LITELLM_MASTER_KEY") or secret_unset(env.get("LITELLM_MASTER_KEY")):
        env.set("LITELLM_MASTER_KEY", "sk-" + secrets.token_hex(24))
        report.append("LITELLM_MASTER_KEY 原本沒有或還是範本值，已產生新的亂數")


def set_urls(env, ports, report, force):
    dash = "http://localhost:%d" % ports["DASH_PORT"]
    gw = "http://localhost:%d" % ports["GATEWAY_PORT"]
    for k, v in (("AUTH_URL", dash), ("GATEWAY_PUBLIC_URL", gw)):
        cur = env.get(k)
        is_template = (not env.has(k)) or cur == "" or "example.com" in cur
        is_local = cur.startswith("http://localhost:") or cur.startswith("http://127.0.0.1:")
        if force and (is_template or is_local):
            if env.set(k, v):
                report.append("%s 設為 %s" % (k, v))
        elif is_template:
            env.set(k, v)
            report.append("%s 設為 %s" % (k, v))
        elif cur != v:
            report.append("注意：%s 目前是 %s，與埠設定的 %s 不同，沒有更動" % (k, cur, v))


def admin_configured(env):
    u = env.get("AUTH_ADMIN_USER")
    h = env.get("AUTH_ADMIN_PASSWORD_HASH")
    return bool(u) and ADMIN_USER_RE.match(u) is not None and HASH_FORMAT_RE.match(h) is not None


def put_admin(env, user, password, report):
    h = make_hash(password)
    if not HASH_FORMAT_RE.match(h):
        raise Fail("產生密碼雜湊失敗：格式不對。")
    env.set("AUTH_ADMIN_USER", user)
    env.set("AUTH_ADMIN_PASSWORD_HASH", h)
    report.append("管理員帳號設為 %s，密碼已換成新的（只存雜湊，不會顯示在畫面上）" % user)


def put_key(env, provider, key, report):
    """把金鑰填進第一個還沒填的欄位。回傳 True 代表有寫入。"""
    name, label, slots = provider[0], provider[1], provider[2]
    why = key_problem(key)
    if why:
        raise Fail("%s 的金鑰不合格：%s。" % (label, why))
    for slot in slots:
        if secret_unset(env.get(slot)) or not env.has(slot):
            env.set(slot, key)
            report.append("%s 的金鑰已放進 %s（尾碼 %s）" % (label, slot, key[-4:]))
            return True
    report.append(
        "%s 的欄位（%s）都已經有金鑰，這次沒有寫入。要換掉其中一把：用文字編輯器打開 .env，把那一行等號後面換成新金鑰。"
        % (label, "、".join(slots))
    )
    return False


def keys_from_environment(env, report):
    n = 0
    for p in PROVIDERS:
        v = take_env(p[3])
        if v is not None:
            if put_key(env, p, v.strip(), report):
                n += 1
    return n


# ───────────────────────── 動作 ─────────────────────────

def action_init(env, is_new):
    report = []
    pw_env = take_env("CS_ADMIN_PASSWORD")
    user_env = take_env("CS_ADMIN_USER")
    if user_env is not None:
        user_env = user_env.strip()

    if is_new:
        say("還沒有 .env，開始建立。亂數祕密（資料庫密碼、閘道主金鑰、登入加密密鑰等）會自動產生，不會顯示在畫面上。")
        env = read_example()
        # 範本裡沒有的值不能留著範本預設
        fill_random_fields(env, report)
        ports = collect_ports(env, interactive_ask=False)
        set_urls(env, ports, report, force=True)
        env.set("AUTH_DISABLED", "0")
        env.set("AUTH_ALLOWED_EMAILS", "")
        user = get_admin_user(env, user_env)
        password = get_admin_password(pw_env)
        put_admin(env, user, password, report)
        del password
        set_local_fields(env, ports, report, only_missing=False)
        keys_added = keys_from_environment(env, report)
        if INTERACTIVE and keys_added == 0:
            say("")
            say("AI 金鑰：閘道要有一把供應商的金鑰才能替你呼叫 AI。可以先跳過，之後再執行同一個設定工具，選「新增 AI 金鑰」。")
            say("Gemini 免費金鑰到 https://aistudio.google.com/apikey 建立。")
            while True:
                k = ask_secret("Gemini 免費金鑰（沒有就直接按 Enter 跳過，輸入時畫面不會顯示）：").strip()
                if not k:
                    break
                why = key_problem(k)
                if why:
                    say("  %s。請再貼一次，或直接按 Enter 跳過。" % why)
                    continue
                put_key(env, PROVIDERS[0], k, report)
                break
        save_env(env)
        say("")
        say("已建立 .env。重點：")
        for r in report:
            say("  - " + r)
        write_tails(env)
        return env, True

    # 已有 .env：不覆蓋，只補缺的
    say("已有 .env，不會覆蓋，只補缺少的欄位。")
    ex = read_example()
    added = []
    for line in ex.lines:
        m = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if m and not env.has(m.group(1)):
            env.lines.append(line)
            env.changed = True
            added.append(m.group(1))
    if added:
        report.append("補上 %d 個缺少的欄位（用範本預設值）：%s" % (len(added), "、".join(added)))
    fill_random_fields(env, report)
    ports = collect_ports(env, interactive_ask=False)
    set_local_fields(env, ports, report, only_missing=True)
    set_urls(env, ports, report, force=False)
    cur_auth = env.get("AUTH_DISABLED")
    if cur_auth != "0":
        env.set("AUTH_DISABLED", "0")
        report.append("AUTH_DISABLED 原本是「%s」，已改成 0（設成 1 代表不用登入，任何連得到儀表板的人都能看花費）" % (cur_auth or "空的"))
    if admin_configured(env):
        if pw_env is not None:
            report.append("管理員帳號已設定，沒有更動（CS_ADMIN_PASSWORD 這次沒有使用）。要改密碼：設定工具選「更改管理員帳號或密碼」，或加 -e CS_ACTION=password")
    else:
        user = get_admin_user(env, user_env)
        password = get_admin_password(pw_env)
        put_admin(env, user, password, report)
        del password
    keys_from_environment(env, report)
    if env.changed:
        save_env(env)
        say(".env 已更新：")
        for r in report:
            say("  - " + r)
    else:
        say(".env 已經完整，沒有任何更動。")
        for r in report:
            say("  - " + r)
    write_tails(env)
    return env, env.changed


def action_add_key(env):
    report = []
    n = keys_from_environment(env, report)
    if n == 0 and not report:
        if not INTERACTIVE:
            raise Fail("沒有提供任何金鑰。非互動模式請設定 CS_GEMINI_FREE_KEY、CS_GROQ_KEY、CS_OPENROUTER_KEY 或 CS_GEMINI_PAID_KEY。")
        while True:
            say("")
            say("要新增哪一家的 AI 金鑰？")
            for i, p in enumerate(PROVIDERS, 1):
                used = sum(1 for s in p[2] if env.has(s) and not secret_unset(env.get(s)))
                say("  %d) %s（已放 %d 把，最多 %d 把）" % (i, p[1], used, len(p[2])))
            say("  q) 結束")
            c = ask("請輸入選項：").lower()
            if c in ("q", ""):
                break
            if not c.isdigit() or not (1 <= int(c) <= len(PROVIDERS)):
                say("  請輸入 1 到 %d，或 q。" % len(PROVIDERS))
                continue
            p = PROVIDERS[int(c) - 1]
            k = ask_secret("貼上 %s 的金鑰（輸入時畫面不會顯示）：" % p[1]).strip()
            why = key_problem(k)
            if why:
                say("  %s。" % why)
                continue
            put_key(env, p, k, report)
    if env.changed:
        save_env(env)
    write_tails(env)
    say("")
    for r in report:
        say("  - " + r)
    if env.changed:
        say("")
        say("金鑰已寫進 .env。要讓閘道讀到，在專案資料夾執行：")
        say("  docker compose up -d")
        say("約 30 秒後閘道重建完成。儀表板「金鑰管理」頁會出現這把金鑰的尾 4 碼，總覽的上手清單第 1 步會打勾。")
    else:
        say("沒有寫入任何金鑰，.env 沒有更動。")
    return env, env.changed


def action_password(env):
    report = []
    pw_env = take_env("CS_ADMIN_PASSWORD")
    user_env = take_env("CS_ADMIN_USER")
    user = get_admin_user(env, user_env.strip() if user_env is not None else None)
    password = get_admin_password(pw_env, "新密碼")
    put_admin(env, user, password, report)
    del password
    save_env(env)
    write_tails(env)
    for r in report:
        say("  - " + r)
    say("舊密碼的登入狀態會在新設定生效後一併失效。")
    say("還差一步：在專案資料夾執行下面這一行讓新設定生效（只重建儀表板，不會動到閘道）：")
    say("  docker compose up -d dashboard")
    return env, True


def action_ports(env):
    report = []
    if not INTERACTIVE and not any(os.environ.get(v, "").strip() for v in PORT_ENV.values()):
        raise Fail("非互動模式要改埠，請提供 CS_DASH_PORT、CS_GATEWAY_PORT、CS_DB_PORT 其中至少一個。")
    ports = collect_ports(env, interactive_ask=True)
    old = {k: env.get(k) for k in DEFAULT_PORTS}
    for k, v in ports.items():
        env.set(k, str(v))
    set_urls(env, ports, report, force=True)
    for k, v in ports.items():
        if old[k] != str(v):
            report.append("%s（%s）：%s 改為 %d" % (k, PORT_LABELS[k], old[k] or "未設定（預設 %d）" % DEFAULT_PORTS[k], v))
    if env.changed:
        save_env(env)
        write_tails(env)
        for r in report:
            say("  - " + r)
        say("")
        say("在專案資料夾執行下面這一行讓新的埠生效：")
        say("  docker compose up -d")
        say("儀表板網址：http://localhost:%d    閘道網址：http://localhost:%d" % (ports["DASH_PORT"], ports["GATEWAY_PORT"]))
    else:
        say("埠沒有變動。")
        write_tails(env)
    return env, env.changed


def menu():
    say("")
    say("已有 .env。要做什麼？")
    say("  1) 檢查並補齊缺少的欄位（不會改任何已有的值）")
    say("  2) 新增 AI 金鑰")
    say("  3) 更改管理員帳號或密碼")
    say("  4) 更改埠號（3000、4000、5442 被別的程式佔用時）")
    say("  q) 離開")
    while True:
        c = ask("請輸入選項：").lower()
        if c in ("1", "init"):
            return "init"
        if c == "2":
            return "add-key"
        if c == "3":
            return "password"
        if c == "4":
            return "ports"
        if c in ("q", ""):
            return "quit"
        say("  請輸入 1 到 4，或 q。")


def finish_message(ports_env, is_new):
    ports = {k: valid_port(ports_env.get(k)) or DEFAULT_PORTS[k] for k in DEFAULT_PORTS}
    say("")
    say("設定完成。下一步，在專案資料夾執行這一行啟動（第一次要下載映像並建置儀表板，約 3 到 10 分鐘）：")
    say("  docker compose up -d --build")
    say("啟動後開 http://localhost:%d ，用剛才設定的管理員帳號登入。" % ports["DASH_PORT"])
    say("閘道網址是 http://localhost:%d（只有這台電腦上的程式連得到）。" % ports["GATEWAY_PORT"])


def main(argv):
    if len(argv) > 1 and argv[1] == "--hash-stdin":
        # 測試用：從 stdin 讀密碼，印出雜湊（dashboard/scripts/test-admin-password.mjs 用它驗證與儀表板互通）
        sys.stdout.write(make_hash(sys.stdin.buffer.read().decode("utf-8")) + "\n")
        return 0
    if not os.path.isdir(WORK):
        raise Fail("找不到專案資料夾 %s。請用 docker compose -f docker-compose.setup.yml run --rm setup 執行。" % WORK)
    if not os.access(WORK, os.W_OK):
        raise Fail("沒有專案資料夾的寫入權限，無法建立 .env。")

    action = os.environ.get("CS_ACTION", "").strip().lower()
    if action not in ("", "init", "add-key", "password", "ports"):
        raise Fail("CS_ACTION 只能是 init、add-key、password、ports（現在是 %s）。" % action)

    has_env = os.path.isfile(ENV_PATH)
    if not has_env:
        if action not in ("", "init"):
            raise Fail("還沒有 .env，不能做 %s。請先不帶 CS_ACTION 執行一次，建立 .env。" % action)
        env, changed = action_init(None, True)
        finish_message(env.pairs(), True)
        return 0

    env = EnvFile.load(ENV_PATH)
    if not action:
        action = menu() if INTERACTIVE else "init"
    if action == "quit":
        say("沒有做任何更動。")
        return 0
    if action == "init":
        env, changed = action_init(env, False)
        if not env.get("COSTSCALE_MODE") == "local":
            say("注意：這份 .env 沒有 COSTSCALE_MODE=local，看起來不是本機模式產生的。")
    elif action == "add-key":
        env, changed = action_add_key(env)
    elif action == "password":
        env, changed = action_password(env)
    elif action == "ports":
        env, changed = action_ports(env)
    if action == "init":
        finish_message(env.pairs(), False)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Fail as e:
        print("")
        print("Status: 設定失敗")
        print("Root Cause: %s" % e)
        print("Suggested Fix: 依上面的原因修正後，重新執行同一行指令。已存在的 .env 不會被更動。")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已取消，.env 沒有被更動。")
        sys.exit(130)

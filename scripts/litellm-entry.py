#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
閘道容器的進入點（取代映像預設的 docker/prod_entrypoint.sh）。

做的事：讀 litellm-config.yaml，把「同一個 model_name 底下、金鑰還是佔位值的部署」拿掉，
寫成暫存設定檔，再用它啟動 litellm。原本的設定檔不動（唯讀掛載，儀表板與套用金鑰的腳本都讀原檔）。

為什麼要這樣：
  gemini-flash-free 有 5 個部署，分別用 GEMINI_FREE_KEY_1 到 5。新手只填 1 把金鑰時，另外 4 個
  部署的金鑰是 .env 範本的佔位字 placeholder。閘道的路由器是隨機挑部署，挑到佔位的就拿假金鑰去打
  Google，使用者看到 401，或連續失敗後整組冷卻而回 429「No deployments available」
  （2026-11-23 驗收實測：連續 10 次呼叫，6 次 200、4 次 429；另一位驗收者看到 401）。
  把佔位部署拿掉之後，路由器只剩真的金鑰可挑，一把金鑰就能連續成功。

規則（刻意保守，不改變其他行為）：
  1. 只處理 api_key 寫成 os.environ/名稱 的部署，而且該環境變數是空值、placeholder 或 change-me 開頭。
  2. 只有「同一個 model_name 底下至少還有一個真金鑰的部署」時才拿掉佔位部署。
     一把真金鑰都沒有的模型（例如還沒填 OpenRouter 金鑰）維持原狀，行為與以前相同。
  3. 填滿 5 把時沒有任何部署被拿掉，直接用原檔啟動，行為與以前完全一樣。
  4. 之後補上第 2 把金鑰：在 .env 填好後照 INSTALL.md 的指令重建閘道容器（本機安裝是 docker compose up -d；
     雲端主機一定要疊上 docker-compose.vps.yml，少了它埠會跑掉），啟動時重新判斷，
     第 2 個部署就會加進來。
  5. 任何一步失敗（讀不到檔、沒有 yaml 模組、寫不出暫存檔）都退回用原檔啟動，並在 log 說明，
     絕不因為這支腳本而讓閘道起不來。

log 只印環境變數「名稱」，不印任何金鑰值。

只用 Python 標準函式庫加上 litellm 映像本身就有的 PyYAML。
"""
import os
import sys

SRC_DEFAULT = "/app/config.yaml"
DST = "/tmp/cs-litellm-config.yaml"
PREFIX = "os.environ/"


def log(msg):
    print("[cs-entry] " + msg, flush=True)


def is_placeholder(value):
    """與 scripts/local-setup.py 的 secret_unset、dashboard/lib/secret-check.ts 的判斷一致。"""
    v = (value or "").strip().lower()
    return v == "" or v == "placeholder" or v.startswith("change-me") or v.startswith("sk-change-me")


def env_name_of(deployment, environ):
    """部署的 api_key 若寫成 os.environ/NAME 回傳 NAME，否則回 None。"""
    params = deployment.get("litellm_params") if isinstance(deployment, dict) else None
    key = params.get("api_key") if isinstance(params, dict) else None
    if isinstance(key, str) and key.startswith(PREFIX):
        return key[len(PREFIX):]
    return None


def filter_deployments(model_list, environ):
    """回傳 (新的 model_list, 被拿掉的 [(model_name, 環境變數名)])。"""
    groups = {}
    for d in model_list:
        if isinstance(d, dict):
            groups.setdefault(d.get("model_name"), []).append(d)

    drop_ids = set()
    dropped = []
    for name, items in groups.items():
        placeholders = []
        has_real = False
        for d in items:
            env = env_name_of(d, environ)
            if env is not None and is_placeholder(environ.get(env)):
                placeholders.append((d, env))
            else:
                has_real = True
        if has_real:
            for d, env in placeholders:
                drop_ids.add(id(d))
                dropped.append((name, env))
    kept = [d for d in model_list if id(d) not in drop_ids]
    return kept, dropped


def build_config(src, dst, environ):
    """產生過濾後的設定檔。回傳要給 litellm 的設定檔路徑（沒有任何部署被拿掉就是原檔）。"""
    try:
        import yaml
    except ImportError:
        log("找不到 yaml 模組，用原設定檔啟動（佔位金鑰的部署不會被拿掉）")
        return src
    try:
        with open(src, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        model_list = cfg.get("model_list") if isinstance(cfg, dict) else None
        if not isinstance(model_list, list):
            log("設定檔沒有 model_list，用原設定檔啟動")
            return src
        kept, dropped = filter_deployments(model_list, environ)
        if not dropped:
            return src
        cfg["model_list"] = kept
        with open(dst, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
        try:
            os.chmod(dst, 0o600)
        except OSError:
            pass
        summary = {}
        for name, env in dropped:
            summary.setdefault(name, []).append(env)
        for name, envs in summary.items():
            log("%s：%s 還是佔位值，這 %d 個部署不載入（其餘有真金鑰的部署照常輪替）。補上金鑰後照 INSTALL.md 的指令重建閘道即可加入（本機安裝：docker compose up -d；雲端主機要疊上 docker-compose.vps.yml，不要只打這一句）。"
                % (name, "、".join(envs), len(envs)))
        return dst
    except Exception as e:  # noqa: BLE001 - 任何失敗都要退回原檔，不能讓閘道起不來
        log("過濾設定檔失敗（%s: %s），用原設定檔啟動" % (type(e).__name__, e))
        return src


def main(argv):
    args = list(argv[1:])
    src = SRC_DEFAULT
    idx = None
    for i, a in enumerate(args):
        if a == "--config" and i + 1 < len(args):
            src = args[i + 1]
            idx = i + 1
            break
        if a.startswith("--config="):
            src = a.split("=", 1)[1]
            idx = i
            break
    path = build_config(src, DST, os.environ)
    if idx is not None and path != src:
        if args[idx].startswith("--config="):
            args[idx] = "--config=" + path
        else:
            args[idx] = path
    if os.environ.get("USE_DDTRACE") == "true":
        os.environ["DD_TRACE_OPENAI_ENABLED"] = "False"
        cmd = ["ddtrace-run", "litellm"] + args
    else:
        cmd = ["litellm"] + args
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main(sys.argv)

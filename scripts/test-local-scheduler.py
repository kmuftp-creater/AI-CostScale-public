#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/local-scheduler.py 的到期判斷驗證（用假時鐘，不真的睡眠）。
執行：python -I scripts/test-local-scheduler.py
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("local_scheduler", os.path.join(HERE, "local-scheduler.py"))
sch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sch)

passed = 0


def ok(name):
    global passed
    passed += 1
    print("  通過  " + name)


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def make(t0, result=True):
    calls = {"fx": 0, "budget": 0}

    def mk(name):
        def f():
            calls[name] += 1
            return result
        return f

    jobs = {"fx": {"fn": mk("fx"), "due": t0 + sch.FX_FIRST}, "budget": {"fn": mk("budget"), "due": t0 + sch.BUDGET_FIRST}}
    return jobs, calls


T0 = 1_800_000_000.0

# 1. 正常時程：10 秒後抓匯率、120 秒後檢查預算
clock = Clock(T0)
jobs, calls = make(T0)
assert sch.tick(jobs, clock) == 0
clock.t = T0 + 10
assert sch.tick(jobs, clock) == 1 and calls == {"fx": 1, "budget": 0}
clock.t = T0 + 120
assert sch.tick(jobs, clock) == 1 and calls == {"fx": 1, "budget": 1}
ok("啟動後 10 秒抓匯率、120 秒檢查預算")

# 2. 睡眠 8 小時醒來：牆上時間跳過去，兩支各補跑一次（不是 8 次），下一次排在一個間隔之後
clock.t = T0 + 8 * 3600
assert sch.tick(jobs, clock) == 2 and calls == {"fx": 2, "budget": 2}
assert sch.tick(jobs, clock) == 0, "同一個時間點不得重複執行"
assert jobs["fx"]["due"] == clock.t + sch.INTERVAL
ok("睡眠 8 小時後醒來：每支補跑一次，下一次排在一個間隔之後")

# 3. 睡眠後再過一個間隔照常執行
clock.t += sch.INTERVAL
assert sch.tick(jobs, clock) == 2
ok("補跑之後恢復每小時一次")

# 4. 失敗時 5 分鐘後重試
jobs, calls = make(T0, result=False)
clock = Clock(T0 + 10)
assert sch.tick(jobs, clock) == 1
assert jobs["fx"]["due"] == clock.t + sch.RETRY
ok("失敗時排在 RETRY 秒後")

# 5. 牆上時間被往回調 3 小時：不會停擺 3 小時，重新排成現在加一個間隔
jobs, calls = make(T0)
clock = Clock(T0 + 10)
sch.tick(jobs, clock)
due_before = jobs["fx"]["due"]
clock.t -= 3 * 3600
sch.tick(jobs, clock)
assert jobs["fx"]["due"] <= clock.t + sch.INTERVAL, "往回調後到期時間要被拉回"
assert jobs["fx"]["due"] < due_before
ok("牆上時間往回調：到期時間被拉回，不會停擺")

# 6. 某支排程丟例外：其他排程照常，容器不結束
def boom():
    raise RuntimeError("測試用例外")

jobs, calls = make(T0)
jobs["fx"]["fn"] = boom
clock = Clock(T0 + 200)
assert sch.tick(jobs, clock) == 2 and calls["budget"] == 1
assert jobs["fx"]["due"] == clock.t + sch.RETRY
ok("單一排程丟例外：記錄後 5 分鐘重試，其他排程不受影響")

print("\n全部通過（%d 組）" % passed)

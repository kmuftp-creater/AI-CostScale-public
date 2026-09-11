#!/usr/bin/env python3
"""
Phase 5 A1：把 App Hub 的 KV 快照匯入 costscale 的看板資料表。

輸入是 wrangler 匯出的快照檔（{鍵: 原始 JSON 字串}），不直接打 Cloudflare——
匯出與匯入分開，對帳時兩邊都有留底，出錯可以重跑任何一半。

冪等：重跑以 KV 值覆蓋資料庫（ON CONFLICT DO UPDATE）。
遷移期間 KV 仍是唯一的寫入端（看板還在 Cloudflare 上跑），資料庫是影子副本，
所以「以 KV 為準」是對的；A4 切換寫入端之後這支腳本就退役。
"""
import json
import sys

SNAPSHOT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/kv-export.json"
DSN = None
import os
DSN = os.environ["DATABASE_URL"]

CONFIG_MAP = {
    "config:tracked": "board_tracked",
    "config:categories": "board_categories",
    "config:apps": "board_apps",
}


def main() -> int:
    import psycopg

    with open(SNAPSHOT, encoding="utf-8") as f:
        snap = json.load(f)

    cards = []
    overrides = []
    configs = []
    for key, rawstr in snap.items():
        doc = json.loads(rawstr)
        if key in CONFIG_MAP:
            configs.append((CONFIG_MAP[key], rawstr))
        elif key.startswith("draft:") or key.startswith("push:"):
            source = "draft" if key.startswith("draft:") else "pushed"
            status = str(doc.get("status") or "planned")
            if status not in ("planned", "in-progress", "done"):
                print(f"{key}：status『{status}』不在已知集合，照 App Hub 的退化規則記為 planned")
                status = "planned"
            cards.append((
                key, source,
                str(doc.get("name") or ""),
                str(doc.get("title") or doc.get("name") or ""),
                status,
                str(doc.get("category") or ""),
                str(doc.get("host") or ""),
                str(doc.get("path") or ""),
                str(doc.get("summary") or ""),
                # 舊草稿的進度欄叫 note，projects.js 的讀取順序就是 progress → note
                str(doc.get("progress") or doc.get("note") or ""),
                str(doc.get("notes") or ""),
                json.dumps(doc.get("apps") or [], ensure_ascii=False),
                json.dumps(doc.get("links") or [], ensure_ascii=False),
                json.dumps(doc.get("cycles") or [], ensure_ascii=False),
                json.dumps(doc.get("tags") or [], ensure_ascii=False),
                str(doc.get("updatedAt") or ""),
                doc.get("pushedAt") or None,
                doc.get("createdAt") or None,
                rawstr,
            ))
        elif key.startswith("override:"):
            overrides.append((
                key[len("override:"):],
                str(doc.get("status") or "done"),
                doc.get("endDate") or None,
                rawstr,
            ))
        else:
            print(f"未知的鍵 {key}，略過（匯出端不該給到這裡）")

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        for c in cards:
            cur.execute("""
                INSERT INTO costscale.board_cards
                    (id, source, name, title, status, category, host, path, summary,
                     progress, notes, apps, links, cycles, tags, updated_at,
                     pushed_at, created_at, raw)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                    source=EXCLUDED.source, name=EXCLUDED.name, title=EXCLUDED.title,
                    status=EXCLUDED.status, category=EXCLUDED.category, host=EXCLUDED.host,
                    path=EXCLUDED.path, summary=EXCLUDED.summary, progress=EXCLUDED.progress,
                    notes=EXCLUDED.notes, apps=EXCLUDED.apps, links=EXCLUDED.links,
                    cycles=EXCLUDED.cycles, tags=EXCLUDED.tags, updated_at=EXCLUDED.updated_at,
                    pushed_at=EXCLUDED.pushed_at, created_at=EXCLUDED.created_at,
                    raw=EXCLUDED.raw, imported_at=now()
            """, c)
        for o in overrides:
            cur.execute("""
                INSERT INTO costscale.board_overrides (repo, status, end_date, raw)
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (repo) DO UPDATE SET
                    status=EXCLUDED.status, end_date=EXCLUDED.end_date,
                    raw=EXCLUDED.raw, imported_at=now()
            """, o)
        for k, v in configs:
            cur.execute("""
                INSERT INTO costscale.settings (key, value) VALUES (%s, %s)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            """, (k, v))
        conn.commit()

        # 對帳：筆數必須與快照完全一致，少一筆都不能宣告成功。
        cur.execute("SELECT count(*) FROM costscale.board_cards")
        n_cards = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM costscale.board_overrides")
        n_ov = cur.fetchone()[0]

    print(f"卡片 {len(cards)} 筆（庫內共 {n_cards}）、覆寫 {len(overrides)} 筆（庫內共 {n_ov}）、設定 {len(configs)} 鍵")
    exp_cards = sum(1 for k in snap if k.startswith(("draft:", "push:")))
    exp_ov = sum(1 for k in snap if k.startswith("override:"))
    if n_cards != exp_cards or n_ov != exp_ov:
        print(f"對帳失敗：快照 cards={exp_cards} overrides={exp_ov}，資料庫 {n_cards}/{n_ov}")
        return 1
    print("對帳通過：筆數與快照一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())

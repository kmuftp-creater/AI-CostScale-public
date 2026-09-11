import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

export const metadata = { title: "說明 · AI CostScale" };
export const dynamic = "force-dynamic";

/**
 * 使用說明（2026-08-26）。
 *
 * 內容的唯一來源是 `content/manual.md`，這一頁只負責渲染。
 * 不把文字寫進 JSX 是刻意的：同一份說明若有兩個副本，
 * 兩邊一定會走鐘，而走鐘的說明比沒有說明更糟。
 *
 * 為什麼放 `content/` 而不是 `public/`：`public/` 底下的檔案不經登入守衛，
 * 任何人打得到網址就讀得到。這份說明描述的是內部架構，不該公開。
 * Dockerfile 有一行專門把 content/ 複製進最終映像（runner 階段預設只帶
 * standalone 與 static，不加那一行的話這一頁在容器裡會讀不到檔案）。
 *
 * dangerouslySetInnerHTML 在這裡是安全的：內容是隨映像一起打包的靜態檔，
 * 不接受任何使用者輸入。若哪天改成可由介面編輯，這裡就必須先過消毒。
 */
export default async function ManualPage() {
  const file = path.join(process.cwd(), "content", "manual.md");

  let html: string;
  try {
    const md = fs.readFileSync(file, "utf8");
    html = await marked.parse(md, { gfm: true, breaks: false });
  } catch (err) {
    // 讀不到就明說讀不到，不要給一頁空白讓人以為說明還沒寫。
    const why = err instanceof Error ? err.message : String(err);
    return (
      <section className="block">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">說明</span>
          </div>
          <div className="empty-state">
            <span className="microlabel">Error</span>
            讀不到說明檔（{file}）：{why}
          </div>
          <div className="panel-foot">
            這通常代表映像沒有把 <code>content/</code> 複製進來。
            檢查 Dockerfile 的 runner 階段是否有
            <code> COPY --from=builder /app/content ./content</code>。
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="block">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">使用說明</span>
          <span className="microlabel">前三節是該做什麼、怎麼做；其餘是各頁與數字怎麼讀</span>
        </div>
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="panel-foot">
          這一頁的內容來自 <code>dashboard/content/manual.md</code>，是唯一來源。
          要改內容改那個檔案，不要改頁面。
          <br />
          給專案（或專案的 AI）看的接入教學是另一份：
          <code>doc/GUIDE-接入-AI-CostScale-閘道.md</code>。
        </div>
      </div>
    </section>
  );
}

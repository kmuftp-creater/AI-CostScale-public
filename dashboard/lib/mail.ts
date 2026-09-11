import nodemailer, { type Transporter } from "nodemailer";

/**
 * 寄信管道。沿用 VPS 上既有的 mailcow，設定與其他專案（某個付費專案）相同的
 * SMTP_* 變數命名，避免同一台機器上兩套命名。
 *
 * 沒設定 SMTP 時不視為錯誤——告警仍會寫入資料庫並顯示在儀表板橫幅上，
 * 只是不寄信。這是刻意的：寄信管道壞掉不該讓整個告警機制失效。
 */

let transporter: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function getTransporter(): Transporter {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 是隱式 TLS；587 走 STARTTLS，secure 必須是 false 否則連不上。
      secure: port === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
  }
  return transporter;
}

/** 告警收件人。未設定時退回登入白名單的第一個帳號。 */
export function alertRecipients(): string[] {
  const raw =
    process.env.ALERT_EMAIL_TO ??
    process.env.AUTH_ALLOWED_EMAILS ??
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type MailResult = { ok: true } | { ok: false; error: string };

export async function sendMail(subject: string, text: string): Promise<MailResult> {
  if (!mailConfigured()) return { ok: false, error: "未設定 SMTP_HOST／SMTP_FROM" };

  const to = alertRecipients();
  if (to.length === 0) return { ok: false, error: "沒有收件人（ALERT_EMAIL_TO 與白名單皆為空）" };

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: to.join(", "),
      subject,
      text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

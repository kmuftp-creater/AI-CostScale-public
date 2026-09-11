import { redirect } from "next/navigation";

/** 2026-08-25 併入 /channels（D-7）。保留轉址讓舊書籤還能用。 */
export default function TelemetryRedirect() {
  redirect("/channels");
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "總覽" },
  { href: "/projects", label: "專案看板" },
  { href: "/apps", label: "應用程式" },
  { href: "/keys", label: "金鑰管理" },
  { href: "/subscriptions", label: "訂閱" },
  { href: "/budgets", label: "預算告警" },
  { href: "/channels", label: "通道與用量" },
  { href: "/billing", label: "GCP 帳單" },
  { href: "/settings", label: "設定" },
  { href: "/manual", label: "說明" },
] as const;

export default function NavRail() {
  const pathname = usePathname();
  return (
    <div className="nav-rail">
      {NAV_ITEMS.map((item) => {
        const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

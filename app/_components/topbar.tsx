"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

const TABS = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/approvals", label: "Command center" },
];

export function TopBar({ pending, date }: { pending: number; date: string }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-10 hidden items-center gap-4 border-b border-ink/[0.06] bg-canvas/80 px-6 py-3 backdrop-blur md:flex">
      <div className="flex rounded-xl border border-ink/[0.06] bg-panel p-1">
        {TABS.map((t) => {
          const on = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className={`rounded-lg px-3.5 py-1.5 text-sm ${on ? "bg-ink/[0.08] font-medium text-ink" : "text-ink/55 hover:text-ink"}`}>
              {t.label}
            </Link>
          );
        })}
      </div>
      <form action="/clients" className="flex max-w-md flex-1 items-center gap-2 rounded-xl border border-ink/[0.06] bg-panel px-3 py-2">
        <Icon name="search" className="size-4 text-ink/40" />
        <input name="q" placeholder="Search clients…" className="w-full bg-transparent text-sm outline-none placeholder:text-ink/35" />
      </form>
      <div className="ml-auto flex items-center gap-4">
        <span className="text-xs text-ink/40">{date}</span>
        <Link href="/approvals" className="relative text-ink/60 hover:text-ink" title="Approvals waiting">
          <Icon name="bell" className="size-5" />
          {pending > 0 && <span className="brand-gradient absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full text-[10px] font-bold text-white">{pending}</span>}
        </Link>
      </div>
    </header>
  );
}

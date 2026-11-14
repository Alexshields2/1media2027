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
    <header className="sticky top-0 z-10 hidden items-center gap-4 border-b border-line bg-canvas/75 px-6 py-3 backdrop-blur-md md:flex lg:px-8">
      <nav aria-label="Views" className="hidden rounded-full border border-line bg-panel p-1 lg:flex">
        {TABS.map((t) => {
          const on = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${on ? "bg-ink/[0.09] font-medium text-white" : "text-muted hover:text-white"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <form action="/clients" role="search" className="group flex max-w-md flex-1 items-center gap-2 rounded-full border border-line bg-panel px-4 py-2 transition-colors focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/20 hover:border-line-strong">
        <Icon name="search" className="size-4 text-muted" />
        <input name="q" type="search" placeholder="Search clients…" aria-label="Search clients" className="w-full bg-transparent text-sm outline-none placeholder:text-muted focus-visible:outline-none" />
      </form>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-muted">{date}</span>
        <Link
          href="/approvals"
          className="relative grid size-9 place-items-center rounded-full border border-line bg-panel text-soft transition-colors hover:border-brand/50 hover:text-white"
          aria-label={`Approvals${pending ? `, ${pending} waiting` : ""}`}
        >
          <Icon name="bell" className="size-[18px]" />
          {pending > 0 && <span className="brand-gradient absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[10px] font-bold text-white shadow-[0_0_10px_rgb(4_153_242/0.7)]">{pending}</span>}
        </Link>
      </div>
    </header>
  );
}

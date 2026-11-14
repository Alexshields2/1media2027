"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "../actions";

const GROUPS: { title?: string; links: { href: string; label: string; managers?: boolean }[] }[] = [
  {
    links: [
      { href: "/", label: "Dashboard" },
      { href: "/tasks", label: "Tasks" },
      { href: "/eod", label: "End of day" },
      { href: "/voice", label: "Voice notes" },
      { href: "/sops", label: "SOP library" },
    ],
  },
  {
    title: "Clients",
    links: [
      { href: "/clients", label: "Clients" },
      { href: "/payments", label: "Payments" },
      { href: "/health", label: "Client health" },
      { href: "/reports", label: "Reports" },
    ],
  },
  {
    title: "Agents",
    links: [
      { href: "/approvals", label: "Approvals" },
      { href: "/agents", label: "Agents" },
      { href: "/log", label: "Activity log" },
      { href: "/team", label: "Team" },
    ],
  },
];

export function Nav({ user, pending }: { user: { name: string; role: string; title: string | null }; pending: number }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <aside className="border-b border-black/10 bg-white md:sticky md:top-0 md:flex md:h-screen md:w-56 md:shrink-0 md:flex-col md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-4 py-4 md:px-5 md:py-6">
        <span className="grid size-7 place-items-center rounded-md bg-brand text-sm font-bold text-white">1</span>
        <span className="font-semibold tracking-tight">1Media OS</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-1 md:flex-col md:overflow-y-auto md:px-3 md:pb-0">
        {GROUPS.map((g, gi) => (
          <div key={gi} className="flex gap-1 md:mb-3 md:flex-col">
            {g.title && <div className="hidden px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-black/40 uppercase md:block">{g.title}</div>}
            {g.links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm ${active(l.href) ? "bg-brand-soft font-medium text-brand" : "text-black/70 hover:bg-black/5"}`}
              >
                {l.label}
                {l.href === "/approvals" && pending > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">{pending}</span>}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="hidden border-t border-black/5 px-5 py-4 md:block">
        <div className="text-sm font-medium">{user.name}</div>
        <div className="text-xs text-black/50">{user.title ?? user.role}</div>
        <form action={logout}>
          <button className="mt-2 text-xs text-black/50 hover:text-black">Sign out</button>
        </form>
      </div>
    </aside>
  );
}

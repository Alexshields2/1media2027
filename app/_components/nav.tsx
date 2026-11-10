"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "../actions";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/payments", label: "Payments" },
  { href: "/tasks", label: "Tasks" },
  { href: "/health", label: "Client health" },
  { href: "/reports", label: "Reports" },
  { href: "/approvals", label: "Approvals" },
  { href: "/agents", label: "Agents" },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <aside className="border-b border-black/10 bg-white md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-4 py-4 md:px-5 md:py-6">
        <span className="grid size-7 place-items-center rounded-md bg-brand text-sm font-bold text-white">1</span>
        <span className="font-semibold tracking-tight">1Media OS</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:px-3 md:pb-0">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${active(l.href) ? "bg-brand-soft font-medium text-brand" : "text-black/70 hover:bg-black/5"}`}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <form action={logout} className="hidden px-3 pt-6 md:block">
        <button className="px-3 py-2 text-sm text-black/50 hover:text-black">Sign out</button>
      </form>
    </aside>
  );
}

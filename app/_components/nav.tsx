"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "../actions";
import { Logo } from "./logo";
import { Icon, type IconName } from "./icons";

type L = { href: string; label: string; icon: IconName; ownerOnly?: boolean };
const GROUPS: { title?: string; links: L[] }[] = [
  {
    links: [
      { href: "/", label: "Home", icon: "home" },
      { href: "/dashboard", label: "Dashboard", icon: "chart" },
    ],
  },
  {
    title: "Agency",
    links: [
      { href: "/clients", label: "Clients", icon: "users" },
      { href: "/payments", label: "Payments", icon: "euro", ownerOnly: true },
      { href: "/tasks", label: "Tasks", icon: "check" },
      { href: "/health", label: "Client health", icon: "pulse" },
      { href: "/reports", label: "Reports", icon: "doc" },
    ],
  },
  {
    title: "AI",
    links: [
      { href: "/approvals", label: "Approvals", icon: "shield" },
      { href: "/agents", label: "Agents", icon: "spark" },
    ],
  },
  {
    links: [{ href: "/settings", label: "Settings", icon: "gear" }],
  },
];

export function Nav({ user }: { user: { name: string; role: "owner" | "team" } }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  // Hiding links is only convenience: the pages and actions check the role on the server.
  const groups = GROUPS.map((g) => ({ ...g, links: g.links.filter((l) => !l.ownerOnly || user.role === "owner") }));
  const all = groups.flatMap((g) => g.links);
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-line md:bg-sidebar">
        <Link href="/" className="px-5 pt-6 pb-5">
          <Logo sub="Operating system" />
        </Link>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3">
          {groups.map((g, i) => (
            <div key={i}>
              {g.title && <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.16em] text-ink/35 uppercase">{g.title}</div>}
              <div className="space-y-0.5">
                {g.links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${active(l.href) ? "bg-ink/[0.07] font-medium text-ink" : "text-ink/60 hover:bg-ink/[0.04] hover:text-ink"}`}
                  >
                    <Icon name={l.icon} className={`size-4 ${active(l.href) ? "text-brand-light" : ""}`} />
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="m-3 rounded-xl border border-line bg-panel p-3">
          <div className="flex items-center gap-2.5">
            <span className="brand-gradient grid size-8 place-items-center rounded-full text-xs font-bold text-white">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium">{user.name}</span>
              <span className="block text-xs text-ink/40">1Media · {user.role === "owner" ? "Owner" : "Team"}</span>
            </span>
          </div>
          <form action={logout} className="mt-3">
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ink/50 hover:bg-ink/[0.05] hover:text-ink">
              <Icon name="logout" className="size-3.5" /> Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile top nav */}
      <div className="border-b border-line bg-sidebar md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/">
            <Logo />
          </Link>
          <form action={logout}>
            <button className="text-xs text-ink/50">Sign out</button>
          </form>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
          {all.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${active(l.href) ? "bg-ink/[0.08] font-medium" : "text-ink/60"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}

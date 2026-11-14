"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
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
      { href: "/chat", label: "Chats", icon: "chat" },
      { href: "/approvals", label: "Approvals", icon: "shield" },
      { href: "/agents", label: "Agents", icon: "spark" },
    ],
  },
  {
    links: [
      { href: "/integrations", label: "Integrations", icon: "plug", ownerOnly: true },
      { href: "/settings", label: "Settings", icon: "gear" },
    ],
  },
];

export function Nav({ user, pending = 0 }: { user: { name: string; role: "owner" | "team" }; pending?: number }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  // Hiding links is only convenience: the pages and actions check the role on the server.
  const groups = GROUPS.map((g) => ({ ...g, links: g.links.filter((l) => !l.ownerOnly || user.role === "owner") }));
  const all = groups.flatMap((g) => g.links);
  const strip = useRef<HTMLElement>(null);

  // Keep the current page's chip in view on the phone nav strip.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [path]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-line md:bg-sidebar">
        <Link href="/" className="mx-3 mt-4 mb-3 rounded-xl px-2 py-2" aria-label="1Media OS home">
          <Logo sub="Operating system" />
        </Link>
        <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
          {groups.map((g, i) => (
            <div key={i}>
              {g.title && <div className="px-3 pb-2 text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">{g.title}</div>}
              <div className="space-y-0.5">
                {g.links.map((l) => {
                  const on = active(l.href);
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      aria-current={on ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${on ? "bg-gradient-to-r from-brand/[0.16] to-brand/[0.03] font-medium text-white" : "text-soft hover:bg-ink/[0.04] hover:text-white"}`}
                    >
                      {on && <span className="brand-gradient absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full shadow-[0_0_10px_rgb(56_196_250/0.8)]" aria-hidden />}
                      <Icon name={l.icon} className={`size-4 transition-colors ${on ? "text-brand-light" : "text-muted group-hover:text-soft"}`} />
                      <span className="flex-1">{l.label}</span>
                      {l.href === "/approvals" && pending > 0 && (
                        <span className="brand-gradient num grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-bold text-white">{pending}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="m-3 rounded-xl border border-line bg-panel p-3">
          <div className="flex items-center gap-2.5">
            <span className="brand-gradient grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white" aria-hidden>
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium text-white">{user.name}</span>
              <span className="block text-xs text-muted">1Media · {user.role === "owner" ? "Owner" : "Team"}</span>
            </span>
          </div>
          <form action={logout} className="mt-2.5 border-t border-line pt-2">
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted transition-colors hover:bg-ink/[0.05] hover:text-white">
              <Icon name="logout" className="size-3.5" /> Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Phone / tablet: top bar and a scrolling strip of pages */}
      <div className="sticky top-0 z-20 border-b border-line bg-sidebar/90 backdrop-blur-md md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <Link href="/" aria-label="1Media OS home" className="rounded-lg">
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/approvals" className="relative grid size-9 place-items-center rounded-full text-soft hover:bg-ink/[0.06] hover:text-white" aria-label={`Approvals${pending ? `, ${pending} waiting` : ""}`}>
              <Icon name="bell" className="size-5" />
              {pending > 0 && <span className="brand-gradient absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full text-[10px] font-bold text-white">{pending}</span>}
            </Link>
            <form action={logout}>
              <button className="grid size-9 place-items-center rounded-full text-soft hover:bg-ink/[0.06] hover:text-white" aria-label="Sign out">
                <Icon name="logout" className="size-[18px]" />
              </button>
            </form>
          </div>
        </div>
        <nav ref={strip} aria-label="Main" className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2.5 [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-24px),transparent)]">
          {all.map((l) => {
            const on = active(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={on ? "page" : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${on ? "bg-brand-soft font-medium text-white ring-1 ring-brand/40 ring-inset" : "text-soft hover:text-white"}`}
              >
                <Icon name={l.icon} className={`size-3.5 ${on ? "text-brand-light" : "text-muted"}`} />
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

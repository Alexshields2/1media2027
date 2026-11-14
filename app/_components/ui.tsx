import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

// The 1Media OS design system. Every page builds from these pieces, so spacing, type and colour stay consistent.
// Type scale: page title 2xl/semibold, card title sm/semibold, eyebrow 11px uppercase, body sm, meta xs.
// Secondary text uses text-soft / text-muted (solid colours that pass AA on navy); avoid text-muted and lower for words.

/* ---------- page structure ---------- */

export function PageHeader({ title, subtitle, actions, icon, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-center gap-4">
        {icon}
        <div className="min-w-0">
          {eyebrow && <div className="mb-1.5 text-[11px] font-semibold tracking-[0.18em] text-brand-light uppercase">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-white sm:text-[28px]">{title}</h1>
          {subtitle && <div className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A section heading between cards. */
export function SectionTitle({ children, actions, className = "" }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`mb-3 flex items-center justify-between gap-3 ${className}`}>
      <h2 className="text-[11px] font-semibold tracking-[0.16em] text-muted uppercase">{children}</h2>
      {actions}
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
  className = "",
  flush = false,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** No body padding: for tables and lists that run edge to edge. */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={`surface min-w-0 rounded-2xl border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-white">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}

/** "See all →" link for a card header. */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 rounded-full text-xs font-medium text-brand-light transition-colors hover:text-white">
      {children}
      <Icon name="arrow" className="size-3.5" />
    </Link>
  );
}

/* ---------- numbers ---------- */

type Tone = "good" | "bad" | "warn" | undefined;
const TONE_TEXT: Record<string, string> = { good: "text-emerald-300", bad: "text-red-300", warn: "text-amber-300" };

/** A KPI tile: label, big number, optional trend delta, sparkline and hint. */
export function Stat({
  label,
  value,
  hint,
  tone,
  delta,
  spark,
  icon,
  href,
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Percentage change; colour follows goodWhen. */
  delta?: { pct: number | null; goodWhen?: "up" | "down"; label?: string };
  spark?: number[];
  icon?: IconName;
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
          {icon && <Icon name={icon} className="size-3.5 text-brand-light" />}
          {label}
        </div>
        {delta && <Delta {...delta} />}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className={`num text-2xl font-semibold tracking-tight ${tone ? TONE_TEXT[tone] : "text-white"}`}>{value}</div>
        {spark && spark.length > 1 && <Sparkline values={spark} tone={tone === "bad" ? "red" : "brand"} />}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
      {children}
    </>
  );
  const cls = "surface block min-w-0 rounded-2xl border border-line bg-panel p-4 sm:p-5";
  return href ? (
    <Link href={href} className={`${cls} transition hover:border-brand/40 hover:bg-panel-2`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** ▲ 12% / ▼ 4%, green when the change is good. */
export function Delta({ pct, goodWhen = "up", label }: { pct: number | null; goodWhen?: "up" | "down"; label?: string }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct === 0) return null;
  const good = goodWhen === "up" ? pct > 0 : pct < 0;
  return (
    <span className={`num inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${good ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
      <span aria-hidden>{pct > 0 ? "▲" : "▼"}</span>
      <span className="sr-only">{pct > 0 ? "up" : "down"}</span>
      {Math.abs(pct)}%{label ? <span className="font-normal text-muted"> {label}</span> : null}
    </span>
  );
}

export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / Math.abs(before)) * 100);
}

/** A tiny line chart for a stat tile. Decorative: the number next to it carries the meaning. */
export function Sparkline({ values, tone = "brand", width = 88, height = 28 }: { values: number[]; tone?: "brand" | "red"; width?: number; height?: number }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = tone === "red" ? "#f87171" : "#38c4fa";
  const id = `sp-${tone}-${values.join("-").replace(/[^0-9-]/g, "").slice(0, 24)}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2.5" fill={color} />
    </svg>
  );
}

/** Horizontal progress bar. */
export function Progress({ value, max, tone = "brand", label, className = "" }: { value: number; max: number; tone?: "brand" | "green" | "amber" | "red"; label: string; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill = { brand: "brand-gradient shadow-[0_0_12px_rgb(4_153_242/0.5)]", green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-red-400" }[tone];
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-ink/[0.08] ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------- status ---------- */

const TONES: Record<string, string> = {
  green: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/25",
  yellow: "bg-amber-500/10 text-amber-300 ring-amber-400/25",
  red: "bg-red-500/10 text-red-300 ring-red-400/25",
  gray: "bg-ink/[0.06] text-soft ring-ink/10",
  blue: "bg-brand-soft text-brand-light ring-brand/30",
  brand: "bg-brand-soft text-brand-light ring-brand/30",
};
const DOTS: Record<string, string> = { green: "bg-emerald-400", yellow: "bg-amber-400", red: "bg-red-400", gray: "bg-muted", blue: "bg-brand-light", brand: "bg-brand-light" };

/** Status pill. The first letter is capitalised; pass `dot` for a leading colour dot. */
export function Badge({ tone = "gray", children, dot = false, className = "" }: { tone?: keyof typeof TONES | string; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${TONES[tone] ?? TONES.gray} ${className}`}>
      {dot && <span className={`size-1.5 rounded-full ${DOTS[tone] ?? DOTS.gray}`} aria-hidden />}
      <span className="inline-block first-letter:uppercase">{children}</span>
    </span>
  );
}

/** Glowing traffic-light dot for client health. */
export function HealthDot({ status, size = "md", label }: { status?: "green" | "yellow" | "red" | null; size?: "sm" | "md" | "lg"; label?: string }) {
  const s = { sm: "size-2", md: "size-2.5", lg: "size-3.5" }[size];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block shrink-0 rounded-full ${s} ${status ? `glow-${status}` : "bg-ink/20"}`}
    />
  );
}

export const healthLabel = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Not checked");

/** A due-date chip coloured by urgency: overdue red, today amber, this week blue, later grey. */
export function DueChip({ date, today, done = false }: { date: string | null; today: string; done?: boolean }) {
  if (!date) return null;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const d = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", timeZone: "UTC" });
  const [tone, text] = done
    ? ["text-muted ring-ink/10 bg-ink/[0.04]", d]
    : days < 0
      ? ["bg-red-500/10 text-red-300 ring-red-400/30", `${-days}d overdue`]
      : days === 0
        ? ["bg-amber-500/10 text-amber-300 ring-amber-400/30", "Due today"]
        : days === 1
          ? ["bg-brand-soft text-brand-light ring-brand/30", "Tomorrow"]
          : days <= 7
            ? ["bg-brand-soft text-brand-light ring-brand/30", d]
            : ["bg-ink/[0.04] text-soft ring-ink/10", d];
  return (
    <span className={`num inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset ${tone}`} title={`Due ${date}`}>
      <Icon name="calendar" className="size-3" />
      {text}
    </span>
  );
}

/** Inline message banner. */
export function Notice({ tone = "info", title, children, className = "" }: { tone?: "info" | "success" | "warn" | "error"; title?: ReactNode; children?: ReactNode; className?: string }) {
  const s = {
    info: ["border-brand/30 bg-brand-soft text-ink", "info", "text-brand-light"],
    success: ["border-emerald-400/30 bg-emerald-500/10 text-emerald-100", "check", "text-emerald-300"],
    warn: ["border-amber-400/30 bg-amber-500/10 text-amber-100", "alert", "text-amber-300"],
    error: ["border-red-400/30 bg-red-500/10 text-red-100", "alert", "text-red-300"],
  }[tone] as [string, IconName, string];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mb-4 flex gap-3 rounded-xl border px-4 py-3 text-sm ${s[0]} ${className}`}>
      <Icon name={s[1]} className={`mt-0.5 size-4 shrink-0 ${s[2]}`} />
      <div className="min-w-0 break-words">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** Friendly empty state: an icon, one line, and the next thing to do. */
export function Empty({ children, icon, title, action, compact = false }: { children?: ReactNode; icon?: IconName; title?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-5" : "py-10"}`}>
      {icon && (
        <span className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-canvas/60 text-brand-light shadow-[0_0_24px_rgb(4_153_242/0.12)]">
          <Icon name={icon} className="size-5" />
        </span>
      )}
      {title && <p className="text-sm font-semibold text-white">{title}</p>}
      {children && <div className={`max-w-sm text-sm text-muted ${title ? "mt-1" : ""}`}>{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ---------- tables ---------- */

export type Column = ReactNode | { label: ReactNode; align?: "left" | "right" | "center"; className?: string };

/**
 * Data table. Scrolls inside its card on small screens and long lists (the header stays put), rows highlight on hover.
 * Put it in a `<Card flush>`. Use `td`/`tdNum` for cells.
 */
export function Table({ head, children, minWidth = 640, maxHeight }: { head: Column[]; children: ReactNode; minWidth?: number; maxHeight?: string }) {
  return (
    <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr>
            {head.map((h, i) => {
              const c = h && typeof h === "object" && "label" in h ? h : { label: h as ReactNode };
              const align = c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
              return (
                <th key={i} scope="col" className={`sticky top-0 z-[1] border-b border-line bg-panel px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] whitespace-nowrap text-muted uppercase first:pl-5 last:pr-5 ${align} ${c.className ?? ""}`}>
                  {c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70 [&>tr]:transition-colors [&>tr:hover]:bg-ink/[0.025]">{children}</tbody>
      </table>
    </div>
  );
}
export const td = "px-4 py-3 first:pl-5 last:pr-5";
export const tdNum = `${td} num text-right whitespace-nowrap`;

/** A simple list inside a card body (divided rows). */
export function List({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <ul className={`-my-1 divide-y divide-line/70 text-sm ${className}`}>{children}</ul>;
}

/* ---------- controls ---------- */

/** Pill segmented control made of links (view switchers, tabs). */
export function Segmented({ items, label }: { items: { href: string; label: ReactNode; active: boolean; icon?: IconName }[]; label: string }) {
  return (
    <nav aria-label={label} className="inline-flex rounded-full border border-line bg-panel p-1 text-sm">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          aria-current={it.active ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition-colors ${it.active ? "bg-ink/[0.09] font-medium text-white shadow-[inset_0_0_0_1px_rgb(238_244_251/0.06)]" : "text-muted hover:text-ink"}`}
        >
          {it.icon && <Icon name={it.icon} className="size-3.5" />}
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

/** Label + control wrapper for forms. */
export function Field({ label: text, htmlFor, hint, children, className = "" }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className={label} htmlFor={htmlFor}>
        {text}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Form control style without a width; use for inline controls. */
export const field =
  "rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink transition-colors outline-none placeholder:text-muted hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:opacity-50";
export const input = `w-full ${field}`;
export const label = "mb-1.5 block text-xs font-medium text-soft";

const btnBase =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm font-medium whitespace-nowrap transition duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
/** Primary: white pill, as on 1media.ie. */
export const btn = `${btnBase} bg-white px-4 py-2 text-[#020617] shadow-[0_1px_0_rgb(255_255_255/0.4)_inset] hover:bg-[#dff1ff]`;
/** Brand: blue gradient with glow, for the one action that starts an agent. */
export const btnBrand = `${btnBase} brand-gradient px-4 py-2 text-white shadow-[0_0_20px_rgb(4_153_242/0.35)] hover:shadow-[0_0_28px_rgb(4_153_242/0.55)] hover:brightness-110`;
/** Secondary: outlined. */
export const btnGhost = `${btnBase} border border-line bg-panel px-4 py-2 text-ink hover:border-brand/50 hover:bg-panel-2`;
/** Small sizes (append after a button style). */
export const btnSm = "!px-3 !py-1 !text-xs";
/** Text-only link button. */
export const btnLink = "inline-flex items-center gap-1 rounded text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline";

export const HEALTH_TONE: Record<string, string> = { green: "green", yellow: "yellow", red: "red" };

/** Shown instead of a page the signed-in person's role can't see. The check itself happens on the server. */
export function NoAccess({ what }: { what: string }) {
  return (
    <section className="surface mx-auto mt-16 max-w-md rounded-2xl border border-line bg-panel p-8 text-center">
      <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border border-line bg-canvas/60 text-brand-light">
        <Icon name="lock" className="size-5" />
      </span>
      <h1 className="text-lg font-semibold text-white">Owners only</h1>
      <p className="mt-2 text-sm text-muted">{what} is only available to owners. Ask an owner if you need something from here.</p>
      <Link href="/" className={`${btnGhost} mt-5`}>
        Back to Home
      </Link>
    </section>
  );
}

/* ---------- loading ---------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Generic page skeleton used by loading.tsx files: header, optional stat row, then cards or a grid of tiles. */
export function PageSkeleton({ stats = 0, tiles = 0, rows = 0, columns = 0 }: { stats?: number; tiles?: number; rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      <div className="mb-8 space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {stats > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: stats }, (_, i) => (
            <div key={i} className="rounded-2xl border border-line bg-panel p-5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-28" />
              <Skeleton className="mt-2 h-3 w-16" />
            </div>
          ))}
        </div>
      )}
      {columns > 0 && (
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: columns }, (_, i) => (
            <div key={i} className="w-[85%] shrink-0 space-y-3 rounded-2xl border border-line bg-panel/60 p-3 sm:w-72 xl:w-auto xl:flex-1">
              <Skeleton className="h-4 w-24" />
              {Array.from({ length: 3 - (i % 2) }, (_, j) => (
                <Skeleton key={j} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      )}
      {tiles > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: tiles }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-line bg-panel">
              <Skeleton className="h-28 w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      )}
      {rows > 0 && (
        <div className="rounded-2xl border border-line bg-panel p-5">
          <Skeleton className="mb-5 h-4 w-32" />
          <div className="space-y-4">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

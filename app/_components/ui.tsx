import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink/60">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-ink/[0.06] bg-panel ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-ink/5 px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" }) {
  const color = tone === "bad" ? "text-red-400" : tone === "good" ? "text-emerald-400" : "";
  return (
    <div className="rounded-2xl border border-ink/[0.06] bg-panel p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-ink/50">{label}</div>
      <div className={`num mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink/50">{hint}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  green: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20",
  yellow: "bg-amber-500/10 text-amber-300 ring-amber-400/20",
  red: "bg-red-500/10 text-red-300 ring-red-400/20",
  gray: "bg-ink/5 text-ink/60 ring-ink/10",
  blue: "bg-brand-soft text-brand-light ring-brand/25",
  brand: "bg-brand-soft text-brand-light ring-brand/25",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof TONES | string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone] ?? TONES.gray}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink/50">{children}</p>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-ink/5 text-left text-xs uppercase tracking-wide text-ink/50">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5">{children}</tbody>
      </table>
    </div>
  );
}

/** Form control style without a width; use for inline controls. */
export const field = "rounded-lg border border-ink/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
export const input = `w-full ${field}`;
export const label = "mb-1 block text-xs font-medium text-ink/60";
export const btn = "brand-gradient inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
export const btnBrand = "brand-gradient inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
export const btnGhost = "inline-flex items-center justify-center rounded-lg border border-ink/10 bg-panel px-3 py-2 text-sm font-medium hover:bg-ink/5 disabled:opacity-50";

export const HEALTH_TONE: Record<string, string> = { green: "green", yellow: "yellow", red: "red" };

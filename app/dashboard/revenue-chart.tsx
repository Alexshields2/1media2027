"use client";

import { useEffect, useRef, useState } from "react";

export type RevenueMonth = { period: string; billed: number; collected: number };

const eur = (n: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
const short = (n: number) => (n >= 1000 ? `€${Math.round(n / 100) / 10}k` : `€${Math.round(n)}`);
const monthName = (p: string, style: "short" | "long" = "short") => new Date(`${p}T12:00:00Z`).toLocaleDateString("en-IE", { month: style, timeZone: "UTC" });

/** Revenue this year: cumulative collected (area) against cumulative billed (dashed), with a hover/keyboard tooltip per month. */
export function RevenueChart({ months }: { months: RevenueMonth[] }) {
  const pts = months.reduce<{ period: string; billed: number; collected: number; cumBilled: number; cumCollected: number }[]>((acc, m) => {
    const prev = acc[acc.length - 1];
    acc.push({ ...m, cumBilled: (prev?.cumBilled ?? 0) + m.billed, cumCollected: (prev?.cumCollected ?? 0) + m.collected });
    return acc;
  }, []);
  const [active, setActive] = useState(pts.length - 1);
  // Draw at the real width so labels stay a readable size on phones.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!pts.length) return null;

  const H = W < 520 ? 200 : 240;
  const narrow = W < 520;
  const pad = { l: 48, r: 16, t: 16, b: 28 };
  const max = niceMax(Math.max(...pts.map((p) => Math.max(p.cumBilled, p.cumCollected)), 1));
  const x = (i: number) => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (pts.length - 1));
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const line = (key: "cumBilled" | "cumCollected") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = `${line("cumCollected")} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const a = pts[Math.min(active, pts.length - 1)];
  const tipLeft = (x(active) / W) * 100;

  return (
    <div>
      <div
        ref={box}
        className="relative rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
        tabIndex={0}
        role="group"
        aria-label="Revenue this year by month. Use the left and right arrow keys to read each month."
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setActive((i) => Math.max(0, i - 1));
          if (e.key === "ArrowRight") setActive((i) => Math.min(pts.length - 1, i + 1));
        }}
        onMouseLeave={() => setActive(pts.length - 1)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden>
          <defs>
            <linearGradient id="rev-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#38c4fa" stopOpacity="0.35" />
              <stop offset="1" stopColor="#38c4fa" stopOpacity="0" />
            </linearGradient>
            <filter id="rev-glow" x="-10%" y="-30%" width="120%" height="160%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#13284a" strokeWidth="1" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#8b9cb5">
                {short(t)}
              </text>
            </g>
          ))}
          {pts.map((p, i) => (
            <text key={p.period} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill={i === active ? "#eef4fb" : "#8b9cb5"}>
              {narrow ? monthName(p.period).slice(0, 1) : monthName(p.period)}
            </text>
          ))}
          <path d={area} fill="url(#rev-fill)" />
          <path d={line("cumBilled")} fill="none" stroke="#8b9cb5" strokeWidth="1.5" strokeDasharray="4 4" />
          <path d={line("cumCollected")} fill="none" stroke="#38c4fa" strokeWidth="5" opacity="0.45" filter="url(#rev-glow)" />
          <path d={line("cumCollected")} fill="none" stroke="#38c4fa" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
          <line x1={x(active)} x2={x(active)} y1={pad.t} y2={y(0)} stroke="#38c4fa" strokeOpacity="0.4" strokeWidth="1" />
          <circle cx={x(active)} cy={y(a.cumBilled)} r="4" fill="#061126" stroke="#8b9cb5" strokeWidth="2" />
          <circle cx={x(active)} cy={y(a.cumCollected)} r="5" fill="#38c4fa" stroke="#061126" strokeWidth="2" />
          {pts.map((p, i) => (
            <rect
              key={p.period}
              x={x(i) - (W - pad.l - pad.r) / Math.max(1, pts.length - 1) / 2}
              y={0}
              width={(W - pad.l - pad.r) / Math.max(1, pts.length - 1)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
              onClick={() => setActive(i)}
            />
          ))}
        </svg>
        <div
          className="pointer-events-none absolute top-2 z-10 hidden w-48 sm:block -translate-x-1/2 rounded-xl border border-line-strong bg-canvas/95 px-3 py-2.5 text-xs shadow-[0_8px_30px_rgb(0_0_0/0.5)] backdrop-blur"
          style={{ left: `clamp(6rem, ${tipLeft}%, calc(100% - 6rem))` }}
          aria-live="polite"
        >
          <div className="font-semibold text-white">{monthName(a.period, "long")}</div>
          <div className="mt-1.5 flex justify-between gap-3 text-soft">
            <span>Collected</span>
            <span className="num font-medium text-white">{eur(a.collected)}</span>
          </div>
          <div className="flex justify-between gap-3 text-soft">
            <span>Billed</span>
            <span className="num text-white">{eur(a.billed)}</span>
          </div>
          <div className="mt-1.5 flex justify-between gap-3 border-t border-line pt-1.5 text-soft">
            <span>Year to date</span>
            <span className="num font-semibold text-brand-light">{eur(a.cumCollected)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-line bg-canvas/50 px-3 py-2 text-xs sm:hidden" aria-hidden>
        <div>
          <div className="font-semibold text-white">{monthName(a.period, "long")}</div>
          <div className="text-muted">tap the chart</div>
        </div>
        <div>
          <div className="text-muted">Collected</div>
          <div className="num font-medium text-white">{eur(a.collected)}</div>
        </div>
        <div>
          <div className="text-muted">Year to date</div>
          <div className="num font-semibold text-brand-light">{eur(a.cumCollected)}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 rounded-full bg-brand-light shadow-[0_0_6px_#38c4fa]" /> Collected to date
        </span>
        <span className="flex items-center gap-2">
          <span className="w-4 border-t-2 border-dashed border-muted" /> Billed to date
        </span>
      </div>
      <table className="sr-only">
        <caption>Revenue by month this year</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Billed</th>
            <th>Collected</th>
            <th>Collected year to date</th>
          </tr>
        </thead>
        <tbody>
          {pts.map((p) => (
            <tr key={p.period}>
              <td>{monthName(p.period, "long")}</td>
              <td>{eur(p.billed)}</td>
              <td>{eur(p.collected)}</td>
              <td>{eur(p.cumCollected)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function niceMax(v: number) {
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v / 4)! * mag;
  return Math.ceil(v / step) * step;
}

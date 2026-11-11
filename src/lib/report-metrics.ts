import { addMonths, monthLabel, today, weekStart } from "./dates";

// Report numbers and periods. Pure functions: no database, so they're easy to test.

export interface Metrics {
  spend: number | null;
  leads: number | null;
  cpl: number | null;
  impressions: number | null;
  clicks: number | null;
  /** Percent, e.g. 1.48 means 1.48%. */
  ctr: number | null;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Fills CPL and CTR from the base numbers, so they always agree with spend, leads,
 * impressions and clicks (the model's arithmetic is never trusted over the data).
 * A given CPL/CTR is kept only when it can't be computed.
 */
export function deriveMetrics(m: Partial<Metrics>): Metrics {
  const spend = isNum(m.spend) ? round(m.spend) : null;
  const leads = isNum(m.leads) ? Math.round(m.leads) : null;
  const impressions = isNum(m.impressions) ? Math.round(m.impressions) : null;
  const clicks = isNum(m.clicks) ? Math.round(m.clicks) : null;
  let cpl = isNum(m.cpl) ? round(m.cpl) : null;
  if (spend !== null && leads !== null) cpl = leads > 0 ? round(spend / leads) : null;
  let ctr = isNum(m.ctr) ? round(m.ctr) : null;
  if (impressions !== null && clicks !== null) ctr = impressions > 0 ? round((clicks / impressions) * 100) : null;
  return { spend, leads, cpl, impressions, clicks, ctr };
}

/** Sums several periods (e.g. a month's weekly reports) and recomputes CPL and CTR. */
export function sumMetrics(rows: Partial<Metrics>[]): Metrics {
  const sum = (k: "spend" | "leads" | "impressions" | "clicks") => {
    const vals = rows.map((r) => r[k]).filter(isNum);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return deriveMetrics({ spend: sum("spend"), leads: sum("leads"), impressions: sum("impressions"), clicks: sum("clicks") });
}

/** True when a report has the core numbers a weekly report must carry. */
export function hasCoreNumbers(m: Partial<Metrics>): boolean {
  return isNum(m.spend) && isNum(m.leads);
}

/** Percentage change, or null when there's nothing to compare. */
export function pctChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (!isNum(now) || !isNum(before) || before === 0) return null;
  return round(((now - before) / before) * 100, 0);
}

// ---------- periods ----------

export interface Period {
  kind: "weekly" | "monthly";
  /** reports.period: the Monday (weekly) or YYYY-MM (monthly). */
  period: string;
  start: string;
  end: string;
  label: string;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function weekPeriod(monday: string): Period {
  const start = weekStart(monday);
  const end = addDays(start, 6);
  return { kind: "weekly", period: start, start, end, label: `${shortDate(start)} – ${shortDate(end)}` };
}

export function monthPeriod(month: string): Period {
  const start = `${month.slice(0, 7)}-01`;
  const end = addDays(addMonths(start, 1), -1);
  return { kind: "monthly", period: start.slice(0, 7), start, end, label: monthLabel(start) };
}

/** The week a Monday report covers: the last full Monday–Sunday before the given day. */
export function reportWeek(d: string = today()): Period {
  return weekPeriod(addDays(weekStart(d), -7));
}

/** The month a month-end report covers: the calendar month before the given day. */
export function reportMonth(d: string = today()): Period {
  return monthPeriod(addMonths(`${d.slice(0, 7)}-01`, -1));
}

export function periodFor(kind: "weekly" | "monthly", period: string): Period {
  return kind === "weekly" ? weekPeriod(period) : monthPeriod(period);
}

export function shiftWeek(monday: string, weeks: number): string {
  return addDays(weekStart(monday), weeks * 7);
}

export { toWhatsApp } from "./whatsapp";

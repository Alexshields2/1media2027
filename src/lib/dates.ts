import { config } from "../config";

/** Today in Dublin as YYYY-MM-DD. */
export function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

/** First day of the month for a YYYY-MM-DD or YYYY-MM string. */
export function monthStart(d: string = today()): string {
  return `${d.slice(0, 7)}-01`;
}

export function addMonths(monthStartIso: string, n: number): string {
  const [y, m] = monthStartIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing the date. */
export function weekStart(d: string = today()): string {
  const dt = new Date(`${d}T12:00:00Z`);
  const day = (dt.getUTCDay() + 6) % 7; // Mon = 0
  dt.setUTCDate(dt.getUTCDate() - day);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function monthLabel(monthStartIso: string): string {
  const [y, m] = monthStartIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IE", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function eur(n: number | null | undefined, currency = "EUR"): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

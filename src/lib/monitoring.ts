// Lightweight server error reporting: a structured log line (searchable in Vercel's
// Runtime Logs) and, when SLACK_WEBHOOK_URL is set, a short Slack alert.
// Alerts are rate-limited per server instance so a crash loop can't flood Slack:
// the same error is alerted at most once per window, and at most MAX_PER_WINDOW in total.
// For stack traces, grouping and release tracking, Sentry is the natural upgrade.

export type ErrorReport = {
  message: string;
  digest?: string;
  stack?: string;
  path?: string;
  method?: string;
  routePath?: string;
  routeType?: string;
};

export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_PER_WINDOW = 5;

type Limiter = { windowStart: number; sent: number; seen: Map<string, number> };

export function createLimiter(): Limiter {
  return { windowStart: 0, sent: 0, seen: new Map() };
}

/** True if an alert for this signature may be sent now (and records it). */
export function shouldAlert(l: Limiter, signature: string, now = Date.now()): boolean {
  if (now - l.windowStart >= WINDOW_MS) {
    l.windowStart = now;
    l.sent = 0;
  }
  for (const [k, t] of l.seen) if (now - t >= WINDOW_MS) l.seen.delete(k);
  if (l.seen.has(signature) || l.sent >= MAX_PER_WINDOW) return false;
  l.seen.set(signature, now);
  l.sent++;
  return true;
}

export function toReport(err: unknown, req?: { path?: string; method?: string }, ctx?: { routePath?: string; routeType?: string }): ErrorReport {
  const e = err instanceof Error ? (err as Error & { digest?: string }) : null;
  return {
    message: e ? e.message : String(err),
    digest: e?.digest,
    stack: e?.stack?.split("\n").slice(0, 8).join("\n"),
    path: req?.path,
    method: req?.method,
    routePath: ctx?.routePath,
    routeType: ctx?.routeType,
  };
}

export function slackText(r: ErrorReport): string {
  const where = [r.method, r.path].filter(Boolean).join(" ") || r.routePath || "server";
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
  const msg = r.message.length > 300 ? `${r.message.slice(0, 300)}…` : r.message;
  return `:rotating_light: 1Media OS error (${env}) on \`${where}\`\n>${msg}${r.digest ? `\ndigest: ${r.digest}` : ""}`;
}

const g = globalThis as unknown as { __omErrLimiter?: Limiter };

/** Log the error as one JSON line and alert Slack (rate-limited). Never throws. */
export async function reportError(r: ErrorReport): Promise<void> {
  try {
    console.error(JSON.stringify({ level: "error", source: "1media-os", time: new Date().toISOString(), ...r }));
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) return;
    const limiter = (g.__omErrLimiter ??= createLimiter());
    if (!shouldAlert(limiter, `${r.routePath ?? r.path ?? ""}|${r.message}`)) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: slackText(r) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // reporting must never cause a second failure
  }
}

// The weekly standard: what every active client should get from us each week.
// Computed from data already in the OS (reports, health checks, tasks, payments, briefs); nothing is stored.

import { and, eq, gte, inArray, lt, ne, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { today, weekStart } from "./dates";
import { reportWeek } from "./report-metrics";

export type StandardKey = "report" | "health" | "light" | "leads" | "tasks" | "paid" | "contact";

export interface StandardItem {
  key: StandardKey;
  label: string;
  done: boolean;
  /** Why it's done or not, in a few words. */
  detail: string;
  /** Where to fix it, relative to the client page or absolute. */
  href: string;
}

export interface StandardInput {
  clientId: number;
  /** This week's weekly report (the week reportWeek() covers), if one exists. */
  report?: { status: "draft" | "sent" } | null;
  /** This week's health check, if one exists. */
  health?: { status: "green" | "yellow" | "red"; resolved: boolean; untouched?: "green" | "yellow" | "red" | "unknown" | null } | null;
  overdueTasks: number;
  /** Overdue payment rows; undefined when the viewer can't see money (the item is left out). */
  overduePayments?: number;
  /** Call-prep or inbox notes in the last 7 days. */
  touchpoints: number;
}

export interface StandardResult {
  clientId: number;
  items: StandardItem[];
  done: number;
  total: number;
  onStandard: boolean;
}

export function weeklyStandard(i: StandardInput): StandardResult {
  const c = `/clients/${i.clientId}`;
  const items: StandardItem[] = [
    {
      key: "report",
      label: "Weekly report sent",
      done: i.report?.status === "sent",
      detail: i.report ? (i.report.status === "sent" ? "Sent" : "Drafted, not sent") : "Not written yet",
      href: "/reports",
    },
    {
      key: "health",
      label: "Health checked this week",
      done: !!i.health,
      detail: i.health ? "Scored" : "No check this week",
      href: "/health",
    },
    {
      key: "light",
      label: "Not red",
      done: !!i.health && (i.health.status !== "red" || i.health.resolved),
      detail: !i.health ? "Unknown until checked" : i.health.status === "red" ? (i.health.resolved ? "Red, resolved" : "Red and not resolved") : `${i.health.status[0].toUpperCase()}${i.health.status.slice(1)}`,
      href: "/health",
    },
  ];
  // Leads worked is only known when the health check had GHL numbers.
  if (i.health?.untouched && i.health.untouched !== "unknown") {
    items.push({
      key: "leads",
      label: "Leads worked within 24h",
      done: i.health.untouched === "green",
      detail: i.health.untouched === "green" ? "Every lead contacted" : "Leads left untouched",
      href: "/health",
    });
  }
  items.push({
    key: "tasks",
    label: "No overdue tasks",
    done: i.overdueTasks === 0,
    detail: i.overdueTasks ? `${i.overdueTasks} overdue` : "All on time",
    href: `/tasks?client=${i.clientId}`,
  });
  if (i.overduePayments !== undefined) {
    items.push({
      key: "paid",
      label: "Paid up",
      done: i.overduePayments === 0,
      detail: i.overduePayments ? `${i.overduePayments} payment${i.overduePayments === 1 ? "" : "s"} overdue` : "Nothing overdue",
      href: "/payments",
    });
  }
  items.push({
    key: "contact",
    label: "Touchpoint in the last 7 days",
    done: i.touchpoints > 0,
    detail: i.touchpoints ? "Call prep or inbox note logged" : "No call prep or inbox note",
    href: `${c}#call-prep`,
  });
  const done = items.filter((x) => x.done).length;
  return { clientId: i.clientId, items, done, total: items.length, onStandard: done === items.length };
}

/** The weekly standard for active clients (or the given ones). Pass billing=false for people who can't see money. */
export async function loadWeeklyStandards(opts: { billing: boolean; clientIds?: number[] }): Promise<Map<number, StandardResult>> {
  const ids =
    opts.clientIds ??
    (await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.status, "active"))).map((c) => c.id);
  if (!ids.length) return new Map();
  const t0 = today();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [reports, health, tasks, payments, briefs] = await Promise.all([
    db
      .select({ clientId: schema.reports.clientId, status: schema.reports.status })
      .from(schema.reports)
      .where(and(eq(schema.reports.kind, "weekly"), eq(schema.reports.period, reportWeek().period), inArray(schema.reports.clientId, ids))),
    db.select().from(schema.healthChecks).where(and(eq(schema.healthChecks.weekOf, weekStart()), inArray(schema.healthChecks.clientId, ids))),
    db
      .select({ clientId: schema.tasks.clientId })
      .from(schema.tasks)
      .where(and(ne(schema.tasks.status, "done"), lt(schema.tasks.dueDate, t0), inArray(schema.tasks.clientId, ids))),
    opts.billing
      ? db
          .select({ clientId: schema.payments.clientId })
          .from(schema.payments)
          .where(and(dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`, lt(schema.payments.dueDate, t0), inArray(schema.payments.clientId, ids)))
      : Promise.resolve([]),
    db
      .select({ clientId: schema.briefs.clientId })
      .from(schema.briefs)
      .where(and(gte(schema.briefs.createdAt, since), inArray(schema.briefs.clientId, ids))),
  ]);
  const count = (rows: { clientId: number | null }[], id: number) => rows.filter((r) => r.clientId === id).length;
  return new Map(
    ids.map((id) => {
      const r = reports.find((x) => x.clientId === id && x.status === "sent") ?? reports.find((x) => x.clientId === id);
      const h = health.find((x) => x.clientId === id);
      return [
        id,
        weeklyStandard({
          clientId: id,
          report: r ? { status: r.status } : null,
          health: h ? { status: h.status, resolved: h.resolved, untouched: h.signals.find((s) => s.key === "untouched")?.status ?? null } : null,
          overdueTasks: count(tasks, id),
          overduePayments: opts.billing ? count(payments, id) : undefined,
          touchpoints: count(briefs, id),
        }),
      ];
    }),
  );
}

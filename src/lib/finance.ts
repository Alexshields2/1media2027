import { and, desc, eq, gte, like, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { round2 } from "./billing";
import { addMonths, daysBetween, eur, monthLabel, monthStart, today, weekStart } from "./dates";
import { aging, AGING_BUCKETS } from "./matching";
import { listUnmatched } from "./reconcile";
import { notify } from "./slack";

// Receivables, chasers and the weekly cash summary. Used by the Payments page and the finance agent's tools.
// All numbers are computed here from the database; the agent never does the arithmetic.

export type ChaserStage = "3" | "7" | "14";

export function chaserStage(days: number): ChaserStage | null {
  return days >= 14 ? "14" : days >= 7 ? "7" : days >= 3 ? "3" : null;
}

const chaserMarker = (clientId: number, stage: ChaserStage) => `[chaser client=${clientId} stage=${stage}]`;

/** Money owed on rows already due, by age bucket and by client, plus the overdue rows themselves. */
export async function receivables(on: string = today()) {
  const rows = await db
    .select({ p: schema.payments, c: schema.clients })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(and(dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`, lte(schema.payments.dueDate, on)))
    .orderBy(schema.payments.dueDate);
  const a = aging(
    rows.map(({ p, c }) => ({ clientId: c.id, clientName: c.name, dueDate: p.dueDate, owed: round2(p.amountDue - p.amountCollected) })),
    on,
  );
  const chasers = await db
    .select({ reason: schema.approvals.reason, status: schema.approvals.status })
    .from(schema.approvals)
    .where(like(schema.approvals.reason, "%[chaser client=%"));
  const chased = (clientId: number) =>
    (["3", "7", "14"] as ChaserStage[]).filter((s) => chasers.some((c) => c.reason?.includes(chaserMarker(clientId, s))));
  const overdueRows = rows.map(({ p, c }) => {
    const days = daysBetween(p.dueDate, on);
    return {
      paymentId: p.id,
      clientId: c.id,
      client: c.name,
      contact: c.contactName,
      email: c.email,
      billingMethod: c.billingMethod,
      label: p.label,
      month: monthLabel(p.period),
      dueDate: p.dueDate,
      days,
      owed: round2(p.amountDue - p.amountCollected),
      collected: p.amountCollected,
      notes: p.notes,
    };
  });
  const clients = a.clients.map((c) => {
    const stage = chaserStage(c.oldestDays);
    const done = chased(c.clientId);
    return { ...c, chaserDue: stage && !done.includes(stage) ? stage : null, chasersQueued: done };
  });
  return { asOf: on, totals: a.totals, counts: a.counts, total: a.total, clients, overdueRows };
}

/**
 * Queues a chaser email as an approval (GMAIL_SEND_EMAIL). Nothing is sent until the owner approves it.
 * One chaser per client per stage: a second request for the same stage is skipped.
 */
export async function queueChaser(i: { clientId: number; stage: ChaserStage; subject: string; body: string; runId?: number; agent?: string }) {
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, i.clientId));
  if (!client) throw new Error(`Client ${i.clientId} not found`);
  if (!client.email) throw new Error(`${client.name} has no email on file. Flag it instead of chasing.`);
  const r = await receivables();
  const bal = r.clients.find((c) => c.clientId === i.clientId);
  if (!bal) throw new Error(`${client.name} has nothing overdue.`);
  if (bal.oldestDays < Number(i.stage)) throw new Error(`${client.name} is ${bal.oldestDays} days overdue; the ${i.stage}-day chaser isn't due yet.`);
  const marker = chaserMarker(i.clientId, i.stage);
  // The runner executes tool calls in parallel: lock per client+stage so two calls can't both queue one.
  return db.transaction(async (tx) => {
    await tx.execute(dsql`select pg_advisory_xact_lock(hashtext(${marker}))`);
    const [existing] = await tx.select({ id: schema.approvals.id, status: schema.approvals.status }).from(schema.approvals).where(like(schema.approvals.reason, `%${marker}%`));
    if (existing) return { ok: true, skipped: `A ${i.stage}-day chaser for ${client.name} already exists (approval ${existing.id}, ${existing.status}).` };
    const [a] = await tx
      .insert(schema.approvals)
      .values({
        runId: i.runId ?? null,
        agent: i.agent ?? "finance",
        tool: "GMAIL_SEND_EMAIL",
        input: { recipient_email: client.email!, subject: i.subject, body: i.body },
        reason: `${i.stage}-day chaser for ${client.name}: ${eur(bal.balance)} owed, oldest ${bal.oldestDays} days overdue. ${marker}`,
      })
      .returning({ id: schema.approvals.id });
    return { ok: true, approval_id: a.id, to: client.email };
  });
}

/** Collected, outstanding, overdue by age and a month-end forecast, as of a date. */
export async function cashSummaryData(on: string = today()) {
  const month = monthStart(on);
  const nextMonth = addMonths(month, 1);
  const wk = weekStart(on);
  const sumCollected = async (from: string) => {
    const [r] = await db
      .select({ s: dsql<string>`coalesce(sum(${schema.payments.amountCollected}), 0)` })
      .from(schema.payments)
      .where(and(gte(schema.payments.paidDate, from), lte(schema.payments.paidDate, on)));
    return round2(Number(r.s));
  };
  const [collectedWeek, collectedMonth, rec, monthRows, unmatched] = await Promise.all([
    sumCollected(wk),
    sumCollected(month),
    receivables(on),
    db
      .select()
      .from(schema.payments)
      .where(and(gte(schema.payments.dueDate, month), dsql`${schema.payments.dueDate} < ${nextMonth}`)),
    listUnmatched(),
  ]);
  const dueThisMonth = round2(monthRows.reduce((s, p) => s + p.amountDue, 0));
  const stillDueThisMonth = round2(monthRows.reduce((s, p) => s + Math.max(0, p.amountDue - p.amountCollected), 0));
  const recentOverdueOlder = round2(
    rec.overdueRows.filter((r) => r.dueDate < month && r.days <= 30).reduce((s, r) => s + r.owed, 0),
  );
  const forecast = round2(collectedMonth + stillDueThisMonth + recentOverdueOlder);
  return {
    asOf: on,
    month: monthLabel(month),
    collectedWeek,
    collectedMonth,
    dueThisMonth,
    stillDueThisMonth,
    outstanding: rec.total,
    overdue: rec.totals,
    overdueCounts: rec.counts,
    forecast,
    forecastParts: { collectedMonth, stillDueThisMonth, overdueUnder30FromEarlierMonths: recentOverdueOlder },
    largest: rec.clients.slice(0, 3).map((c) => ({ client: c.clientName, balance: c.balance, oldestDays: c.oldestDays })),
    unmatched: { count: unmatched.length, amount: round2(unmatched.reduce((s, u) => s + u.remaining, 0)) },
  };
}

export type CashSummaryData = Awaited<ReturnType<typeof cashSummaryData>>;

export function cashSummaryText(d: CashSummaryData, commentary?: string): string {
  const lines = [
    `Cash summary, week to ${d.asOf}`,
    "",
    `Collected this week: ${eur(d.collectedWeek)}`,
    `Collected in ${d.month}: ${eur(d.collectedMonth)} of ${eur(d.dueThisMonth)} billed`,
    `Outstanding (due and unpaid): ${eur(d.outstanding)}`,
    "",
    "Overdue by age:",
    ...AGING_BUCKETS.map((b) => `  ${b.label}: ${eur(d.overdue[b.key])} (${d.overdueCounts[b.key]} row${d.overdueCounts[b.key] === 1 ? "" : "s"})`),
    "",
    `Forecast for ${d.month}: ${eur(d.forecast)} (collected so far + still due this month + overdue under 30 days from earlier months)`,
  ];
  if (d.largest.length) {
    lines.push("", "Largest balances:", ...d.largest.map((l) => `  ${l.client}: ${eur(l.balance)}, oldest ${l.oldestDays} days`));
  }
  if (d.unmatched.count) lines.push("", `Unmatched payments to assign: ${d.unmatched.count} (${eur(d.unmatched.amount)})`);
  if (commentary?.trim()) lines.push("", commentary.trim());
  return lines.join("\n");
}

/** Builds the summary from the database, saves it, and posts it to Slack when SLACK_WEBHOOK_URL is set. */
export async function saveCashSummary(opts: { on?: string; commentary?: string; runId?: number; post?: boolean } = {}) {
  const data = await cashSummaryData(opts.on ?? today());
  const body = cashSummaryText(data, opts.commentary);
  const posted = opts.post === false ? false : await notify(body);
  const [row] = await db
    .insert(schema.cashSummaries)
    .values({ asOf: data.asOf, body, data: data as unknown as Record<string, unknown>, postedToSlack: posted, runId: opts.runId ?? null })
    .returning();
  return row;
}

export async function latestCashSummary() {
  const [row] = await db.select().from(schema.cashSummaries).orderBy(desc(schema.cashSummaries.createdAt)).limit(1);
  return row;
}

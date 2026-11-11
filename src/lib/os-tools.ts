import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { and, desc, eq, gte, inArray, ne, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { recordPayment, paymentState, round2 } from "./billing";
import { today, weekStart } from "./dates";
import { deriveMetrics, periodFor } from "./report-metrics";

// Tools that let agents read and write the 1Media OS database.
// Names start with OS_ so the guardrails treat them as internal.

interface OsTool {
  def: Anthropic.Tool;
  input: z.ZodType;
  run: (input: any, ctx: OsToolContext) => Promise<unknown>;
}

export interface OsToolContext {
  /** The agent run making the call (linked from saved reports). */
  runId?: number;
}

const id = z.coerce.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const tools: Record<string, OsTool> = {
  OS_LIST_CLIENTS: {
    def: {
      name: "OS_LIST_CLIENTS",
      description:
        "List 1Media clients with their retainer, billing, ad account IDs, GHL location, CPL target and report rules. Defaults to active and onboarding clients.",
      input_schema: {
        type: "object",
        properties: {
          include_inactive: { type: "boolean", description: "Also return paused and churned clients." },
        },
      },
    },
    input: z.object({ include_inactive: z.boolean().optional() }),
    run: async ({ include_inactive }) =>
      db
        .select()
        .from(schema.clients)
        .where(include_inactive ? undefined : inArray(schema.clients.status, ["active", "onboarding"]))
        .orderBy(schema.clients.name),
  },

  OS_LIST_PAYMENTS: {
    def: {
      name: "OS_LIST_PAYMENTS",
      description:
        "List retainer payments. filter=outstanding returns everything not fully collected that is due on or before today; filter=month returns all rows for one month.",
      input_schema: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["outstanding", "month"] },
          month: { type: "string", description: "YYYY-MM, required when filter=month." },
        },
        required: ["filter"],
      },
    },
    input: z.object({ filter: z.enum(["outstanding", "month"]), month: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
    run: async ({ filter, month }) => {
      const where =
        filter === "month"
          ? eq(schema.payments.period, `${month ?? today().slice(0, 7)}-01`)
          : and(dsql`${schema.payments.amountCollected} < ${schema.payments.amountDue}`, dsql`${schema.payments.dueDate} <= ${today()}`);
      const rows = await db
        .select({ p: schema.payments, client: schema.clients.name, email: schema.clients.email, contact: schema.clients.contactName, stripeCustomerId: schema.clients.stripeCustomerId })
        .from(schema.payments)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
        .where(where)
        .orderBy(schema.payments.dueDate);
      return rows.map((r) => ({ ...r.p, client: r.client, clientEmail: r.email, clientContact: r.contact, stripeCustomerId: r.stripeCustomerId, state: paymentState(r.p), owed: round2(r.p.amountDue - r.p.amountCollected) }));
    },
  },

  OS_RECORD_PAYMENT: {
    def: {
      name: "OS_RECORD_PAYMENT",
      description:
        "Record money received against a payment row. amount is the TOTAL collected so far for that row (not the increment). Only call this when you have seen proof of payment.",
      input_schema: {
        type: "object",
        properties: {
          payment_id: { type: "integer" },
          amount: { type: "number" },
          paid_date: { type: "string", description: "YYYY-MM-DD" },
          method: { type: "string", enum: ["stripe", "invoice", "revolut", "aib", "cash"] },
          note: { type: "string", description: "What proves the payment, e.g. 'Stripe invoice in_123 paid 3 Nov'." },
          stripe_invoice_id: { type: "string" },
        },
        required: ["payment_id", "amount", "note"],
      },
    },
    input: z.object({
      payment_id: id,
      amount: z.number().nonnegative(),
      paid_date: isoDate.optional(),
      method: z.enum(["stripe", "invoice", "revolut", "aib", "cash"]).optional(),
      note: z.string().min(3),
      stripe_invoice_id: z.string().optional(),
    }),
    run: async (i) => {
      await recordPayment(i.payment_id, { amount: i.amount, paidDate: i.paid_date, method: i.method, note: i.note, stripeInvoiceId: i.stripe_invoice_id });
      return { ok: true };
    },
  },

  OS_LIST_TASKS: {
    def: {
      name: "OS_LIST_TASKS",
      description: "List tasks. Optionally for one client, by status, or only those completed since a date.",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          status: { type: "string", enum: ["open", "done", "all"] },
          completed_since: { type: "string", description: "YYYY-MM-DD; with status=done." },
        },
      },
    },
    input: z.object({ client_id: id.optional(), status: z.enum(["open", "done", "all"]).optional(), completed_since: isoDate.optional() }),
    run: async ({ client_id, status = "open", completed_since }) => {
      const conds = [];
      if (client_id) conds.push(eq(schema.tasks.clientId, client_id));
      if (status === "open") conds.push(ne(schema.tasks.status, "done"));
      if (status === "done") conds.push(eq(schema.tasks.status, "done"));
      if (completed_since) conds.push(gte(schema.tasks.completedAt, new Date(`${completed_since}T00:00:00Z`)));
      return db
        .select({ t: schema.tasks, client: schema.clients.name })
        .from(schema.tasks)
        .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(schema.tasks.createdAt))
        .limit(300)
        .then((rows) => rows.map((r) => ({ ...r.t, client: r.client })));
    },
  },

  OS_CREATE_TASK: {
    def: {
      name: "OS_CREATE_TASK",
      description: "Create a task, optionally linked to a client.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          client_id: { type: "integer" },
          details: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          due_date: { type: "string", description: "YYYY-MM-DD" },
          assignee: { type: "string" },
        },
        required: ["title"],
      },
    },
    input: z.object({
      title: z.string().min(2),
      client_id: id.optional(),
      details: z.string().optional(),
      priority: z.enum(["high", "medium", "low"]).optional(),
      due_date: isoDate.optional(),
      assignee: z.string().optional(),
    }),
    run: async (i) => {
      const [t] = await db
        .insert(schema.tasks)
        .values({ title: i.title, clientId: i.client_id, details: i.details, priority: i.priority, dueDate: i.due_date, assignee: i.assignee, source: "agent" })
        .returning({ id: schema.tasks.id });
      return { ok: true, task_id: t.id };
    },
  },

  OS_SAVE_HEALTH_CHECK: {
    def: {
      name: "OS_SAVE_HEALTH_CHECK",
      description: "Save this week's traffic-light status for a client (creates or updates the row for the week).",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          status: { type: "string", enum: ["green", "yellow", "red"] },
          cpl: { type: "number" },
          leads: { type: "integer" },
          spend: { type: "number" },
          issue: {
            type: "string",
            enum: ["Everything Healthy", "Campaign Learning", "Client Concern", "Budget Issue", "Tracking Issue", "Poor Lead Quality", "Creative Fatigue", "Lead Volume Down", "CPL Rising", "Leads Not Worked"],
          },
          reason: { type: "string", description: "One sentence with the numbers." },
          action_needed: { type: "string", description: "One concrete next step." },
        },
        required: ["client_id", "status", "issue", "reason"],
      },
    },
    input: z.object({
      client_id: id,
      status: z.enum(["green", "yellow", "red"]),
      cpl: z.number().optional(),
      leads: z.number().int().optional(),
      spend: z.number().optional(),
      issue: z.string(),
      reason: z.string(),
      action_needed: z.string().optional(),
    }),
    run: async (i) => {
      const values = {
        clientId: i.client_id,
        weekOf: weekStart(),
        status: i.status,
        cpl: i.cpl,
        leads: i.leads,
        spend: i.spend,
        issue: i.issue,
        reason: i.reason,
        actionNeeded: i.action_needed,
        source: "agent",
        updatedAt: new Date(),
      };
      await db.insert(schema.healthChecks).values(values).onConflictDoUpdate({ target: [schema.healthChecks.clientId, schema.healthChecks.weekOf], set: values });
      return { ok: true };
    },
  },

  OS_LIST_HEALTH: {
    def: {
      name: "OS_LIST_HEALTH",
      description: "Recent traffic-light rows, newest first.",
      input_schema: { type: "object", properties: { client_id: { type: "integer" }, weeks: { type: "integer" } } },
    },
    input: z.object({ client_id: id.optional(), weeks: z.number().int().min(1).max(52).optional() }),
    run: async ({ client_id, weeks = 4 }) => {
      const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
      const conds = [gte(schema.healthChecks.weekOf, since)];
      if (client_id) conds.push(eq(schema.healthChecks.clientId, client_id));
      return db
        .select({ h: schema.healthChecks, client: schema.clients.name })
        .from(schema.healthChecks)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
        .where(and(...conds))
        .orderBy(desc(schema.healthChecks.weekOf))
        .then((rows) => rows.map((r) => ({ ...r.h, client: r.client })));
    },
  },

  OS_SAVE_REPORT: {
    def: {
      name: "OS_SAVE_REPORT",
      description:
        "Save a client report draft (weekly WhatsApp message or month-end report) for a human to review and send, with its numbers. Saving again for the same client, kind and period replaces the draft. CPL and CTR are worked out from spend, leads, impressions and clicks.",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          kind: { type: "string", enum: ["weekly", "monthly"] },
          period: { type: "string", description: "Weekly: the Monday the reported week started (YYYY-MM-DD). Monthly: YYYY-MM." },
          body: { type: "string", description: "The full report text, exactly as it should be sent." },
          spend: { type: "number", description: "Amount spent in the period, in the client's currency." },
          leads: { type: "integer", description: "Leads (or the client's main result, e.g. purchases) in the period." },
          impressions: { type: "integer" },
          clicks: { type: "integer", description: "Link clicks." },
          cpl: { type: "number", description: "Only if spend or leads are unknown; otherwise it is computed." },
        },
        required: ["client_id", "kind", "period", "body"],
      },
    },
    input: z.object({
      client_id: id,
      kind: z.enum(["weekly", "monthly"]),
      period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
      body: z.string().min(20),
      spend: z.number().nonnegative().optional(),
      leads: z.number().int().nonnegative().optional(),
      impressions: z.number().int().nonnegative().optional(),
      clicks: z.number().int().nonnegative().optional(),
      cpl: z.number().nonnegative().optional(),
    }),
    run: async (i, ctx) => saveReport({ ...i, run_id: ctx.runId }),
  },

  OS_LIST_REPORTS: {
    def: {
      name: "OS_LIST_REPORTS",
      description: "List saved reports for a client and kind, newest first. Use to read the month's weekly reports before writing a month-end report.",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          kind: { type: "string", enum: ["weekly", "monthly"] },
          period_prefix: { type: "string", description: "e.g. '2026-11' to get every weekly report in November." },
        },
        required: ["kind"],
      },
    },
    input: z.object({ client_id: id.optional(), kind: z.enum(["weekly", "monthly"]), period_prefix: z.string().optional() }),
    run: async ({ client_id, kind, period_prefix }) => {
      const conds = [eq(schema.reports.kind, kind)];
      if (client_id) conds.push(eq(schema.reports.clientId, client_id));
      if (period_prefix) conds.push(dsql`${schema.reports.period} like ${period_prefix + "%"}`);
      return db.select().from(schema.reports).where(and(...conds)).orderBy(desc(schema.reports.createdAt)).limit(100);
    },
  },
};

/** Creates or replaces the draft for (client, kind, period). A report already marked sent is never overwritten. */
export async function saveReport(i: {
  client_id: number;
  kind: "weekly" | "monthly";
  period: string;
  body: string;
  spend?: number;
  leads?: number;
  impressions?: number;
  clicks?: number;
  cpl?: number;
  run_id?: number;
}) {
  const p = periodFor(i.kind, i.period);
  const m = deriveMetrics(i);
  const values = {
    clientId: i.client_id,
    kind: i.kind,
    period: p.period,
    periodStart: p.start,
    periodEnd: p.end,
    body: i.body,
    ...m,
    runId: i.run_id,
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({ id: schema.reports.id, status: schema.reports.status })
    .from(schema.reports)
    .where(and(eq(schema.reports.clientId, i.client_id), eq(schema.reports.kind, i.kind), eq(schema.reports.period, p.period)))
    .orderBy(desc(schema.reports.createdAt))
    .limit(1);
  if (existing?.status === "sent") {
    return { ok: false, report_id: existing.id, error: "That report was already sent to the client, so it was not replaced." };
  }
  if (existing) {
    await db.update(schema.reports).set(values).where(eq(schema.reports.id, existing.id));
    return { ok: true, report_id: existing.id, replaced: true, ...m };
  }
  const [r] = await db.insert(schema.reports).values(values).returning({ id: schema.reports.id });
  return { ok: true, report_id: r.id, ...m };
}

export function osToolDefs(names?: string[]): Anthropic.Tool[] {
  return Object.values(tools)
    .filter((t) => !names || names.includes(t.def.name))
    .map((t) => t.def);
}

export function isOsTool(name: string): boolean {
  return name in tools;
}

/** Validates the input, runs the tool and returns a JSON string for the model. */
export async function runOsTool(name: string, rawInput: unknown, ctx: OsToolContext = {}): Promise<string> {
  const t = tools[name];
  if (!t) throw new Error(`Unknown OS tool ${name}`);
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.message}`);
  return JSON.stringify(await t.run(parsed.data, ctx));
}

export const ALL_OS_TOOLS = Object.keys(tools);

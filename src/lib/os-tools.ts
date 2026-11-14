import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { and, desc, eq, gte, inArray, ne, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { recordPayment, paymentState, round2 } from "./billing";
import { today, weekStart } from "./dates";
import { logActivity, asAgent } from "./activity";

// Tools that let agents read and write the 1Media OS database.
// Names start with OS_ so the guardrails treat them as internal.

/** Who is calling a tool, so writes can be linked to the run. */
export interface OsToolContext {
  runId?: number;
  agent?: string;
}

interface OsTool {
  def: Anthropic.Tool;
  input: z.ZodType;
  run: (input: any, ctx: OsToolContext) => Promise<unknown>;
}

/** Finds a team member by first name or email (case-insensitive). */
async function userByName(name: string | undefined) {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  const [u] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(dsql`lower(${schema.users.name}) = ${n} or lower(${schema.users.email}) = ${n} or lower(split_part(${schema.users.name}, ' ', 1)) = ${n}`)
    .limit(1);
  return u;
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
      description: "List tasks with client, assignee and who delegated them. Optionally for one client or one person, by status, or only those completed since a date.",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          assignee_id: { type: "integer", description: "Team member id from OS_LIST_TEAM." },
          status: { type: "string", enum: ["open", "done", "all"] },
          completed_since: { type: "string", description: "YYYY-MM-DD; with status=done." },
        },
      },
    },
    input: z.object({ client_id: id.optional(), assignee_id: id.optional(), status: z.enum(["open", "done", "all"]).optional(), completed_since: isoDate.optional() }),
    run: async ({ client_id, assignee_id, status = "open", completed_since }) => {
      const conds = [];
      if (client_id) conds.push(eq(schema.tasks.clientId, client_id));
      if (assignee_id) conds.push(eq(schema.tasks.assigneeId, assignee_id));
      if (status === "open") conds.push(ne(schema.tasks.status, "done"));
      if (status === "done") conds.push(eq(schema.tasks.status, "done"));
      if (completed_since) conds.push(gte(schema.tasks.completedAt, new Date(`${completed_since}T00:00:00Z`)));
      const team = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users);
      const nameOf = (uid: number | null) => team.find((u) => u.id === uid)?.name ?? null;
      return db
        .select({ t: schema.tasks, client: schema.clients.name })
        .from(schema.tasks)
        .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(schema.tasks.createdAt))
        .limit(300)
        .then((rows) =>
          rows.map((r) => ({ ...r.t, client: r.client, assignee: nameOf(r.t.assigneeId) ?? r.t.assignee, delegatedBy: nameOf(r.t.createdById) })),
        );
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
          assignee: { type: "string", description: "Team member's first name (see OS_LIST_TEAM)." },
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
    run: async (i, ctx) => {
      const who = await userByName(i.assignee);
      const [t] = await db
        .insert(schema.tasks)
        .values({ title: i.title, clientId: i.client_id, details: i.details, priority: i.priority, dueDate: i.due_date, assignee: who?.name ?? i.assignee, assigneeId: who?.id, source: "agent" })
        .returning({ id: schema.tasks.id });
      await logActivity(asAgent(ctx.agent ?? "agent"), { action: "task.created", summary: `Created task "${i.title}"${who ? ` for ${who.name}` : ""}`, entity: "task", entityId: t.id });
      return { ok: true, task_id: t.id, assignee: who?.name ?? i.assignee ?? null };
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
      description: "Save a client report draft (weekly WhatsApp message or month-end report) for a human to review and send.",
      input_schema: {
        type: "object",
        properties: {
          client_id: { type: "integer" },
          kind: { type: "string", enum: ["weekly", "monthly"] },
          period: { type: "string", description: "Weekly: the Monday the week starts (YYYY-MM-DD). Monthly: YYYY-MM." },
          body: { type: "string", description: "The full report text, exactly as it should be sent." },
          leads: { type: "integer" },
          spend: { type: "number" },
          cpl: { type: "number" },
        },
        required: ["client_id", "kind", "period", "body"],
      },
    },
    input: z.object({
      client_id: id,
      kind: z.enum(["weekly", "monthly"]),
      period: z.string().min(7),
      body: z.string().min(20),
      leads: z.number().int().optional(),
      spend: z.number().optional(),
      cpl: z.number().optional(),
    }),
    run: async (i) => {
      const [r] = await db
        .insert(schema.reports)
        .values({ clientId: i.client_id, kind: i.kind, period: i.period, body: i.body, leads: i.leads, spend: i.spend, cpl: i.cpl })
        .returning({ id: schema.reports.id });
      return { ok: true, report_id: r.id };
    },
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

  OS_LIST_TEAM: {
    def: {
      name: "OS_LIST_TEAM",
      description: "The 1Media team: id, name, role, title and who each person reports to (Alex -> Jamie -> Ryan).",
      input_schema: { type: "object", properties: {} },
    },
    input: z.object({}),
    run: async () => {
      const team = await db.select().from(schema.users).where(eq(schema.users.active, true)).orderBy(schema.users.id);
      return team.map((u) => ({ id: u.id, name: u.name, role: u.role, title: u.title, reportsTo: team.find((m) => m.id === u.managerId)?.name ?? null }));
    },
  },

  OS_LIST_EOD_REPORTS: {
    def: {
      name: "OS_LIST_EOD_REPORTS",
      description: "End-of-day reports from the team (what they did, blockers, plan for tomorrow), newest first.",
      input_schema: {
        type: "object",
        properties: {
          since: { type: "string", description: "YYYY-MM-DD; default 7 days ago." },
          user_id: { type: "integer" },
        },
      },
    },
    input: z.object({ since: isoDate.optional(), user_id: id.optional() }),
    run: async ({ since, user_id }) => {
      const from = since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const conds = [gte(schema.eodReports.date, from)];
      if (user_id) conds.push(eq(schema.eodReports.userId, user_id));
      return db
        .select({ r: schema.eodReports, name: schema.users.name })
        .from(schema.eodReports)
        .innerJoin(schema.users, eq(schema.users.id, schema.eodReports.userId))
        .where(and(...conds))
        .orderBy(desc(schema.eodReports.date))
        .then((rows) => rows.map(({ r, name }) => ({ name, date: r.date, done: r.done, blockers: r.blockers, tomorrow: r.tomorrow })));
    },
  },

  OS_LIST_ACTIVITY: {
    def: {
      name: "OS_LIST_ACTIVITY",
      description: "The OS activity log: what people and agents did (tasks, payments, approvals, SOPs, agent runs), newest first.",
      input_schema: {
        type: "object",
        properties: {
          hours: { type: "integer", description: "How far back, default 24." },
          actor: { type: "string", description: "Only this person or agent name." },
        },
      },
    },
    input: z.object({ hours: z.number().int().min(1).max(24 * 31).optional(), actor: z.string().optional() }),
    run: async ({ hours = 24, actor }) => {
      const conds = [gte(schema.activity.at, new Date(Date.now() - hours * 3_600_000))];
      if (actor) conds.push(dsql`lower(${schema.activity.actor}) = ${actor.toLowerCase()}`);
      // Skip per-tool-call noise; agent runs are summarised by their start/finish lines.
      conds.push(ne(schema.activity.action, "agent.tool"));
      return db
        .select({ at: schema.activity.at, actor: schema.activity.actor, action: schema.activity.action, summary: schema.activity.summary })
        .from(schema.activity)
        .where(and(...conds))
        .orderBy(desc(schema.activity.at))
        .limit(300);
    },
  },

  OS_LIST_APPROVALS: {
    def: {
      name: "OS_LIST_APPROVALS",
      description: "Agent actions waiting for a human to approve.",
      input_schema: { type: "object", properties: {} },
    },
    input: z.object({}),
    run: async () =>
      db
        .select({ id: schema.approvals.id, agent: schema.approvals.agent, tool: schema.approvals.tool, reason: schema.approvals.reason, createdAt: schema.approvals.createdAt })
        .from(schema.approvals)
        .where(eq(schema.approvals.status, "pending"))
        .orderBy(desc(schema.approvals.createdAt)),
  },

  OS_SAVE_BRIEFING: {
    def: {
      name: "OS_SAVE_BRIEFING",
      description: "Save a written update for a team member to read in 1Media OS (morning brief, or a business update from a voice note).",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["morning", "voice_update", "other"] },
          for_user_id: { type: "integer", description: "Who it is for (OS_LIST_TEAM). Leave out for everyone." },
          title: { type: "string" },
          body: { type: "string", description: "Markdown." },
          voice_note_id: { type: "integer" },
        },
        required: ["kind", "title", "body"],
      },
    },
    input: z.object({ kind: z.enum(["morning", "voice_update", "other"]), for_user_id: id.optional(), title: z.string().min(3), body: z.string().min(20), voice_note_id: id.optional() }),
    run: async (i, ctx) => {
      const [b] = await db
        .insert(schema.briefings)
        .values({ kind: i.kind, forUserId: i.for_user_id, title: i.title, body: i.body, voiceNoteId: i.voice_note_id, runId: ctx.runId })
        .returning({ id: schema.briefings.id });
      if (i.voice_note_id) await db.update(schema.voiceNotes).set({ status: "done" }).where(eq(schema.voiceNotes.id, i.voice_note_id));
      return { ok: true, briefing_id: b.id };
    },
  },
};

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

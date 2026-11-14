import {
  pgTable, serial, text, integer, numeric, date, timestamp, boolean, jsonb, uniqueIndex, index, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["onboarding", "active", "paused", "churned"] }).notNull().default("active"),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  industry: text("industry"),
  retainerExVat: money("retainer_ex_vat").notNull().default(0),
  vat: text("vat", { enum: ["plus", "inc", "none"] }).notNull().default("plus"),
  billingMethod: text("billing_method", { enum: ["stripe", "invoice", "revolut", "aib", "cash"] }).notNull().default("invoice"),
  startDate: date("start_date"),
  // Integrations
  metaAdAccountIds: text("meta_ad_account_ids"),
  ghlLocationId: text("ghl_location_id"),
  stripeCustomerId: text("stripe_customer_id"),
  // Reporting
  cplTarget: money("cpl_target"),
  reportCurrency: text("report_currency", { enum: ["EUR", "USD"] }).notNull().default("EUR"),
  reportGreeting: text("report_greeting").notNull().default("Hi guys"),
  reportRules: text("report_rules"),
  goals: text("goals"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per client retainer line per month. */
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("Retainer"),
    period: date("period").notNull(), // first day of the month it covers
    amountDue: money("amount_due").notNull(),
    amountCollected: money("amount_collected").notNull().default(0),
    dueDate: date("due_date").notNull(),
    paidDate: date("paid_date"),
    method: text("method", { enum: ["stripe", "invoice", "revolut", "aib", "cash"] }),
    stripeInvoiceId: text("stripe_invoice_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payments_client_period_label").on(t.clientId, t.period, t.label)],
);

/** Team accounts. managerId is who they report to: Alex -> Jamie -> Ryan. */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    title: text("title"),
    role: text("role", { enum: ["owner", "manager", "member"] }).notNull().default("member"),
    managerId: integer("manager_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    passwordHash: text("password_hash"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_name_lower").on(sql`lower(${t.name})`)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    details: text("details"),
    status: text("status", { enum: ["todo", "in_progress", "review", "done"] }).notNull().default("todo"),
    priority: text("priority", { enum: ["high", "medium", "low"] }).notNull().default("medium"),
    /** Free-text name, kept for agents and old rows. assigneeId is the real link. */
    assignee: text("assignee"),
    assigneeId: integer("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Who created or last delegated it. */
    createdById: integer("created_by_id").references(() => users.id, { onDelete: "set null" }),
    dueDate: date("due_date"),
    source: text("source", { enum: ["human", "agent"] }).notNull().default("human"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_client").on(t.clientId), index("tasks_status").on(t.status), index("tasks_assignee").on(t.assigneeId)],
);

export const healthChecks = pgTable(
  "health_checks",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    weekOf: date("week_of").notNull(), // Monday
    status: text("status", { enum: ["green", "yellow", "red"] }).notNull(),
    cpl: money("cpl"),
    leads: integer("leads"),
    spend: money("spend"),
    issue: text("issue"),
    reason: text("reason"),
    actionNeeded: text("action_needed"),
    resolved: boolean("resolved").notNull().default(false),
    source: text("source").notNull().default("agent"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("health_client_week").on(t.clientId, t.weekOf)],
);

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["weekly", "monthly"] }).notNull(),
  period: text("period").notNull(), // e.g. "2026-11-03" (week start) or "2026-11"
  body: text("body").notNull(),
  leads: integer("leads"),
  spend: money("spend"),
  cpl: money("cpl"),
  status: text("status", { enum: ["draft", "sent"] }).notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  agent: text("agent").notNull(),
  trigger: text("trigger", { enum: ["cron", "manual", "webhook", "cli"] }).notNull(),
  sopId: integer("sop_id"),
  clientId: integer("client_id"),
  startedById: integer("started_by_id"),
  dryRun: boolean("dry_run").notNull().default(false),
  instruction: text("instruction"),
  status: text("status", { enum: ["running", "completed", "stopped", "error"] }).notNull().default("running"),
  summary: text("summary"),
  toolCalls: integer("tool_calls").notNull().default(0),
  proposed: integer("proposed").notNull().default(0),
  blocked: integer("blocked").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  events: jsonb("events").$type<ToolEvent[]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const approvals = pgTable(
  "approvals",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    agent: text("agent").notNull(),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    status: text("status", { enum: ["pending", "approved", "rejected", "executed", "failed"] }).notNull().default("pending"),
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("approvals_status").on(t.status)],
);

/** SOP library (Skool-style lessons) that an agent can also run on a schedule. */
export const sops = pgTable(
  "sops",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    category: text("category").notNull().default("General"),
    summary: text("summary"),
    videoUrl: text("video_url"),
    /** Raw SOP text: pasted notes, transcript, or text pulled from an uploaded file. */
    body: text("body"),
    /** Clean step-by-step breakdown (markdown), written by Claude or by hand. */
    breakdown: text("breakdown"),
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    fileName: text("file_name"),
    fileType: text("file_type"),
    fileData: text("file_data"), // base64
    position: integer("position").notNull().default(0),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
    // Automation: an agent follows this SOP on a schedule
    agentEnabled: boolean("agent_enabled").notNull().default(false),
    schedule: text("schedule", { enum: ["manual", "daily", "weekdays", "weekly", "monthly"] }).notNull().default("manual"),
    weekday: integer("weekday"), // 1 = Monday ... 7 = Sunday
    monthDay: integer("month_day"), // 1-28
    perClient: boolean("per_client").notNull().default(false),
    autonomy: text("autonomy", { enum: ["L0", "L1", "L2", "L3"] }).notNull().default("L1"),
    toolkits: jsonb("toolkits").$type<string[]>().notNull().default([]),
    lastRunDate: date("last_run_date"),
    archived: boolean("archived").notNull().default(false),
    createdById: integer("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sops_category").on(t.category)],
);

/** Who has completed which SOP lesson. */
export const sopProgress = pgTable(
  "sop_progress",
  {
    id: serial("id").primaryKey(),
    sopId: integer("sop_id").notNull().references(() => sops.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sop_progress_user_sop").on(t.userId, t.sopId)],
);

/** Everything that happens in the OS, by people and agents. */
export const activity = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
    actor: text("actor").notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(), // e.g. task.created, agent.tool, sop.updated
    summary: text("summary").notNull(),
    entity: text("entity"),
    entityId: integer("entity_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
  },
  (t) => [index("activity_at").on(t.at), index("activity_actor").on(t.actor)],
);

export const eodReports = pgTable(
  "eod_reports",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    done: text("done").notNull(),
    blockers: text("blockers"),
    tomorrow: text("tomorrow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eod_user_date").on(t.userId, t.date)],
);

export const voiceNotes = pgTable("voice_notes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  transcript: text("transcript").notNull(),
  durationSec: integer("duration_sec"),
  status: text("status", { enum: ["processing", "done", "error"] }).notNull().default("processing"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Written updates from agents: morning briefs, business updates from voice notes. */
export const briefings = pgTable(
  "briefings",
  {
    id: serial("id").primaryKey(),
    kind: text("kind", { enum: ["morning", "voice_update", "other"] }).notNull(),
    forUserId: integer("for_user_id").references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    runId: integer("run_id"),
    voiceNoteId: integer("voice_note_id").references(() => voiceNotes.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("briefings_for").on(t.forUserId, t.createdAt)],
);

export interface ToolEvent {
  tool: string;
  input: unknown;
  outcome: "ran" | "proposed" | "blocked" | "error";
  note?: string;
  result?: string;
}

export type Client = typeof clients.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type HealthCheck = typeof healthChecks.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type User = typeof users.$inferSelect;
export type Sop = typeof sops.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type EodReport = typeof eodReports.$inferSelect;
export type VoiceNote = typeof voiceNotes.$inferSelect;
export type Briefing = typeof briefings.$inferSelect;

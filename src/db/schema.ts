import {
  pgTable, serial, text, integer, numeric, date, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";

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
  /** Google Drive folder ID; month-end PDFs are uploaded here when Composio is connected. */
  driveFolderId: text("drive_folder_id"),
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

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    details: text("details"),
    status: text("status", { enum: ["todo", "in_progress", "review", "done"] }).notNull().default("todo"),
    priority: text("priority", { enum: ["high", "medium", "low"] }).notNull().default("medium"),
    assignee: text("assignee"),
    dueDate: date("due_date"),
    source: text("source", { enum: ["human", "agent"] }).notNull().default("human"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_client").on(t.clientId), index("tasks_status").on(t.status)],
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

export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["weekly", "monthly"] }).notNull(),
    period: text("period").notNull(), // e.g. "2026-11-03" (week start) or "2026-11"
    /** First and last day covered (weekly: Monday–Sunday; monthly: calendar month). */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    body: text("body").notNull(),
    // Numbers (BLUEPRINT.md section 5), so month-end and health trends compute from data.
    leads: integer("leads"),
    spend: money("spend"),
    cpl: money("cpl"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    /** Click-through rate in percent (clicks / impressions * 100). */
    ctr: numeric("ctr", { precision: 7, scale: 2, mode: "number" }),
    status: text("status", { enum: ["draft", "sent"] }).notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** Month-end PDF in the client's Drive folder (when uploaded). */
    driveFileId: text("drive_file_id"),
    driveUrl: text("drive_url"),
    driveError: text("drive_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reports_client_kind_period").on(t.clientId, t.kind, t.period)],
);

/**
 * One row per client per report run (weekly or month-end). The cron enqueues these and fans
 * out one function call per row, so one slow account can't time out the rest.
 */
export const reportJobs = pgTable(
  "report_jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind", { enum: ["weekly", "monthly"] }).notNull(),
    period: text("period").notNull(), // same format as reports.period
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["queued", "running", "done", "failed", "skipped"] }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    reportId: integer("report_id").references(() => reports.id, { onDelete: "set null" }),
    /** While running: after this time the attempt is treated as dead (function timed out). */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("report_jobs_kind_period_client").on(t.kind, t.period, t.clientId), index("report_jobs_status").on(t.status)],
);

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  agent: text("agent").notNull(),
  trigger: text("trigger", { enum: ["cron", "manual", "webhook", "cli"] }).notNull(),
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
export type ReportJob = typeof reportJobs.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Approval = typeof approvals.$inferSelect;

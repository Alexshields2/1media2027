import {
  pgTable, serial, text, integer, bigint, numeric, date, timestamp, boolean, jsonb, uniqueIndex, index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });

// ---------- people ----------

/** One row per person who can sign in. Roles: owner (everything) or team (no payments or money). */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(), // stored lower-case
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "team"] }).notNull().default("team"),
    active: boolean("active").notNull().default(true),
    // scrypt hash (see src/lib/password.ts). Null = no password yet (e.g. magic-link-only later).
    passwordHash: text("password_hash"),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email").on(t.email)],
);

/** Server-side sessions. The cookie holds the id plus an HMAC; deleting or revoking the row signs the person out. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    method: text("method", { enum: ["password", "admin_password", "magic_link"] }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/** Who did what: sign-ins (and failures, used for rate limiting), approvals, payments, client and user edits. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(), // e.g. "auth.sign_in", "approval.approve", "payment.record"
    target: text("target"), // e.g. "approval:12", "client:3", or an email for sign-in attempts
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_action_time").on(t.action, t.createdAt), index("audit_time").on(t.createdAt)],
);

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
  // Notion pages this client was imported from (Client Portals, Monthly Reports, Sales CRM). Keeps re-imports idempotent.
  notionIds: text("notion_ids").array().notNull().default([]),
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
    notionPageId: text("notion_page_id"), // Payment Collection row this was imported from
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payments_client_period_label").on(t.clientId, t.period, t.label), uniqueIndex("payments_notion_page").on(t.notionPageId)],
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
    /** Per-signal results from the scoring rules (src/lib/health-score.ts). Empty for manual rows. */
    signals: jsonb("signals").$type<HealthSignalRow[]>().notNull().default([]),
    /** The raw numbers the score was computed from (Meta, GHL, history). */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
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

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    agent: text("agent").notNull(),
    trigger: text("trigger", { enum: ["cron", "manual", "webhook", "cli"] }).notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    instruction: text("instruction"),
    status: text("status", { enum: ["running", "completed", "stopped", "error"] }).notNull().default("running"),
    summary: text("summary"),
    /** Why the run failed (status "error"), kept apart from the summary so the UI can show it on its own. */
    error: text("error"),
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
  },
  (t) => [index("agent_runs_agent_started").on(t.agent, t.startedAt), index("agent_runs_status_started").on(t.status, t.startedAt)],
);

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
    decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("approvals_status").on(t.status)],
);

/**
 * Money that arrived (a Stripe invoice payment or a bank credit from a CSV upload), before and after
 * it is matched to payment rows. Stripe payments matched by customer are applied automatically;
 * bank credits only ever get suggestions, and the owner confirms them on the Payments page.
 */
export const incomingPayments = pgTable(
  "incoming_payments",
  {
    id: serial("id").primaryKey(),
    source: text("source", { enum: ["stripe", "bank"] }).notNull(),
    /** Dedupe key: Stripe "<invoice id>@<cumulative cents>", bank transaction ID or a row hash. */
    externalId: text("external_id").notNull(),
    receivedDate: date("received_date").notNull(),
    amount: money("amount").notNull(),
    /** How much of amount has been applied to payment rows. */
    allocated: money("allocated").notNull().default(0),
    currency: text("currency").notNull().default("EUR"),
    payer: text("payer"),
    reference: text("reference"),
    description: text("description"),
    bankFormat: text("bank_format"),
    sourceFile: text("source_file"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    status: text("status", { enum: ["unmatched", "matched", "ignored"] }).notNull().default("unmatched"),
    matchedBy: text("matched_by", { enum: ["stripe-customer", "amount-period", "owner"] }),
    allocations: jsonb("allocations").$type<Allocation[]>().notNull().default([]),
    suggestions: jsonb("suggestions").$type<MatchSuggestion[]>().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("incoming_source_external").on(t.source, t.externalId),
    index("incoming_status").on(t.status),
    index("incoming_stripe_invoice").on(t.stripeInvoiceId),
  ],
);

/** Every Stripe webhook event we have handled, so retries are no-ops. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(), // evt_...
  type: text("type").notNull(),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The finance agent's weekly cash summary (also posted to Slack when configured). */
export const cashSummaries = pgTable("cash_summaries", {
  id: serial("id").primaryKey(),
  asOf: date("as_of").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  postedToSlack: boolean("posted_to_slack").notNull().default(false),
  runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface Allocation {
  paymentId: number;
  amount: number;
}

export interface MatchSuggestion {
  paymentId: number;
  score: number;
  reasons: string[];
}

/** Briefs written by agents for a client: call prep before a call, inbox notes. Shown on the client page. */
export const briefs = pgTable(
  "briefs",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["call_prep", "inbox"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Every recent lead by name (call prep). */
    leads: jsonb("leads").$type<BriefLead[]>().notNull().default([]),
    callAt: timestamp("call_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("briefs_client").on(t.clientId, t.createdAt)],
);

// ---------- files (Drive-style storage; the bytes live in Supabase Storage) ----------

/** Folders nest like Google Drive. A folder can belong to a client; everything inside it does too. */
export const fileFolders = pgTable(
  "file_folders",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    parentId: integer("parent_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "cascade" }),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_folders_parent").on(t.parentId), index("file_folders_client").on(t.clientId)],
);

/** One row per stored file. storagePath never changes, so renaming or moving is a database update only. */
export const files = pgTable(
  "files",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    folderId: integer("folder_id").references(() => fileFolders.id, { onDelete: "cascade" }),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("files_storage_path").on(t.storagePath), index("files_folder").on(t.folderId), index("files_client").on(t.clientId)],
);

export interface HealthSignalRow {
  key: string;
  label: string;
  status: "green" | "yellow" | "red" | "unknown";
  detail: string;
}

export interface BriefLead {
  name: string;
  stage?: string;
  createdAt?: string;
  lastContactAt?: string;
  daysSinceContact?: number;
  untouched?: boolean;
  source?: string;
  note?: string;
}

export interface ToolEvent {
  /** The model's tool_use id (runs from before Nov 2026 don't have it). */
  id?: string;
  tool: string;
  input: unknown;
  outcome: "ran" | "proposed" | "blocked" | "error";
  note?: string;
  result?: string;
  /** Model turn the call came from, starting at 1. */
  turn?: number;
  /** ISO time the call started, and how long it took. */
  at?: string;
  ms?: number;
}

export type Client = typeof clients.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type HealthCheck = typeof healthChecks.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type ReportJob = typeof reportJobs.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type IncomingPayment = typeof incomingPayments.$inferSelect;
export type CashSummary = typeof cashSummaries.$inferSelect;
export type Brief = typeof briefs.$inferSelect;
export type FileFolder = typeof fileFolders.$inferSelect;
export type StoredFile = typeof files.$inferSelect;

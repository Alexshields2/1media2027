import {
  pgTable, serial, text, integer, numeric, date, timestamp, boolean, jsonb, uniqueIndex, index,
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
    decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
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
export type AgentRun = typeof agentRuns.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;

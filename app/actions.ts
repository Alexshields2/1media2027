"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { User } from "@/db/schema";
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from "@/lib/auth";
import { allUsers, isManager, requireUser } from "@/lib/session";
import { checkPassword, hashPassword } from "@/lib/passwords";
import { canAssign, canSee, upline, wouldLoop } from "@/lib/team";
import { logActivity, asUser } from "@/lib/activity";
import { generateMonth, recordPayment } from "@/lib/billing";
import { executeApproval, rejectApproval, describeAction } from "@/lib/approvals";
import { runAgent } from "@/lib/runner";
import { AGENTS } from "@/agents/registry";
import { sopAgent } from "@/agents/sop-agent";
import { breakdownSop } from "@/lib/sop-ai";
import { parseSteps } from "@/lib/sops";
import { today, weekStart } from "@/lib/dates";

// ---------- helpers ----------

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === null ? null : Number(v.replace(/[€$,\s]/g, ""));
};
const intOrNull = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === null || !/^\d+$/.test(v) ? null : Number(v);
};
const userName = (users: User[], id: number | null | undefined) => users.find((u) => u.id === id)?.name ?? "nobody";

async function requireManager(): Promise<User> {
  const me = await requireUser();
  if (!isManager(me)) throw new Error("Only Alex or a manager can do that.");
  return me;
}

async function requireOwner(): Promise<User> {
  const me = await requireUser();
  if (me.role !== "owner") throw new Error("Only the owner can do that.");
  return me;
}

// ---------- auth ----------

export async function login(_: unknown, form: FormData): Promise<{ error?: string }> {
  const name = (str(form, "name") ?? "").toLowerCase();
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  if (!password) return { error: "Enter your password." };

  let user: User | undefined;
  try {
    const users = await allUsers();
    const match = name ? users.find((u) => u.active && (u.name.toLowerCase() === name || u.email?.toLowerCase() === name || u.name.toLowerCase().split(" ")[0] === name)) : undefined;
    if (match && (await checkPassword(password, match.passwordHash))) {
      user = match;
    } else if (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
      // The admin password always signs in as the owner (and is how Alex gets in the first time).
      const owner = match?.role === "owner" ? match : users.find((u) => u.role === "owner" && u.active);
      if (owner && (!name || match?.id === owner.id)) user = owner;
      else if (!owner) {
        [user] = await db.insert(schema.users).values({ name: process.env.OWNER_NAME || "Alex", role: "owner" }).returning();
      }
    }
  } catch (err) {
    return { error: `The database isn't reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!user) return { error: "Wrong name or password." };

  const token = await signSession(user.id);
  if (!token) return { error: "The server has no AUTH_SECRET or database configured." };
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  await logActivity(asUser(user), { action: "auth.login", summary: `${user.name} signed in` });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------- team ----------

const ROLES = ["owner", "manager", "member"] as const;

export async function addTeamMember(form: FormData) {
  const me = await requireOwner();
  const name = str(form, "name");
  if (!name) throw new Error("Name is required");
  const password = str(form, "password");
  const [u] = await db
    .insert(schema.users)
    .values({
      name,
      email: str(form, "email"),
      title: str(form, "title"),
      role: z.enum(ROLES).catch("member").parse(str(form, "role")),
      managerId: intOrNull(form, "managerId") ?? me.id,
      passwordHash: password ? await hashPassword(password) : null,
    })
    .returning();
  await logActivity(asUser(me), { action: "team.added", summary: `Added ${u.name} to the team`, entity: "user", entityId: u.id });
  revalidatePath("/team");
}

export async function updateTeamMember(id: number, form: FormData) {
  const me = await requireOwner();
  const users = await allUsers();
  const managerId = intOrNull(form, "managerId");
  if (wouldLoop(users, id, managerId)) throw new Error("That would make someone report to themselves.");
  const role = z.enum(ROLES).catch("member").parse(str(form, "role"));
  const owners = users.filter((u) => u.role === "owner" && u.active && u.id !== id);
  const active = form.get("active") === "on";
  if ((role !== "owner" || !active) && !owners.length) throw new Error("There must always be one active owner.");
  const name = str(form, "name");
  await db
    .update(schema.users)
    .set({ name: name ?? undefined, email: str(form, "email"), title: str(form, "title"), role, managerId, active })
    .where(eq(schema.users.id, id));
  const before = users.find((u) => u.id === id);
  await logActivity(asUser(me), {
    action: "team.updated",
    summary: `Updated ${name ?? before?.name}: ${role}, reports to ${userName(users, managerId)}${active ? "" : ", deactivated"}`,
    entity: "user",
    entityId: id,
  });
  revalidatePath("/team");
}

export async function setPassword(id: number, form: FormData) {
  const me = await requireUser();
  if (me.id !== id && me.role !== "owner") throw new Error("You can only change your own password.");
  const password = str(form, "password");
  if (!password || password.length < 8) throw new Error("Use at least 8 characters.");
  if (me.id === id && me.passwordHash && me.role !== "owner") {
    if (!(await checkPassword(str(form, "current") ?? "", me.passwordHash))) throw new Error("Current password is wrong.");
  }
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, id));
  const users = await allUsers();
  await logActivity(asUser(me), { action: "team.password", summary: me.id === id ? "Changed their password" : `Set a password for ${userName(users, id)}`, entity: "user", entityId: id });
  revalidatePath("/team");
}

// ---------- clients ----------

const clientFields = (f: FormData) => ({
  name: str(f, "name") ?? "",
  status: (str(f, "status") ?? "active") as "onboarding" | "active" | "paused" | "churned",
  contactName: str(f, "contactName"),
  email: str(f, "email"),
  phone: str(f, "phone"),
  website: str(f, "website"),
  industry: str(f, "industry"),
  retainerExVat: num(f, "retainerExVat") ?? 0,
  vat: (str(f, "vat") ?? "plus") as "plus" | "inc" | "none",
  billingMethod: (str(f, "billingMethod") ?? "invoice") as "stripe" | "invoice" | "revolut" | "aib" | "cash",
  startDate: str(f, "startDate"),
  metaAdAccountIds: str(f, "metaAdAccountIds"),
  ghlLocationId: str(f, "ghlLocationId"),
  stripeCustomerId: str(f, "stripeCustomerId"),
  cplTarget: num(f, "cplTarget"),
  reportCurrency: (str(f, "reportCurrency") ?? "EUR") as "EUR" | "USD",
  reportGreeting: str(f, "reportGreeting") ?? "Hi guys",
  reportRules: str(f, "reportRules"),
  goals: str(f, "goals"),
  notes: str(f, "notes"),
});

export async function createClient(form: FormData) {
  const me = await requireUser();
  const values = clientFields(form);
  if (!values.name) throw new Error("Name is required");
  const [c] = await db.insert(schema.clients).values(values).returning({ id: schema.clients.id });
  await logActivity(asUser(me), { action: "client.created", summary: `Added client ${values.name}`, entity: "client", entityId: c.id });
  revalidatePath("/clients");
  redirect(`/clients/${c.id}`);
}

export async function updateClient(id: number, form: FormData) {
  const me = await requireUser();
  const values = clientFields(form);
  if (!values.name) throw new Error("Name is required");
  await db.update(schema.clients).set(values).where(eq(schema.clients.id, id));
  await logActivity(asUser(me), { action: "client.updated", summary: `Updated client ${values.name}`, entity: "client", entityId: id });
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

// ---------- payments ----------

export async function generateMonthAction(form: FormData) {
  const me = await requireUser();
  const month = str(form, "month") ?? today().slice(0, 7);
  const created = await generateMonth(`${month}-01`);
  await logActivity(asUser(me), { action: "payments.generated", summary: `Generated ${created} retainer row(s) for ${month}` });
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function recordPaymentAction(form: FormData) {
  const me = await requireUser();
  const id = z.coerce.number().parse(form.get("paymentId"));
  const amount = num(form, "amount");
  if (amount === null || Number.isNaN(amount)) throw new Error("Amount is required");
  await recordPayment(id, {
    amount,
    paidDate: str(form, "paidDate") ?? today(),
    method: (str(form, "method") ?? undefined) as "stripe" | "invoice" | "revolut" | "aib" | "cash" | undefined,
    note: str(form, "note") ?? undefined,
  });
  const [p] = await db
    .select({ client: schema.clients.name, period: schema.payments.period })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(eq(schema.payments.id, id));
  await logActivity(asUser(me), { action: "payment.recorded", summary: `Recorded €${amount} collected from ${p?.client ?? "client"} for ${p?.period?.slice(0, 7) ?? ""}`, entity: "payment", entityId: id });
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function addPaymentAction(form: FormData) {
  const me = await requireUser();
  const clientId = z.coerce.number().parse(form.get("clientId"));
  const month = str(form, "month") ?? today().slice(0, 7);
  const amountDue = num(form, "amountDue");
  if (!amountDue) throw new Error("Amount is required");
  const label = str(form, "label") ?? "One-off";
  await db
    .insert(schema.payments)
    .values({ clientId, label, period: `${month}-01`, amountDue, dueDate: str(form, "dueDate") ?? `${month}-01` })
    .onConflictDoNothing();
  await logActivity(asUser(me), { action: "payment.added", summary: `Added ${label} payment of €${amountDue} for ${month}`, entity: "client", entityId: clientId });
  revalidatePath("/payments");
}

// ---------- tasks ----------

const PRIORITIES = ["high", "medium", "low"] as const;
const STATUSES = ["todo", "in_progress", "review", "done"] as const;

/** Checks the assignee is someone `me` may hand work to. Returns the id (or null for unassigned). */
function checkAssignee(users: User[], me: User, assigneeId: number | null): number | null {
  if (assigneeId === null) return null;
  if (!users.some((u) => u.id === assigneeId && u.active)) throw new Error("Unknown team member.");
  if (!canAssign(users, me.id, assigneeId)) throw new Error("You can only assign work to yourself or people who report to you.");
  return assigneeId;
}

export async function createTask(form: FormData) {
  const me = await requireUser();
  const users = await allUsers();
  const title = str(form, "title");
  if (!title) throw new Error("Title is required");
  const clientId = intOrNull(form, "clientId");
  const assigneeId = checkAssignee(users, me, form.has("assigneeId") ? intOrNull(form, "assigneeId") : me.id);
  const [t] = await db
    .insert(schema.tasks)
    .values({
      title,
      clientId,
      details: str(form, "details"),
      priority: z.enum(PRIORITIES).catch("medium").parse(str(form, "priority")),
      dueDate: str(form, "dueDate"),
      assigneeId,
      assignee: assigneeId ? userName(users, assigneeId) : null,
      createdById: me.id,
    })
    .returning({ id: schema.tasks.id });
  await logActivity(asUser(me), {
    action: assigneeId && assigneeId !== me.id ? "task.delegated" : "task.created",
    summary: assigneeId && assigneeId !== me.id ? `Delegated "${title}" to ${userName(users, assigneeId)}` : `Created task "${title}"`,
    entity: "task",
    entityId: t.id,
  });
  revalidatePath("/tasks");
  revalidatePath("/");
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

export async function updateTask(id: number, form: FormData) {
  const me = await requireUser();
  const users = await allUsers();
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!t) throw new Error("Task not found");
  const assigneeId = intOrNull(form, "assigneeId");
  const reassigned = assigneeId !== t.assigneeId;
  if (reassigned) checkAssignee(users, me, assigneeId);
  const title = str(form, "title") ?? t.title;
  const status = z.enum(STATUSES).catch(t.status).parse(str(form, "status"));
  await db
    .update(schema.tasks)
    .set({
      title,
      details: str(form, "details"),
      clientId: intOrNull(form, "clientId"),
      priority: z.enum(PRIORITIES).catch(t.priority).parse(str(form, "priority")),
      dueDate: str(form, "dueDate"),
      status,
      completedAt: status === "done" ? (t.completedAt ?? new Date()) : null,
      ...(reassigned ? { assigneeId, assignee: assigneeId ? userName(users, assigneeId) : null, createdById: me.id } : {}),
    })
    .where(eq(schema.tasks.id, id));
  await logActivity(asUser(me), {
    action: reassigned ? "task.delegated" : "task.updated",
    summary: reassigned ? `Delegated "${title}" to ${userName(users, assigneeId)}` : `Updated task "${title}"`,
    entity: "task",
    entityId: id,
  });
  revalidatePath("/tasks");
  revalidatePath("/");
}

export async function setTaskStatus(id: number, status: (typeof STATUSES)[number]) {
  const me = await requireUser();
  const [t] = await db
    .update(schema.tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(eq(schema.tasks.id, id))
    .returning({ title: schema.tasks.title });
  const label = { todo: "reopened", in_progress: "started", review: "sent to review", done: "completed" }[status];
  await logActivity(asUser(me), { action: `task.${status}`, summary: `${label[0].toUpperCase()}${label.slice(1)} "${t?.title ?? id}"`, entity: "task", entityId: id });
  revalidatePath("/tasks");
  revalidatePath("/");
}

export async function deleteTask(id: number) {
  const me = await requireUser();
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!t) return;
  if (!isManager(me) && t.createdById !== me.id) throw new Error("Only the person who created it, or a manager, can delete a task.");
  await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
  await logActivity(asUser(me), { action: "task.deleted", summary: `Deleted task "${t.title}"`, entity: "task", entityId: id });
  revalidatePath("/tasks");
  revalidatePath("/");
}

// ---------- health ----------

export async function saveHealthAction(form: FormData) {
  const me = await requireUser();
  const clientId = z.coerce.number().parse(form.get("clientId"));
  const values = {
    clientId,
    weekOf: weekStart(),
    status: (str(form, "status") ?? "green") as "green" | "yellow" | "red",
    cpl: num(form, "cpl"),
    issue: str(form, "issue"),
    reason: str(form, "reason"),
    actionNeeded: str(form, "actionNeeded"),
    source: "manual",
    updatedAt: new Date(),
  };
  await db.insert(schema.healthChecks).values(values).onConflictDoUpdate({ target: [schema.healthChecks.clientId, schema.healthChecks.weekOf], set: values });
  const [c] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId));
  await logActivity(asUser(me), { action: "health.saved", summary: `Set ${c?.name ?? "client"} to ${values.status}${values.issue ? `: ${values.issue}` : ""}`, entity: "client", entityId: clientId });
  revalidatePath("/health");
  revalidatePath("/");
}

export async function resolveHealth(id: number) {
  const me = await requireUser();
  await db.update(schema.healthChecks).set({ resolved: true }).where(eq(schema.healthChecks.id, id));
  await logActivity(asUser(me), { action: "health.resolved", summary: `Resolved a client health flag`, entity: "health", entityId: id });
  revalidatePath("/health");
  revalidatePath("/");
}

// ---------- reports ----------

export async function setReportStatus(id: number, status: "draft" | "sent") {
  const me = await requireUser();
  await db.update(schema.reports).set({ status }).where(eq(schema.reports.id, id));
  await logActivity(asUser(me), { action: `report.${status}`, summary: status === "sent" ? "Marked a report as sent" : "Moved a report back to draft", entity: "report", entityId: id });
  revalidatePath("/reports");
}

export async function updateReportBody(id: number, form: FormData) {
  const me = await requireUser();
  const body = str(form, "body");
  if (!body) return;
  await db.update(schema.reports).set({ body }).where(eq(schema.reports.id, id));
  await logActivity(asUser(me), { action: "report.edited", summary: "Edited a report draft", entity: "report", entityId: id });
  revalidatePath("/reports");
}

// ---------- approvals ----------

export async function approve(id: number) {
  const me = await requireManager();
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id));
  const res = await executeApproval(id);
  await logActivity(asUser(me), {
    action: res.ok ? "approval.approved" : "approval.failed",
    summary: `${res.ok ? "Approved" : "Approved but it failed"}: ${a ? describeAction(a.tool, a.input) : id}${res.ok ? "" : ` (${res.result.slice(0, 200)})`}`,
    entity: "approval",
    entityId: id,
  });
  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function reject(id: number) {
  const me = await requireManager();
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id));
  await rejectApproval(id);
  await logActivity(asUser(me), { action: "approval.rejected", summary: `Rejected: ${a ? describeAction(a.tool, a.input) : id}`, entity: "approval", entityId: id });
  revalidatePath("/approvals");
  revalidatePath("/");
}

// ---------- agents ----------

export async function runAgentAction(form: FormData) {
  const me = await requireUser();
  const agent = AGENTS[str(form, "agent") ?? ""];
  if (!agent || agent.hidden) throw new Error("Unknown agent");
  const instruction = str(form, "instruction") ?? undefined;
  if (agent.needsInstruction && !instruction) throw new Error("This agent needs an instruction.");
  const dryRun = form.get("dryRun") === "on";
  // Respond straight away; the run continues in the background and shows up under Recent runs.
  after(() => runAgent(agent, { dryRun, instruction, trigger: "manual", startedBy: me }).catch((e) => console.error(e)));
  revalidatePath("/agents");
  redirect("/agents?started=" + agent.name);
}

// ---------- SOP library ----------

const MAX_FILE = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const TOOLKIT_OPTIONS = ["gmail", "googlecalendar", "googledrive", "googlesheets", "googledocs", "metaads", "facebook", "highlevel", "stripe", "slack"];

async function sopFields(form: FormData) {
  const file = form.get("file");
  let fileFields: { fileName: string; fileType: string; fileData: string } | null = null;
  let fileText: string | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE) throw new Error("File is over 4 MB. Upload a smaller PDF, or paste the text.");
    const buf = Buffer.from(await file.arrayBuffer());
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      fileFields = { fileName: file.name, fileType: "application/pdf", fileData: buf.toString("base64") };
    } else if (/\.(txt|md|markdown|csv|html?)$/i.test(file.name) || file.type.startsWith("text/")) {
      fileText = buf.toString("utf8");
      fileFields = { fileName: file.name, fileType: file.type || "text/plain", fileData: buf.toString("base64") };
    } else {
      throw new Error("Upload a PDF, .txt or .md file. For Word or Google Docs, save as PDF first.");
    }
  }
  const body = [str(form, "body"), fileText].filter(Boolean).join("\n\n") || null;
  const schedule = z.enum(["manual", "daily", "weekdays", "weekly", "monthly"]).catch("manual").parse(str(form, "schedule"));
  return {
    values: {
      title: str(form, "title") ?? "",
      category: str(form, "category") ?? "General",
      summary: str(form, "summary"),
      videoUrl: str(form, "videoUrl"),
      body,
      breakdown: str(form, "breakdown"),
      steps: parseSteps(str(form, "steps")),
      ownerId: intOrNull(form, "ownerId"),
      agentEnabled: form.get("agentEnabled") === "on",
      schedule,
      weekday: Math.min(7, Math.max(1, intOrNull(form, "weekday") ?? 1)),
      monthDay: Math.min(28, Math.max(1, intOrNull(form, "monthDay") ?? 1)),
      perClient: form.get("perClient") === "on",
      autonomy: z.enum(["L0", "L1", "L2", "L3"]).catch("L1").parse(str(form, "autonomy")),
      toolkits: form.getAll("toolkits").filter((t): t is string => typeof t === "string" && TOOLKIT_OPTIONS.includes(t)),
      updatedAt: new Date(),
    },
    file: fileFields,
  };
}

export async function createSop(form: FormData) {
  const me = await requireUser();
  const { values, file } = await sopFields(form);
  if (!values.title) throw new Error("Title is required");
  if (values.autonomy === "L3" && me.role !== "owner") throw new Error("Only the owner can give an SOP agent full autonomy.");
  const [s] = await db
    .insert(schema.sops)
    .values({ ...values, ...(file ?? {}), createdById: me.id })
    .returning({ id: schema.sops.id });
  await logActivity(asUser(me), { action: "sop.created", summary: `Added SOP "${values.title}" to ${values.category}`, entity: "sop", entityId: s.id });
  if (form.get("autoBreakdown") === "on" && process.env.ANTHROPIC_API_KEY) {
    after(() => generateBreakdownFor(s.id, me).catch((e) => console.error(e)));
  }
  revalidatePath("/sops");
  redirect(`/sops/${s.id}`);
}

export async function updateSop(id: number, form: FormData) {
  const me = await requireUser();
  const { values, file } = await sopFields(form);
  if (!values.title) throw new Error("Title is required");
  const [before] = await db.select({ autonomy: schema.sops.autonomy }).from(schema.sops).where(eq(schema.sops.id, id));
  if (values.autonomy === "L3" && before?.autonomy !== "L3" && me.role !== "owner") throw new Error("Only the owner can give an SOP agent full autonomy.");
  if (form.get("removeFile") === "on") Object.assign(values, { fileName: null, fileType: null, fileData: null });
  await db.update(schema.sops).set({ ...values, ...(file ?? {}) }).where(eq(schema.sops.id, id));
  await logActivity(asUser(me), { action: "sop.updated", summary: `Updated SOP "${values.title}"`, entity: "sop", entityId: id });
  revalidatePath("/sops");
  revalidatePath(`/sops/${id}`);
  redirect(`/sops/${id}`);
}

export async function archiveSop(id: number, archived: boolean) {
  const me = await requireUser();
  const [s] = await db.update(schema.sops).set({ archived, updatedAt: new Date() }).where(eq(schema.sops.id, id)).returning({ title: schema.sops.title });
  await logActivity(asUser(me), { action: archived ? "sop.archived" : "sop.restored", summary: `${archived ? "Archived" : "Restored"} SOP "${s?.title}"`, entity: "sop", entityId: id });
  revalidatePath("/sops");
  revalidatePath(`/sops/${id}`);
}

async function generateBreakdownFor(id: number, me: User) {
  const [s] = await db.select().from(schema.sops).where(eq(schema.sops.id, id));
  if (!s) throw new Error("SOP not found");
  const out = await breakdownSop({
    title: s.title,
    body: s.body,
    videoUrl: s.videoUrl,
    file: s.fileType === "application/pdf" && s.fileData ? { name: s.fileName ?? "sop.pdf", type: s.fileType, data: s.fileData } : null,
  });
  await db
    .update(schema.sops)
    .set({ breakdown: out.breakdown, steps: out.steps, summary: s.summary || out.summary, updatedAt: new Date() })
    .where(eq(schema.sops.id, id));
  await logActivity(asUser(me), { action: "sop.breakdown", summary: `Wrote a clean breakdown for SOP "${s.title}" with Claude`, entity: "sop", entityId: id });
}

export async function generateBreakdown(id: number, _prev?: unknown): Promise<{ error?: string; ok?: boolean }> {
  const me = await requireUser();
  try {
    await generateBreakdownFor(id, me);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath(`/sops/${id}`);
  return { ok: true };
}

export async function toggleSopDone(id: number) {
  const me = await requireUser();
  const [existing] = await db.select().from(schema.sopProgress).where(and(eq(schema.sopProgress.sopId, id), eq(schema.sopProgress.userId, me.id)));
  const [s] = await db.select({ title: schema.sops.title }).from(schema.sops).where(eq(schema.sops.id, id));
  if (existing) {
    await db.delete(schema.sopProgress).where(eq(schema.sopProgress.id, existing.id));
  } else {
    await db.insert(schema.sopProgress).values({ sopId: id, userId: me.id }).onConflictDoNothing();
    await logActivity(asUser(me), { action: "sop.completed", summary: `Completed SOP lesson "${s?.title}"`, entity: "sop", entityId: id });
  }
  revalidatePath(`/sops/${id}`);
  revalidatePath("/sops");
}

export async function runSopNow(id: number, form: FormData) {
  const me = await requireUser();
  const [s] = await db.select().from(schema.sops).where(eq(schema.sops.id, id));
  if (!s) throw new Error("SOP not found");
  const dryRun = form.get("dryRun") === "on";
  const clientId = intOrNull(form, "clientId");
  const users = await allUsers();
  const owner = users.find((u) => u.id === s.ownerId) ?? null;
  const clients = clientId
    ? await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId))
    : s.perClient
      ? await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.status, ["active", "onboarding"])).orderBy(asc(schema.clients.name))
      : [null];
  const attachments = sopAttachments(s);
  after(async () => {
    for (const client of clients) {
      await runAgent(sopAgent(s, { owner, client }), { dryRun, trigger: "manual", startedBy: me, sopId: s.id, clientId: client?.id, attachments }).catch((e) => console.error(e));
    }
  });
  redirect(`/sops/${id}?started=${clients.length}`);
}

/** The SOP's PDF, attached to the agent's first message when there's no written breakdown to follow. */
function sopAttachments(s: typeof schema.sops.$inferSelect) {
  if (s.fileType !== "application/pdf" || !s.fileData || s.breakdown) return undefined;
  return [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: s.fileData }, title: s.fileName ?? "SOP" }];
}

// ---------- end-of-day reports ----------

export async function saveEod(form: FormData) {
  const me = await requireUser();
  const done = str(form, "done");
  if (!done) throw new Error("Say what you got done today.");
  const date = str(form, "date") ?? today();
  const values = { userId: me.id, date, done, blockers: str(form, "blockers"), tomorrow: str(form, "tomorrow"), updatedAt: new Date() };
  const [r] = await db
    .insert(schema.eodReports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.eodReports.userId, schema.eodReports.date], set: values })
    .returning({ id: schema.eodReports.id, createdAt: schema.eodReports.createdAt, updatedAt: schema.eodReports.updatedAt });
  const isNew = Math.abs(r.updatedAt.getTime() - r.createdAt.getTime()) < 2000;
  await logActivity(asUser(me), { action: "eod.submitted", summary: `${isNew ? "Submitted" : "Updated"} end-of-day report for ${date}${values.blockers ? " (with blockers)" : ""}`, entity: "eod", entityId: r.id });
  revalidatePath("/eod");
  revalidatePath("/");
  redirect("/eod?saved=1");
}

// ---------- voice notes ----------

export async function submitVoiceNote(_: unknown, form: FormData): Promise<{ error?: string; ok?: boolean }> {
  const me = await requireUser();
  const transcript = str(form, "transcript");
  if (!transcript || transcript.length < 20) return { error: "The note is too short. Record or type a bit more." };
  const durationSec = intOrNull(form, "durationSec");
  const [n] = await db.insert(schema.voiceNotes).values({ userId: me.id, transcript, durationSec }).returning();
  await logActivity(asUser(me), { action: "voice.recorded", summary: `Recorded a voice note (${durationSec ? `${Math.round(durationSec / 60)} min, ` : ""}${transcript.split(/\s+/).length} words)`, entity: "voice", entityId: n.id });
  after(() => processVoiceNote(n.id, me));
  revalidatePath("/voice");
  return { ok: true };
}

export async function reprocessVoiceNote(id: number) {
  const me = await requireUser();
  const [n] = await db.select().from(schema.voiceNotes).where(eq(schema.voiceNotes.id, id));
  if (!n) return;
  const users = await allUsers();
  if (!canSee(users, me.id, n.userId)) throw new Error("Not your voice note.");
  await db.update(schema.voiceNotes).set({ status: "processing" }).where(eq(schema.voiceNotes.id, id));
  after(() => processVoiceNote(id, me));
  revalidatePath("/voice");
}

async function processVoiceNote(id: number, startedBy: User) {
  const [n] = await db.select().from(schema.voiceNotes).where(eq(schema.voiceNotes.id, id));
  if (!n) return;
  const users = await allUsers();
  const speaker = users.find((u) => u.id === n.userId);
  const forId = upline(users, n.userId)[0] ?? users.find((u) => u.role === "owner")?.id ?? n.userId;
  const instruction = [
    `Voice note id: ${n.id}`,
    `Speaker: ${speaker?.name ?? "unknown"} (user id ${n.userId})`,
    `Write the update for: ${userName(users, forId)} (for_user_id ${forId})`,
    `Recorded: ${n.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}`,
    "",
    "Transcript:",
    n.transcript,
  ].join("\n");
  const run = await runAgent(AGENTS["voice-update"], { instruction, trigger: "manual", startedBy }).catch((e) => {
    console.error(e);
    return null;
  });
  const [b] = await db.select({ id: schema.briefings.id }).from(schema.briefings).where(eq(schema.briefings.voiceNoteId, id)).limit(1);
  await db.update(schema.voiceNotes).set({ status: b ? "done" : "error" }).where(eq(schema.voiceNotes.id, id));
  if (!b && run) {
    // Keep what the agent said, so the page can show why there's no update.
    await db.insert(schema.briefings).values({ kind: "voice_update", forUserId: forId, title: `Voice note from ${speaker?.name}: not processed`, body: run.summary ?? "The agent did not finish.", voiceNoteId: id, runId: run.id });
  }
}

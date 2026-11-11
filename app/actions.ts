"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { generateMonth, recordPayment } from "@/lib/billing";
import { executeApproval, rejectApproval } from "@/lib/approvals";
import { runAgent } from "@/lib/runner";
import { AGENTS } from "@/agents/registry";
import { today, weekStart } from "@/lib/dates";
import { appOrigin, dispatchJobs, enqueueReportJobs, processJob, publishMonthEndPdf, resetJob, type JobOptions } from "@/lib/report-jobs";
import { periodFor } from "@/lib/report-metrics";

// ---------- auth ----------

export async function login(_: unknown, form: FormData): Promise<{ error?: string }> {
  const token = await sessionToken();
  if (!token) return { error: "ADMIN_PASSWORD (or the database) is not set up on the server yet." };
  if (form.get("password") !== process.env.ADMIN_PASSWORD) return { error: "Wrong password." };
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------- helpers ----------

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === null ? null : Number(v.replace(/[€$,\s]/g, ""));
};

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
  driveFolderId: str(f, "driveFolderId"),
  cplTarget: num(f, "cplTarget"),
  reportCurrency: (str(f, "reportCurrency") ?? "EUR") as "EUR" | "USD",
  reportGreeting: str(f, "reportGreeting") ?? "Hi guys",
  reportRules: str(f, "reportRules"),
  goals: str(f, "goals"),
  notes: str(f, "notes"),
});

export async function createClient(form: FormData) {
  const values = clientFields(form);
  if (!values.name) throw new Error("Name is required");
  const [c] = await db.insert(schema.clients).values(values).returning({ id: schema.clients.id });
  revalidatePath("/clients");
  redirect(`/clients/${c.id}`);
}

export async function updateClient(id: number, form: FormData) {
  const values = clientFields(form);
  if (!values.name) throw new Error("Name is required");
  await db.update(schema.clients).set(values).where(eq(schema.clients.id, id));
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

// ---------- payments ----------

export async function generateMonthAction(form: FormData) {
  const month = str(form, "month") ?? today().slice(0, 7);
  await generateMonth(`${month}-01`);
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function recordPaymentAction(form: FormData) {
  const id = z.coerce.number().parse(form.get("paymentId"));
  const amount = num(form, "amount");
  if (amount === null || Number.isNaN(amount)) throw new Error("Amount is required");
  await recordPayment(id, {
    amount,
    paidDate: str(form, "paidDate") ?? today(),
    method: (str(form, "method") ?? undefined) as "stripe" | "invoice" | "revolut" | "aib" | "cash" | undefined,
    note: str(form, "note") ?? undefined,
  });
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function addPaymentAction(form: FormData) {
  const clientId = z.coerce.number().parse(form.get("clientId"));
  const month = str(form, "month") ?? today().slice(0, 7);
  const amountDue = num(form, "amountDue");
  if (!amountDue) throw new Error("Amount is required");
  await db
    .insert(schema.payments)
    .values({ clientId, label: str(form, "label") ?? "One-off", period: `${month}-01`, amountDue, dueDate: str(form, "dueDate") ?? `${month}-01` })
    .onConflictDoNothing();
  revalidatePath("/payments");
}

// ---------- tasks ----------

export async function createTask(form: FormData) {
  const title = str(form, "title");
  if (!title) throw new Error("Title is required");
  const clientId = str(form, "clientId");
  await db.insert(schema.tasks).values({
    title,
    clientId: clientId ? Number(clientId) : null,
    details: str(form, "details"),
    priority: (str(form, "priority") ?? "medium") as "high" | "medium" | "low",
    dueDate: str(form, "dueDate"),
    assignee: str(form, "assignee"),
  });
  revalidatePath("/tasks");
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

export async function setTaskStatus(id: number, status: "todo" | "in_progress" | "review" | "done") {
  await db
    .update(schema.tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(eq(schema.tasks.id, id));
  revalidatePath("/tasks");
  revalidatePath("/");
}

// ---------- health ----------

export async function saveHealthAction(form: FormData) {
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
  revalidatePath("/health");
  revalidatePath("/");
}

export async function resolveHealth(id: number) {
  await db.update(schema.healthChecks).set({ resolved: true }).where(eq(schema.healthChecks.id, id));
  revalidatePath("/health");
  revalidatePath("/");
}

// ---------- reports ----------

export async function setReportStatus(id: number, status: "draft" | "sent") {
  await db
    .update(schema.reports)
    .set({ status, sentAt: status === "sent" ? new Date() : null })
    .where(eq(schema.reports.id, id));
  revalidatePath("/reports");
}

export async function updateReportBody(id: number, form: FormData) {
  const body = str(form, "body");
  if (!body) return;
  await db.update(schema.reports).set({ body, updatedAt: new Date() }).where(eq(schema.reports.id, id));
  revalidatePath("/reports");
}

/**
 * Starts report jobs: one worker function per job via the fan-out route. If the fan-out can't
 * be reached (no CRON_SECRET, or a protected preview), the jobs run here in the background instead.
 */
async function startJobs(ids: number[]) {
  if (!ids.length) return;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const { failed } = await dispatchJobs(appOrigin(`${proto}://${host}`), ids, "manual");
  if (failed.length) {
    const opts: JobOptions = { trigger: "manual", redispatch: async (id) => void (await processJob(id, opts)) };
    after(() => Promise.all(failed.map((id) => processJob(id, opts))).catch((e) => console.error(e)));
  }
}

export async function runReportsAction(kind: "weekly" | "monthly", period: string) {
  const { queued } = await enqueueReportJobs(kind, periodFor(kind, period));
  await startJobs(queued.map((j) => j.id));
  revalidatePath("/reports");
}

export async function retryReportJobAction(jobId: number) {
  const job = await resetJob(jobId);
  if (job) await startJobs([job.id]);
  revalidatePath("/reports");
}

export async function retryFailedReportsAction(kind: "weekly" | "monthly", period: string) {
  const jobs = await db
    .select({ id: schema.reportJobs.id })
    .from(schema.reportJobs)
    .where(and(eq(schema.reportJobs.kind, kind), eq(schema.reportJobs.period, period), eq(schema.reportJobs.status, "failed")));
  const reset = (await Promise.all(jobs.map((j) => resetJob(j.id)))).filter((j) => j !== null);
  await startJobs(reset.map((j) => j.id));
  revalidatePath("/reports");
}

/** Rebuilds the month-end PDF and saves it to the client's Drive folder again. */
export async function saveReportToDriveAction(reportId: number) {
  const [row] = await db
    .select({ r: schema.reports, c: schema.clients })
    .from(schema.reports)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.reports.clientId))
    .where(eq(schema.reports.id, reportId));
  if (row) await publishMonthEndPdf(row.r, row.c);
  revalidatePath("/reports");
}

// ---------- approvals ----------

export async function approve(id: number) {
  await executeApproval(id);
  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function reject(id: number) {
  await rejectApproval(id);
  revalidatePath("/approvals");
  revalidatePath("/");
}

// ---------- agents ----------

export async function runAgentAction(form: FormData) {
  const agent = AGENTS[str(form, "agent") ?? ""];
  if (!agent) throw new Error("Unknown agent");
  const instruction = str(form, "instruction") ?? undefined;
  if (agent.needsInstruction && !instruction) throw new Error("This agent needs an instruction.");
  const dryRun = form.get("dryRun") === "on";
  const reportKind = agent.name === "weekly-report" ? "weekly" : agent.name === "month-end-report" ? "monthly" : null;
  if (reportKind && !dryRun && !instruction) {
    // A full run writes one report per client, each in its own function (see src/lib/report-jobs.ts).
    const { period, queued } = await enqueueReportJobs(reportKind);
    await startJobs(queued.map((j) => j.id));
    redirect(`/reports?view=${reportKind === "weekly" ? "week" : "month"}&${reportKind === "weekly" ? "week" : "month"}=${period.period}`);
  }
  // Respond straight away; the run continues in the background and shows up under Recent runs.
  after(() => runAgent(agent, { dryRun, instruction, trigger: "manual" }).catch((e) => console.error(e)));
  revalidatePath("/agents");
  redirect("/agents?started=" + agent.name);
}

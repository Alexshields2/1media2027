"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { SETUP_COOKIE, signValue } from "@/lib/session-token";
import { createUser, currentBootstrapMode, hasSetupPass, signInWithPassword } from "@/lib/auth";
import { createSession, endSession, getCurrentUser, requestMeta, requirePermission, requireSignedIn } from "@/lib/session";
import { audit } from "@/lib/audit";
import { can, canDecide, canRunAgent, ForbiddenError } from "@/lib/roles";
import { passwordProblem } from "@/lib/password";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth-rules";
import { generateMonth, recordPayment } from "@/lib/billing";
import { executeApproval, rejectApproval } from "@/lib/approvals";
import { createRun, executeRun, runAgent } from "@/lib/runner";
import { AGENTS } from "@/agents/registry";
import { today, weekStart } from "@/lib/dates";
import { assignIncoming, ignoreIncoming, importBankCsv, restoreIncoming } from "@/lib/reconcile";
import { saveCashSummary } from "@/lib/finance";

// ---------- auth ----------

export async function login(_: unknown, form: FormData): Promise<{ error?: string }> {
  const email = typeof form.get("email") === "string" ? (form.get("email") as string) : "";
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  if (!password) return { error: "Enter your password." };
  let result;
  try {
    result = await signInWithPassword(email, password);
  } catch (e) {
    console.error(e);
    return { error: "Sign-in isn't available: the database or AUTH_SECRET isn't set up on the server yet." };
  }
  if (result.ok === "setup") {
    // Proves the ADMIN_PASSWORD for the next 15 minutes so /setup can create the first owner.
    const expires = Date.now() + 15 * 60 * 1000;
    (await cookies()).set(SETUP_COOKIE, await signValue(`setup:${expires}`), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 15 * 60 });
    redirect("/setup");
  }
  if (!result.ok) return { error: result.error };
  redirect("/");
}

export async function setupOwner(_: unknown, form: FormData): Promise<{ error?: string }> {
  if ((await currentBootstrapMode()) !== "setup") return { error: "Setup is already done. Sign in instead." };
  if (!(await hasSetupPass())) return { error: "Your setup link expired. Sign in with ADMIN_PASSWORD again." };
  const name = str(form, "name");
  const email = normalizeEmail(str(form, "email") ?? "");
  const password = (form.get("password") as string) ?? "";
  if (!name) return { error: "Enter your name." };
  if (!looksLikeEmail(email)) return { error: "Enter a valid email address." };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  if (password !== form.get("confirm")) return { error: "The two passwords don't match." };
  let owner;
  try {
    owner = await createUser({ email, name, role: "owner", password });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't create the account." };
  }
  const { ip } = await requestMeta();
  await audit("auth.setup_owner", { userId: owner.id, target: `user:${owner.id}`, detail: { via: "setup page" }, ip });
  await createSession(owner, "password");
  await audit("auth.sign_in", { userId: owner.id, target: email, detail: { method: "password" }, ip });
  (await cookies()).delete(SETUP_COOKIE);
  redirect("/");
}

export async function logout() {
  const user = await getCurrentUser();
  await endSession();
  if (user) await audit("auth.sign_out", { userId: user.id, target: user.email, ip: (await requestMeta()).ip });
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
  cplTarget: num(f, "cplTarget"),
  reportCurrency: (str(f, "reportCurrency") ?? "EUR") as "EUR" | "USD",
  reportGreeting: str(f, "reportGreeting") ?? "Hi guys",
  reportRules: str(f, "reportRules"),
  goals: str(f, "goals"),
  notes: str(f, "notes"),
});

/** Team members can't set billing fields: drop them so the stored values (or defaults) stay. */
function withoutBilling<T extends ReturnType<typeof clientFields>>(values: T) {
  const { retainerExVat: _r, vat: _v, billingMethod: _b, stripeCustomerId: _s, ...rest } = values;
  return rest;
}

export async function createClient(form: FormData) {
  const user = await requireSignedIn();
  const all = clientFields(form);
  const values = can(user.role, "client_billing") ? all : withoutBilling(all);
  if (!values.name) throw new Error("Name is required");
  const [c] = await db.insert(schema.clients).values(values).returning({ id: schema.clients.id });
  await audit("client.create", { userId: user.id, target: `client:${c.id}`, detail: { name: values.name } });
  revalidatePath("/clients");
  redirect(`/clients/${c.id}`);
}

export async function updateClient(id: number, form: FormData) {
  const user = await requireSignedIn();
  const all = clientFields(form);
  const values = can(user.role, "client_billing") ? all : withoutBilling(all);
  if (!values.name) throw new Error("Name is required");
  const [before] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  if (!before) throw new Error("Client not found");
  await db.update(schema.clients).set(values).where(eq(schema.clients.id, id));
  const changed = Object.keys(values).filter((k) => String(before[k as keyof typeof before] ?? "") !== String(values[k as keyof typeof values] ?? ""));
  await audit("client.update", { userId: user.id, target: `client:${id}`, detail: { name: values.name, changed } });
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

// ---------- payments ----------

export async function generateMonthAction(form: FormData) {
  const user = await requirePermission("payments", "change payments");
  const month = str(form, "month") ?? today().slice(0, 7);
  const created = await generateMonth(`${month}-01`);
  await audit("payment.generate_month", { userId: user.id, target: `month:${month}`, detail: { created } });
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function recordPaymentAction(form: FormData) {
  const user = await requirePermission("payments", "record payments");
  const id = z.coerce.number().parse(form.get("paymentId"));
  const amount = num(form, "amount");
  if (amount === null || Number.isNaN(amount)) throw new Error("Amount is required");
  const data = {
    amount,
    paidDate: str(form, "paidDate") ?? today(),
    method: (str(form, "method") ?? undefined) as "stripe" | "invoice" | "revolut" | "aib" | "cash" | undefined,
    note: str(form, "note") ?? undefined,
  };
  await recordPayment(id, data);
  await audit("payment.record", { userId: user.id, target: `payment:${id}`, detail: data });
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function addPaymentAction(form: FormData) {
  const user = await requirePermission("payments", "add payments");
  const clientId = z.coerce.number().parse(form.get("clientId"));
  const month = str(form, "month") ?? today().slice(0, 7);
  const amountDue = num(form, "amountDue");
  if (!amountDue) throw new Error("Amount is required");
  await db
    .insert(schema.payments)
    .values({ clientId, label: str(form, "label") ?? "One-off", period: `${month}-01`, amountDue, dueDate: str(form, "dueDate") ?? `${month}-01` })
    .onConflictDoNothing();
  await audit("payment.add", { userId: user.id, target: `client:${clientId}`, detail: { month, amountDue, label: str(form, "label") ?? "One-off" } });
  revalidatePath("/payments");
}

// ---------- reconciliation ----------

const back = (form: FormData, extra: Record<string, string>) => {
  const q = new URLSearchParams(extra);
  const month = str(form, "month");
  if (month) q.set("month", month);
  return `/payments?${q.toString()}#reconcile`;
};

/** Upload a Revolut Business or AIB CSV export. Credits land in Unmatched with suggestions; nothing is applied. */
export async function importBankCsvAction(form: FormData) {
  await requirePermission("payments", "Payments");
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) redirect(back(form, { error: "Choose a CSV file to upload." }));
  if (file.size > 5_000_000) redirect(back(form, { error: "That file is over 5 MB. Export a shorter date range." }));
  const format = str(form, "format");
  let msg: string;
  try {
    const r = await importBankCsv(await file.text(), { format: format === "revolut" || format === "aib" ? format : undefined, fileName: file.name });
    msg = `${r.format}: ${r.credits} incoming payment${r.credits === 1 ? "" : "s"} read, ${r.inserted} new (${r.suggested} with a suggested match), ${r.duplicates} already imported, ${r.skipped} other rows skipped.${r.errors.length ? ` ${r.errors.length} row(s) unreadable: ${r.errors.slice(0, 3).join(" ")}` : ""}`;
  } catch (e) {
    redirect(back(form, { error: e instanceof Error ? e.message : String(e) }));
  }
  revalidatePath("/payments");
  redirect(back(form, { imported: msg }));
}

export async function assignIncomingAction(form: FormData) {
  await requirePermission("payments", "Payments");
  const incomingId = z.coerce.number().parse(form.get("incomingId"));
  const paymentId = z.coerce.number().parse(form.get("paymentId"));
  try {
    await assignIncoming(incomingId, paymentId, { linkStripeCustomer: form.get("linkStripe") === "on" });
  } catch (e) {
    redirect(back(form, { error: e instanceof Error ? e.message : String(e) }));
  }
  revalidatePath("/payments");
  revalidatePath("/");
  redirect(back(form, {}));
}

export async function ignoreIncomingAction(form: FormData) {
  await requirePermission("payments", "Payments");
  await ignoreIncoming(z.coerce.number().parse(form.get("incomingId")));
  revalidatePath("/payments");
  redirect(back(form, {}));
}

export async function restoreIncomingAction(form: FormData) {
  await requirePermission("payments", "Payments");
  await restoreIncoming(z.coerce.number().parse(form.get("incomingId")));
  revalidatePath("/payments");
  redirect(back(form, {}));
}

export async function saveCashSummaryAction(form: FormData) {
  await requirePermission("payments", "Payments");
  await saveCashSummary();
  revalidatePath("/payments");
  const q = new URLSearchParams();
  const month = str(form, "month");
  if (month) q.set("month", month);
  redirect(`/payments?${q.toString()}#cash-summary`);
}

// ---------- tasks ----------

export async function createTask(form: FormData) {
  await requireSignedIn();
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
  await requireSignedIn();
  await db
    .update(schema.tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(eq(schema.tasks.id, id));
  revalidatePath("/tasks");
  revalidatePath("/");
}

// ---------- health ----------

export async function saveHealthAction(form: FormData) {
  await requireSignedIn();
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
  await requireSignedIn();
  await db.update(schema.healthChecks).set({ resolved: true }).where(eq(schema.healthChecks.id, id));
  revalidatePath("/health");
  revalidatePath("/");
}

// ---------- reports ----------

export async function setReportStatus(id: number, status: "draft" | "sent") {
  await requireSignedIn();
  await db.update(schema.reports).set({ status }).where(eq(schema.reports.id, id));
  revalidatePath("/reports");
}

export async function updateReportBody(id: number, form: FormData) {
  await requireSignedIn();
  const body = str(form, "body");
  if (!body) return;
  await db.update(schema.reports).set({ body }).where(eq(schema.reports.id, id));
  revalidatePath("/reports");
}

// ---------- approvals ----------

async function loadDecidable(id: number) {
  const user = await requireSignedIn();
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id));
  if (!a) throw new Error(`Approval ${id} not found`);
  if (!canDecide(user.role, a.agent, a.tool)) throw new ForbiddenError("decide finance or Stripe actions");
  return { user, a };
}

export async function approve(id: number) {
  const { user, a } = await loadDecidable(id);
  const r = await executeApproval(id, user.id);
  await audit("approval.approve", { userId: user.id, target: `approval:${id}`, detail: { agent: a.agent, tool: a.tool, ok: r.ok } });
  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function reject(id: number) {
  const { user, a } = await loadDecidable(id);
  await rejectApproval(id, user.id);
  await audit("approval.reject", { userId: user.id, target: `approval:${id}`, detail: { agent: a.agent, tool: a.tool } });
  revalidatePath("/approvals");
  revalidatePath("/");
}

// ---------- agents ----------

export async function runAgentAction(form: FormData) {
  const user = await requireSignedIn();
  const agent = AGENTS[str(form, "agent") ?? ""];
  if (!agent) throw new Error("Unknown agent");
  if (!canRunAgent(user.role, agent.name)) throw new ForbiddenError(`run the ${agent.title} agent`);
  const instruction = str(form, "instruction") ?? undefined;
  if (agent.needsInstruction && !instruction) throw new Error("This agent needs an instruction.");
  const dryRun = form.get("dryRun") === "on";
  // Respond straight away; the run continues in the background and shows up under Recent runs.
  after(() => runAgent(agent, { dryRun, instruction, trigger: "manual" }).catch((e) => console.error(e)));
  revalidatePath("/agents");
  redirect("/agents?started=" + agent.name);
}

const JARVIS_NO_KEY = "Jarvis can't answer yet: ANTHROPIC_API_KEY isn't set. Add it in Vercel → Settings → Environment Variables, then redeploy.";

/**
 * Ask Jarvis from Home without leaving the page. Creates the run and returns its id straight away;
 * the run continues in the background and Home polls /api/runs/[id] for the answer.
 */
export async function askJarvis(question: string): Promise<{ runId: number } | { error: string }> {
  const user = await requireSignedIn();
  const q = question.trim().slice(0, 2000);
  if (!q) return { error: "Type a question first." };
  if (!process.env.ANTHROPIC_API_KEY) return { error: JARVIS_NO_KEY };
  const agent = AGENTS.jarvis;
  const opts = { instruction: q, trigger: "manual" as const };
  const run = await createRun(agent, opts);
  await audit("agent.ask", { userId: user.id, target: `run:${run.id}`, detail: { agent: "jarvis" } });
  after(() => executeRun(run, agent, opts).catch((e) => console.error(e)));
  return { runId: run.id };
}

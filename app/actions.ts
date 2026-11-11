"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { generateMonth, recordPayment } from "@/lib/billing";
import { executeApproval, rejectApproval } from "@/lib/approvals";
import { runAgent } from "@/lib/runner";
import { AGENTS } from "@/agents/registry";
import { today, weekStart } from "@/lib/dates";
import { assignIncoming, ignoreIncoming, importBankCsv, restoreIncoming } from "@/lib/reconcile";
import { saveCashSummary } from "@/lib/finance";

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

// ---------- reconciliation ----------

const back = (form: FormData, extra: Record<string, string>) => {
  const q = new URLSearchParams(extra);
  const month = str(form, "month");
  if (month) q.set("month", month);
  return `/payments?${q.toString()}#reconcile`;
};

/** Upload a Revolut Business or AIB CSV export. Credits land in Unmatched with suggestions; nothing is applied. */
export async function importBankCsvAction(form: FormData) {
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
  await ignoreIncoming(z.coerce.number().parse(form.get("incomingId")));
  revalidatePath("/payments");
  redirect(back(form, {}));
}

export async function restoreIncomingAction(form: FormData) {
  await restoreIncoming(z.coerce.number().parse(form.get("incomingId")));
  revalidatePath("/payments");
  redirect(back(form, {}));
}

export async function saveCashSummaryAction(form: FormData) {
  await saveCashSummary();
  revalidatePath("/payments");
  const q = new URLSearchParams();
  const month = str(form, "month");
  if (month) q.set("month", month);
  redirect(`/payments?${q.toString()}#cash-summary`);
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
  await db.update(schema.reports).set({ status }).where(eq(schema.reports.id, id));
  revalidatePath("/reports");
}

export async function updateReportBody(id: number, form: FormData) {
  const body = str(form, "body");
  if (!body) return;
  await db.update(schema.reports).set({ body }).where(eq(schema.reports.id, id));
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
  // Respond straight away; the run continues in the background and shows up under Recent runs.
  after(() => runAgent(agent, { dryRun, instruction, trigger: "manual" }).catch((e) => console.error(e)));
  revalidatePath("/agents");
  redirect("/agents?started=" + agent.name);
}

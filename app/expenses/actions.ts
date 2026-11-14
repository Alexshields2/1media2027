"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { audit } from "@/lib/audit";
import { addManualExpense, importExpenseCsv, setExpenseCategory, updateExpenseDetails } from "@/lib/expenses";
import { categoriseWithClaude, aiCategoriserReady } from "@/lib/expense-ai";
import { isCategory } from "@/lib/expense-rules";
import { parseAmount } from "@/lib/bank-csv";
import { runRevolutSync } from "@/lib/revolut/run";

// Expenses page actions. Owner only ("payments" permission covers money in and money out).

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const back = (f: FormData | null, q: Record<string, string>): never => {
  const month: Record<string, string> = f && /^\d{4}-\d{2}$/.test(String(f.get("month") ?? "")) ? { month: String(f.get("month")) } : {};
  redirect(`/expenses?${new URLSearchParams({ ...month, ...q })}`);
};

export async function setCategoryAction(form: FormData) {
  const user = await requirePermission("payments", "change expenses");
  const id = Number(form.get("id"));
  const category = form.get("category");
  if (!Number.isInteger(id) || !isCategory(category)) throw new Error("Pick a category.");
  const r = await setExpenseCategory(id, category, { userId: user.id, remember: form.get("remember") !== "off" });
  await audit("expense.update", { userId: user.id, target: `expense:${id}`, detail: { category, alsoUpdated: r.alsoUpdated } });
  revalidatePath("/expenses");
}

export async function updateExpenseAction(form: FormData) {
  const user = await requirePermission("payments", "change expenses");
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) throw new Error("Unknown expense.");
  const vatRaw = str(form, "vat");
  const vat = vatRaw === null ? null : parseAmount(vatRaw);
  if (vatRaw !== null && (vat === null || vat < 0)) back(form, { error: "VAT must be an amount, e.g. 23.00." });
  const clientId = Number(form.get("clientId")) || null;
  const receipt = str(form, "receiptUrl");
  if (receipt && !/^https?:\/\//i.test(receipt)) back(form, { error: "The receipt link must start with https://" });
  await updateExpenseDetails(id, { notes: str(form, "notes"), clientId, vatAmount: vat, receiptUrl: receipt });
  await audit("expense.update", { userId: user.id, target: `expense:${id}`, detail: { clientId, vat } });
  revalidatePath("/expenses");
}

export async function addExpenseAction(form: FormData) {
  const user = await requirePermission("payments", "add expenses");
  const date = str(form, "date");
  const merchant = str(form, "merchant");
  const amount = parseAmount(str(form, "amount") ?? undefined);
  const currency = (str(form, "currency") ?? "EUR").toUpperCase();
  const category = form.get("category");
  const vatRaw = str(form, "vat");
  const vat = vatRaw ? parseAmount(vatRaw) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) back(form, { error: "Enter the date." });
  if (!merchant) back(form, { error: "Enter who was paid." });
  if (!amount || amount <= 0) back(form, { error: "Enter the amount, e.g. 49.99." });
  if (!/^[A-Z]{3}$/.test(currency)) back(form, { error: "Currency is a 3-letter code, e.g. EUR." });
  const id = await addManualExpense({
    date: date!,
    merchant: merchant!,
    description: str(form, "description"),
    amount: amount!,
    currency,
    category: isCategory(category) ? category : null,
    vatAmount: vat,
    clientId: Number(form.get("clientId")) || null,
    notes: str(form, "notes"),
  });
  await audit("expense.add", { userId: user.id, target: `expense:${id}`, detail: { amount, currency } });
  back(null, { month: date!.slice(0, 7), imported: `Added ${merchant} (${amount!.toFixed(2)} ${currency}).` });
}

export async function importExpensesAction(form: FormData) {
  const user = await requirePermission("payments", "import expenses");
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) back(form, { error: "Choose a CSV file first." });
  if ((file as File).size > 5 * 1024 * 1024) back(form, { error: "That file is over 5 MB. Export a shorter date range." });
  const fmt = form.get("format");
  let msg: string;
  try {
    const r = await importExpenseCsv(await (file as File).text(), { format: fmt === "revolut" || fmt === "aib" ? fmt : undefined });
    await audit("expense.import", { userId: user.id, target: `file:${(file as File).name}`, detail: { ...r, errors: r.errors.length } });
    let ai = 0;
    if (r.uncategorised && aiCategoriserReady()) ai = (await categoriseWithClaude().catch(() => ({ updated: 0 }))).updated;
    msg =
      `${r.format}: ${r.debits} payments out read, ${r.inserted} new, ${r.duplicates} already recorded` +
      (r.uncategorised ? `, ${Math.max(r.uncategorised - ai, 0)} need a category` : "") +
      (ai ? ` (${ai} categorised by Claude)` : "") +
      "." +
      (r.credits ? ` ${r.credits} payments in were left for the Payments page.` : "") +
      (r.errors.length ? ` ${r.errors.length} row(s) couldn't be read.` : "");
  } catch (e) {
    return back(form, { error: e instanceof Error ? e.message : "Couldn't read that file." });
  }
  back(form, { imported: msg });
}

export async function categoriseAiAction(form: FormData) {
  const user = await requirePermission("payments", "categorise expenses");
  if (!aiCategoriserReady()) back(form, { error: "Add ANTHROPIC_API_KEY to let Claude categorise expenses." });
  let msg: string;
  try {
    const r = await categoriseWithClaude();
    await audit("expense.categorise_ai", { userId: user.id, detail: r });
    msg = `Claude categorised ${r.updated} expense(s) from ${r.merchants} merchant(s). Change any it got wrong and the merchant is remembered.`;
  } catch (e) {
    return back(form, { error: `Claude couldn't categorise just now: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}` });
  }
  back(form, { imported: msg });
}

export async function syncRevolutFromExpensesAction(form: FormData) {
  const user = await requirePermission("manage_integrations", "sync Revolut");
  const r = await runRevolutSync("manual");
  await audit("revolut.sync", { userId: user.id, target: "integration:revolut", detail: r.ok ? { ...r.result } : { error: r.error ?? r.skipped } });
  if (!r.ok) back(form, { error: r.needsReauth ? "Revolut needs re-authorising: open Integrations and click Authorise." : (r.error ?? r.skipped ?? "Sync failed.") });
  const s = r.ok ? r.result : null;
  back(form, { imported: s ? `Revolut: ${s.expensesAdded} new expense(s), ${s.incomeAdded} payment(s) in waiting on Payments.` : "Synced." });
}

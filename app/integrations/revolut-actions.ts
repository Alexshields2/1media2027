"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { audit } from "@/lib/audit";
import { redirectUriFor } from "@/lib/revolut/api";
import { disconnectRevolut, ensureKeyAndCertificate, saveClientId, startAuthorisation } from "@/lib/revolut/connection";
import { runRevolutSync } from "@/lib/revolut/run";

// Revolut Business set-up on /integrations. Owner only. None of these return or log a secret.

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "1media2027.vercel.app";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

const back = (q: Record<string, string>): never => redirect(`/integrations?${new URLSearchParams(q)}#revolut`);

export async function revolutCertificateAction() {
  const user = await requirePermission("manage_integrations", "set up Revolut");
  await ensureKeyAndCertificate();
  await audit("revolut.setup", { userId: user.id, target: "integration:revolut", detail: { step: "certificate" } });
  revalidatePath("/integrations");
}

export async function revolutClientIdAction(form: FormData) {
  const user = await requirePermission("manage_integrations", "set up Revolut");
  try {
    await saveClientId(String(form.get("clientId") ?? ""));
  } catch (e) {
    back({ error: e instanceof Error ? e.message : "Couldn't save the client ID." });
  }
  await audit("revolut.setup", { userId: user.id, target: "integration:revolut", detail: { step: "client_id" } });
  revalidatePath("/integrations");
}

export async function revolutAuthoriseAction() {
  await requirePermission("manage_integrations", "connect Revolut");
  let url: string;
  try {
    url = await startAuthorisation(redirectUriFor(await origin()));
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : "Couldn't start the Revolut sign-in." });
  }
  redirect(url);
}

export async function revolutSyncAction() {
  const user = await requirePermission("manage_integrations", "sync Revolut");
  const r = await runRevolutSync("manual");
  await audit("revolut.sync", { userId: user.id, target: "integration:revolut", detail: r.ok ? { ...r.result, aiCategorised: r.aiCategorised } : { error: r.error ?? r.skipped } });
  if (!r.ok) back({ error: r.needsReauth ? "Revolut needs re-authorising: click Authorise again." : (r.error ?? r.skipped ?? "Sync failed.") });
  const s = r.ok ? r.result : null;
  back({ revolut: "synced", detail: s ? `${s.transactions} transactions read: ${s.expensesAdded} new expenses, ${s.incomeAdded} new payments in to match${r.ok && r.aiCategorised ? `, ${r.aiCategorised} categorised by Claude` : ""}.` : "" });
}

export async function revolutDisconnectAction() {
  const user = await requirePermission("manage_integrations", "disconnect Revolut");
  await disconnectRevolut();
  await audit("revolut.disconnect", { userId: user.id, target: "integration:revolut" });
  revalidatePath("/integrations");
}

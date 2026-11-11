import type { Client } from "../db/schema";

// What a client needs before the agents can do their job. One source of truth for the
// checklist on the client page and the "Set up" column on the Clients list.

export interface SetupItem {
  key: "meta" | "ghl" | "stripe" | "cpl" | "rules" | "greeting";
  label: string; // checklist wording
  add: string; // call to action when missing
  short: string; // Clients list wording
  field: keyof Client; // form field to fill
  done: boolean;
  why: string;
}

type SetupClient = Pick<Client, "metaAdAccountIds" | "ghlLocationId" | "stripeCustomerId" | "billingMethod" | "cplTarget" | "reportRules" | "reportGreeting">;

const filled = (v: string | null | undefined) => Boolean(v && v.trim());

/** `billing: false` leaves out billing items (for people who may not see billing details). */
export function setupChecklist(c: SetupClient, opts: { billing?: boolean } = {}): SetupItem[] {
  const items: SetupItem[] = [
    { key: "meta", label: "Meta ad account IDs", add: "Add Meta ad account IDs", short: "Meta", field: "metaAdAccountIds", done: filled(c.metaAdAccountIds), why: "Weekly reports and health checks read spend, leads and CPL from these accounts." },
    { key: "ghl", label: "GoHighLevel location", add: "Add GoHighLevel location", short: "GHL", field: "ghlLocationId", done: filled(c.ghlLocationId), why: "Lets agents check whether leads are being called and moved." },
  ];
  if (opts.billing !== false && c.billingMethod === "stripe")
    items.push({ key: "stripe", label: "Stripe customer", add: "Add Stripe customer ID", short: "Stripe", field: "stripeCustomerId", done: filled(c.stripeCustomerId), why: "Billed by Stripe: payments are matched to this customer." });
  items.push(
    { key: "cpl", label: "CPL target", add: "Set a CPL target", short: "CPL target", field: "cplTarget", done: c.cplTarget !== null && c.cplTarget > 0, why: "Client health compares cost per lead against it." },
    { key: "rules", label: "Report rules", add: "Add report rules", short: "report rules", field: "reportRules", done: filled(c.reportRules), why: "Client-specific instructions for the weekly report. Write \"None\" if the standard format is fine." },
    { key: "greeting", label: "Report greeting", add: "Add report greeting", short: "greeting", field: "reportGreeting", done: filled(c.reportGreeting), why: "Opening line of the weekly report, e.g. \"Hi guys\"." },
  );
  return items;
}

export function setupProgress(c: SetupClient, opts: { billing?: boolean } = {}) {
  const items = setupChecklist(c, opts);
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, missing: items.filter((i) => !i.done), complete: done === items.length };
}

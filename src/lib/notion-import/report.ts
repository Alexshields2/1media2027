import { SOURCE_TITLES } from "./plan";
import type { ImportReport } from "./run";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The end-of-run report, as plain text for the terminal. */
export function formatReport(r: ImportReport): string {
  const L: string[] = [];
  const h = (s: string) => L.push("", s, "-".repeat(s.length));
  L.push(r.dryRun ? "DRY RUN: nothing was written. Re-run without --dry-run to import." : "Import finished. Notion was only read, never written.");

  h("Read from Notion");
  for (const s of r.sources) L.push(`  ${s.title.padEnd(38)} ${s.error ? `NOT READ: ${s.error}` : plural(s.rows, "row")}`);

  const c = r.clients;
  const created = c.filter((a) => a.kind === "create");
  const updated = c.filter((a) => a.kind === "update");
  const unchanged = c.filter((a) => a.kind === "unchanged");
  const merged = c.filter((a) => a.group.records.length > 1);
  h(`Clients: ${created.length} new, ${updated.length} updated, ${unchanged.length} already up to date, ${r.clientSkips.length} skipped`);
  for (const a of created) {
    const v = a.values;
    L.push(`  + ${v.name} [${v.status ?? "active"}]${v.retainerExVat ? `  €${v.retainerExVat}/mo ex VAT` : ""}${v.billingMethod ? `  ${v.billingMethod}` : ""}  (from ${[...new Set(a.group.records.map((x) => SOURCE_TITLES[x.source]))].join(", ")})`);
  }
  for (const a of updated) {
    const fields = Object.keys(a.set);
    L.push(`  ~ ${a.name} (matched by ${a.matchedBy}): ${fields.length ? `filled ${fields.join(", ")}` : "linked to Notion"}`);
  }
  if (merged.length) {
    h(`Merged duplicates: ${plural(merged.length, "client")} appeared in more than one Notion list`);
    for (const a of merged) L.push(`  ${a.group.fields.name} ← ${a.group.records.map((x) => `${SOURCE_TITLES[x.source]} "${x.label}"`).join(" + ")}`);
  }
  if (r.clientSkips.length) {
    h("Skipped client rows");
    for (const s of r.clientSkips) L.push(`  - ${SOURCE_TITLES[s.source]} "${s.label}": ${s.reason}`);
  }

  const p = r.payments;
  const count = (k: string) => p.filter((a) => a.kind === k).length;
  const skips = [...r.paymentSkips.map((s) => ({ label: s.label, reason: s.reason })), ...p.flatMap((a) => (a.kind === "skip" ? [{ label: a.draft.title, reason: a.reason }] : []))];
  h(`Payments: ${count("create")} new, ${count("merge")} merged into existing rows, ${count("update")} updated, ${count("unchanged")} already up to date, ${skips.length} skipped`);
  const inferred = p.filter((a) => a.kind !== "skip" && a.draft.inferredPaid).length;
  if (inferred) L.push(`  ${plural(inferred, "row")} had Paid ticked but no Amount Collected: imported as paid in full.`);
  const merges = p.filter((a) => a.kind === "merge");
  if (merges.length) L.push(`  Merged rows already existed in 1Media OS (made by the monthly billing job or by hand); only their blanks were filled.`);
  for (const a of p) if (a.kind !== "skip" && a.kind !== "create" && a.notes.length) L.push(`  ! ${a.draft.title}: ${a.notes.join("; ")}`);
  if (skips.length) {
    L.push("  Skipped:");
    for (const s of skips) L.push(`  - "${s.label}": ${s.reason}`);
  }

  if (r.unmapped.length) {
    h("Notion fields not imported (have data, no place in 1Media OS)");
    for (const u of r.unmapped) L.push(`  ${SOURCE_TITLES[u.source]} › ${u.field} (${plural(u.rows, "row")}): ${u.why}`);
  }
  if (r.warnings.length) {
    h("Check these");
    for (const w of r.warnings) L.push(`  ! ${w}`);
  }
  L.push("", r.dryRun ? "Dry run: nothing was written to 1Media OS." : "Next: open Clients and work through each client's set-up checklist.");
  return L.join("\n");
}

import "../src/config";
import { resolve } from "node:path";
import { closeDb } from "../src/db";
import { fixtureFetch } from "../src/lib/notion-import/notion";
import { formatReport } from "../src/lib/notion-import/report";
import { runImport } from "../src/lib/notion-import/run";

// READ-ONLY import of clients and payment history from the old Notion OS into 1Media OS.
// Nothing is ever written to Notion. See README → "Bring your data across from Notion".
//
//   npm run import:notion -- --dry-run          # show what would change, write nothing
//   npm run import:notion                       # import (safe to re-run; only fills blanks)
//   npm run import:notion -- --fixtures tests/fixtures/notion --dry-run   # rehearse on fake data
//   add --json to print the full plan as JSON

const USAGE = `Usage: npm run import:notion -- [--dry-run] [--json] [--fixtures <dir>]

Needs NOTION_TOKEN (an internal integration shared with Client Portals, Payment Collection,
Client Data Base For Monthly Reports and Sales CRM) and DATABASE_URL (not needed for --dry-run).`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return console.log(USAGE);
  const known = new Set(["--dry-run", "--json", "--fixtures"]);
  const unknown = args.filter((a, i) => a.startsWith("-") && !known.has(a) && args[i - 1] !== "--fixtures");
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(" ")}\n\n${USAGE}`);
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const fi = args.indexOf("--fixtures");
  const fixtures = fi >= 0 ? args[fi + 1] : undefined;
  if (fi >= 0 && !fixtures) throw new Error("--fixtures needs a folder");

  const token = fixtures ? "fixture-token" : process.env.NOTION_TOKEN;
  if (!token) throw new Error(`Missing NOTION_TOKEN.\n\n${USAGE}`);
  const hasDb = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!dryRun && !hasDb) throw new Error("Missing DATABASE_URL. Use --dry-run to preview without a database.");

  const store = hasDb ? (await import("../src/lib/notion-import/store")).dbStore : null;
  if (!json) console.error(`Reading ${fixtures ? `fixtures in ${fixtures}` : "Notion"} (read-only)…`);
  const report = await runImport({ dryRun, token, store, fetch: fixtures ? fixtureFetch(resolve(fixtures)) : undefined });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

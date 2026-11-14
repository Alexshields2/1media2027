# 1Media OS

The operating system for 1Media: clients, cash, delivery and the AI agents that run the agency, in one web app. It deploys on Vercel.

## What's in it

| Page | What it does |
|---|---|
| **Dashboard** | MRR, collected and outstanding this month, overdue payments, red/yellow clients, tasks due, approvals waiting, recent agent runs |
| **Clients** | Every client with retainer, VAT, billing method, Meta ad accounts, GHL location, Stripe customer, CPL target and report rules |
| **Payments** | The payment log: one tick box per client per month (Jan to now, any year), ticked = paid in full, half = part paid, red = overdue, with row, month and year-to-date totals, plus a "By month" list like the old Notion view. Click an amount for a part payment, date, method or note. Stripe payments are never applied automatically: they wait under "Stripe payments to assign" and you pick the month(s) each covers (split allowed, paying ahead creates the month). Upload a Revolut Business or AIB CSV and confirm the suggested matches. Overdue by age (0–14, 15–30, 31–60, 60+ days), balance per client, and the weekly cash summary |
| **Expenses** | Everything that left the business: Revolut Business card payments, transfers and fees (synced daily), statement CSV imports and manual entries. Month totals by category, a 12-month trend, search and filters, inline recategorise (the merchant is remembered), VAT, notes, receipt links, rechargeable-to-client, and a CSV export for the accountant. Owners only |
| **Tasks** | Board (to do / in progress / review / done), filtered by client. Agents add tasks too |
| **Client health** | Weekly traffic light per client, scored from the numbers (CPL vs target, lead volume vs the previous 4 weeks, creative fatigue, GHL leads untouched over 24h) with the reason for each, and a 6-week history |
| **Reports** | Per-client week view: spend, leads, CPL, impressions, clicks and CTR with week-on-week change, the WhatsApp-ready text (copy for WhatsApp, mark sent), and a run-status strip with a Retry button per client. Month-end view with a PDF per client (download, or saved to the client's Drive folder) |
| **Approvals** | Anything an agent wants to send, charge or change outside the OS waits here. Approve runs it; reject drops it |
| **Chats** | A Claude-style chat per agent (Jarvis, Fulfilment, Reporting, Project management, Payments, Sales, Inbox, Client health). Streaming answers, tool calls shown inline, Approve / Reject cards for proposed actions, file attachments (PDF, images, CSV, XLSX, text; 4 MB per message). Owners write each agent's instructions and pick its tools, autonomy and web search on its settings page, and can create new agents |
| **Agents** | Run any agent now (dry run by default) and read every run's summary and tool calls |
| **Settings** | People and roles (owner / team), password resets, integration status, audit log |

## Agents

| Agent | When | Does |
|---|---|---|
| Finance | Weekdays 08:00 | Flags overdue clients by age, queues chasers in Approvals (never sends), saves a Friday cash summary and posts it to Slack |
| Weekly reports | Mondays 07:00 | Every client's WhatsApp report from Meta Ads, leads and tasks, with the numbers saved |
| Month-end reports | 1st, 09:00 | One executive report and PDF per client from the month's weekly numbers |
| Client health | Weekdays 08:30 | CPL against target, lead volume, creative fatigue, leads left untouched in GHL |
| Inbox | On demand | Sorts Gmail by client, creates tasks, notes each client's emails on their page; replies wait in Approvals |
| Call prep | On demand, or "Prep for call" on a client | A brief on the client page before each call, with every lead by name |
| Onboarding | On demand | The Signed-to-Scaling set-up plan for a new client |
| Sales | On demand | Prospect follow-ups and discovery-call prep |
| Ask Jarvis | On demand | Answers any question about the agency. Read-only |

On the 1st of each month a billing job (no AI) also creates that month's payment rows.

**Reports run one client at a time.** The weekly and month-end crons don't run one agent over every client. They create one job per active client and call `/api/cron/report-worker` once per job, so each client gets its own function and its own 300-second limit. A failed client retries up to 3 times; a client whose function timed out is picked up again by the next cron (every cron sweeps the queue). The Reports page shows each client's status with a Retry button. See `src/lib/report-jobs.ts`.

**Safety:**
- Every agent has a level: read-only, asks before any change, or updates the OS itself and asks before anything external.
- Sending an email or message, creating a Stripe invoice and posting to Slack always need your approval.
- Some things are blocked even if someone approves them: deleting anything, changing Ads Manager, and Stripe refunds or payouts.

Agents use Claude (Anthropic API). They reach Gmail, Calendar, Drive, Meta Ads, GoHighLevel, Stripe and Slack through Composio. Without Composio they still run on the OS database alone.

## Deploy to Vercel

1. **Import the repo:** go to [vercel.com/new](https://vercel.com/new), find **1media2027** under "Import Git Repository" (connect GitHub if asked), and click **Import**.
2. **Add a password:** before clicking Deploy, open **Environment Variables** and add:
   - `ADMIN_PASSWORD`: your dashboard login.
   - `CRON_SECRET`: any long random string.
   - `ANTHROPIC_API_KEY`: for the agents.
   Then click **Deploy**.
3. **Add the database:** in the new project, go to **Storage → Create Database → Neon → Create → Connect**, then **Deployments → ⋯ → Redeploy**. The tables are created automatically during the build.
4. Open the site and sign in with `ADMIN_PASSWORD`. That first sign-in creates your owner account (email from `OWNER_EMAIL`, or a one-time setup page asks). From then on everyone signs in with their own email and password; add people in **Settings**.

**Logins and roles:** owners see everything. Team members can't see Payments or money figures, can't edit client billing fields, can't approve finance or Stripe actions, and can't run the Finance agent. This is checked on the server, not just hidden. Sign-ins, approvals, payments and client edits are recorded in the audit log (Settings). Five wrong passwords for one email in 15 minutes locks that email for 15 minutes.

**Preview deploys** never touch the production database: when `VERCEL_ENV=preview`, the app and the build's migrations only use `PREVIEW_DATABASE_URL` (and skip if it isn't set).

**Optional, any time later** (Settings → Environment Variables, then redeploy):
- `COMPOSIO_API_KEY` connects Gmail, Calendar, Meta Ads, GoHighLevel and Stripe for the agents. After adding it, run `npm run connect` and open each login link.
- `STRIPE_WEBHOOK_SECRET` records Stripe payments as they arrive (they wait on the Payments page for you to say which month they cover; nothing is ticked automatically). In Stripe → Developers → Webhooks, add the endpoint `https://<your-app>.vercel.app/api/webhooks/stripe` with the events `invoice.paid`, `invoice.payment_succeeded`, `invoice.updated`, `invoice.payment_failed` and `charge.refunded`, and copy its signing secret (`whsec_…`). Put each client's Stripe customer ID (`cus_…`) on the client so payments show the client's name and suggest their months.
- `SLACK_WEBHOOK_URL` sends agent summaries and approval alerts to Slack.
- Month-end PDFs go to each client's Drive folder when Composio has Google Drive connected and the client record has a **Google Drive folder ID**. Otherwise download them from Reports.
- **Jarvis in Slack** (`/jarvis <question>` and Approve / Reject buttons on approval alerts): create a Slack app from `docs/slack-app-manifest.yml` (replace `YOUR-APP` with the site's domain), install it to the workspace and pick the alerts channel. Then set `SLACK_SIGNING_SECRET` (Basic Information → Signing Secret), `SLACK_WEBHOOK_URL` (Incoming Webhooks, from this app so the buttons work) and `SLACK_ALLOWED_USER_IDS` (who may ask and approve). Questions are read-only; approvals run through the same guardrails as the Approvals page.
- `AGENTS_PAUSED=true` pauses every scheduled agent.
- **Revolut Business** (Expenses, and money in for Payments): set up on **Integrations → Revolut Business**, no env vars needed. See *Revolut Business* below.

**Notes:**
- Cron times are UTC, so jobs run an hour later in Irish summer time.
- On Vercel's Hobby plan, crons run at most once a day and functions stop after 300 seconds. Pro is recommended.

## Bring your data across from Notion (read-only)

`npm run import:notion` copies clients and payment history from the old Notion OS into 1Media OS. It only ever *reads* Notion (the one Notion call it can make is "query a database"). It's safe to run more than once: it only fills in blanks, never overwrites what's been edited in 1Media OS, and never duplicates a payment.

**What it does**
- **Clients:** merges the three Notion client lists into one: *Client Portals* (the main one), *Client Data Base For Monthly Reports* and the **Won** rows of *Sales CRM*. Rows are the same client when they link to each other, their names match after tidying (case, punctuation, "Ltd", "&"…), or a CRM/monthly row shares an email with a portal. Where lists disagree, Client Portals wins. Prospects (any other CRM stage) are skipped.
- **Payments:** every *Payment Collection* row becomes a payment for that client and month. If the monthly billing job (or someone) already made that client's row for that month, the Notion data fills it in instead of adding a second one. `Paid` ticked with no `Amount Collected` counts as paid in full. Money already recorded in 1Media OS (e.g. by Stripe) is never lowered.
- **Report:** at the end it lists what it created, merged, filled in and skipped (with the reason), every Notion field that has data but no place in 1Media OS, and anything to check by hand.

**One-time set-up (owner)**
1. Create an internal integration at notion.so/profile/integrations with **Read content** only. Copy its secret.
2. In Notion, open each of these databases → **•••** → **Connections** → add the integration: *Client Portals*, *Payment Collection*, *Client Data Base For Monthly Reports*, *Sales CRM*. (The first two are required; the import reports and skips either of the others if it can't see it.)

**Running it against production (CTO)**

Run from a laptop or session with the repo checked out and `npm install` done. Use the production database's **direct** (non-pooled) connection string.

1. Rehearse on fake data, no database needed:
   ```bash
   npm run import:notion -- --fixtures tests/fixtures/notion --dry-run
   ```
2. Dry run against real Notion and production. Writes nothing; read the whole report:
   ```bash
   NOTION_TOKEN=ntn_xxx DATABASE_URL='postgres://…' npm run import:notion -- --dry-run
   ```
   Fix anything odd in Notion first (e.g. a duplicate payment row, a client that merged wrongly) and dry-run again. `--json` prints the full plan.
3. Import for real. All writes happen in one transaction, so it either completes or changes nothing:
   ```bash
   NOTION_TOKEN=ntn_xxx DATABASE_URL='postgres://…' npm run import:notion
   ```
4. Run it once more: it should say everything is already up to date.
5. Open **Clients**: the *Set up* column and each client's set-up checklist show what's still missing (Meta ad account IDs, GHL location, Stripe customer for Stripe clients, CPL target, report rules, report greeting).

The script reads the database ids from `NOTION_CLIENTS_DS`, `NOTION_PAYMENTS_DS`, `NOTION_MONTHLY_DS` and `NOTION_CRM_DS` if set, otherwise from the ids of the current Notion OS.

## Run locally

```bash
cp .env.example .env
```

Edit `.env` and set at least `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_PASSWORD` and `OWNER_EMAIL` (for the first sign-in). Then:

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run seed:demo
```

```bash
npm run dev
```

`seed:demo` adds made-up demo clients to an empty database. `npm run dev` serves the app on http://localhost:3000.

Other commands:

```bash
npm test
```

```bash
npm run agent -- finance --dry-run
```

## Development

**Local Postgres.** Any Postgres 16 works. With Docker:

```bash
docker run -d --name om-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

**Migrate and seed.** `node scripts/migrate.mjs` applies `drizzle/` migrations (the build does this too); `npm run seed:demo` adds demo clients to an empty database. After editing `src/db/schema.ts`, run `npm run db:generate` and commit the new migration.

**Checks** (the same ones CI runs on every pull request):

```bash
npm run typecheck
npm test
npm run build
```

**End-to-end smoke test.** Logs in and loads every page against a production build and the seeded database, failing on any non-200, missing heading or browser console error:

```bash
npx playwright install chromium   # once
export ADMIN_PASSWORD=dev AUTH_SECRET=dev
npm run build && npm run test:e2e
```

Set `PW_CHROMIUM_PATH` to use an already-installed Chromium, or `E2E_BASE_URL` to test a running deployment instead of starting `next start`.

**CI.** `.github/workflows/ci.yml` runs typecheck, unit tests and build, and in parallel the smoke test against a Postgres service container. To block merges on failure, add both jobs as required checks in GitHub → Settings → Branches.

**Monitoring.** `GET /api/health` (no login) returns `{ ok, db, version }`, with status 503 if the database doesn't answer within 3 seconds; point an uptime monitor at it. Uncaught server errors are logged as one JSON line (`"source":"1media-os"`, searchable in Vercel → Logs) by `instrumentation.ts`, and, when `SLACK_WEBHOOK_URL` is set, posted to Slack (each distinct error at most once per 10 minutes, at most 5 alerts per 10 minutes per server instance).

Database tests (Stripe and bank CSV fixtures reconciled end to end, the finance agent with the model mocked) need a Postgres you can create databases on; each test file uses its own throwaway database:

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5433/postgres npm test
```

## Money loop

- **Stripe:** the webhook verifies the signature, records each event once (retries are no-ops), and tracks each invoice's cumulative amount paid, so part payments and overlapping events only ever add new money. It matches by the client's Stripe customer ID, then by amount and month when exactly one open row fits. Anything else lands in **Unmatched** on the Payments page. Failed payments and refunds only add a note; nothing ever issues a refund.
- **Bank (Revolut Business, AIB):** upload the CSV export on the Payments page. Only money in is read; each credit gets suggested matches (amount, client or contact name in the payer/reference, month named in the reference, date window). Nothing is recorded until you confirm. Re-uploading an overlapping export is safe. Column names per bank live in `src/lib/bank-csv.ts` (`BANK_FORMATS`).
- **Finance agent:** reads receivables by age, queues one chaser per client per stage (3, 7, 14 days) in Approvals, and on Fridays saves the cash summary (collected, outstanding, overdue by age, forecast for the month) and posts it to Slack.

## Expenses and Revolut Business

- **Expenses page** (owners): each expense has a category from a fixed list (`src/lib/expense-rules.ts`). Order: the owner's merchant memory (change a merchant's category once and its other and future expenses follow), then built-in rules (merchant names and card MCC codes), else left uncategorised. With `ANTHROPIC_API_KEY` set, Claude fills uncategorised ones in batches (one request per 150 distinct merchants, low effort, structured output); it never overrides the owner and never creates memory. Transfers between our own accounts are listed but never counted.
- **Revolut Business API** (direct, not Composio), one-time set-up on Integrations:
  1. **Generate certificate.** The server makes an RSA key pair (the private key is stored encrypted, AES-256-GCM with a key derived from `AUTH_SECRET`; or set `REVOLUT_PRIVATE_KEY` to supply your own PEM) and shows the public X.509 certificate.
  2. In Revolut Business: **Settings → APIs → Business API → Add API certificate**. Title "1Media OS", OAuth redirect URI `https://1media2027.vercel.app/api/revolut/callback`, paste the certificate, save. Revolut shows a **Client ID**.
  3. Paste the Client ID on Integrations, then **Authorise with Revolut** and approve. The first sync (last 90 days) runs straight away.
- **Sync**: daily at 05:30 UTC (`/api/cron/revolut-sync`) and **Sync now**. Card payments, transfers out and fees become expenses; own-account transfers and exchanges are skipped; money in becomes an *unmatched* payment with suggestions on Payments (never applied automatically). Everything is keyed by the Revolut transaction ID, so re-syncs and Revolut CSV uploads never double count. Access tokens refresh themselves; when Revolut stops accepting the refresh token, Integrations and the Home inbox say "Revolut needs re-authorising".
- `REVOLUT_ENV=sandbox` uses Revolut's sandbox (`sandbox-b2b.revolut.com`); default is production. `REVOLUT_REDIRECT_URI` overrides the redirect URI (default: this site's `/api/revolut/callback`).
- Older history: Expenses → **Import a statement** (Revolut Business → Statements → Excel/CSV). Only money out is read there.
- Agents read expenses with the read-only `OS_LIST_EXPENSES` tool (Jarvis and Payments; never team members).

To try the reporting loop without API keys, set `AGENTS_MOCK=true` (a scripted model with fixture Meta Ads and GoHighLevel data; ignored in production), then run this week's reports for every client:

```bash
AGENTS_MOCK=true npm run agent -- reports weekly
```

The reporting-loop tests need a throwaway Postgres database (every table in it is emptied):

```bash
TEST_DATABASE_URL=postgres://localhost/onemedia_test npm run test:db
```

## Code map

```
app/                    pages, server actions, API routes (cron, Stripe webhook)
proxy.ts                login gate (cookie signature; pages and actions re-check the session)
src/db/                 schema (Drizzle) and connection
src/lib/session.ts      sessions and the server-side guards (requireUser, requirePermission)
src/lib/roles.ts        what owners and team members may do
src/lib/auth.ts         sign-in flows (password now; magic link plugs into createSession later)
src/lib/runner.ts       the agent loop: Claude + OS tools + Composio tools, with guardrails
src/lib/guardrails.ts   what each agent may do on its own
src/lib/os-tools.ts     tools that let agents read and write the OS database
src/lib/approvals.ts    runs approved actions
src/lib/billing.ts      VAT, monthly rows, payment state, totals
src/lib/stripe-webhook.ts  Stripe events -> payments (idempotent)
src/lib/bank-csv.ts     Revolut/AIB CSV parsing (column mapping is data)
src/lib/matching.ts     match scoring and aging buckets (pure)
src/lib/reconcile.ts    incoming payments -> payment rows, owner assignment
src/lib/expenses.ts     expenses: insert/dedupe, category memory, month totals, export
src/lib/expense-rules.ts  categories and built-in rules (pure)
src/lib/expense-ai.ts   optional Claude categorisation of uncategorised expenses
src/lib/secrets.ts      encrypted secrets (AES-256-GCM, key from AUTH_SECRET)
src/lib/revolut/        Revolut Business API: certificate + JWT, tokens, transaction sync
src/lib/finance.ts      receivables, chasers, cash summary
src/lib/report-jobs.ts  per-client report jobs: enqueue, fan-out, retries, sweep
src/lib/report-pdf.ts   month-end PDF (pdf-lib, no browser needed)
src/lib/mock-agents.ts  scripted model + fixture Meta Ads/GHL tools (tests, AGENTS_MOCK)
src/agents/             one folder per agent: settings and playbook
drizzle/                database migrations
scripts/                demo seed, Notion import, Composio connect
instrumentation.ts      server error reporting (logs + Slack alerts)
tests/                  unit tests; tests/e2e/ Playwright smoke test
src/lib/notion-import/  Notion import: read, dedupe, plan, report (pure logic in plan.ts)
src/lib/setup.ts        client set-up checklist
tests/fixtures/notion/  fake Notion API responses for the import tests
```

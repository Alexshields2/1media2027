# 1Media OS

The operating system for 1Media: clients, cash, delivery and the AI agents that run the agency, in one web app. It deploys on Vercel.

## What's in it

| Page | What it does |
|---|---|
| **Dashboard** | MRR, collected and outstanding this month, overdue payments, red/yellow clients, tasks due, approvals waiting, recent agent runs |
| **Clients** | Every client with retainer, VAT, billing method, Meta ad accounts, GHL location, Stripe customer, CPL target and report rules |
| **Payments** | One row per client per month, generated from the retainer. Record payments in one click; Stripe payments are recorded automatically |
| **Tasks** | Board (to do / in progress / review / done), filtered by client. Agents add tasks too |
| **Client health** | Weekly traffic light per client, with a 6-week history |
| **Reports** | Weekly WhatsApp reports and month-end reports written by the agents: edit, copy, mark sent |
| **Approvals** | Anything an agent wants to send, charge or change outside the OS waits here. Approve runs it; reject drops it |
| **Agents** | Run any agent now (dry run by default) and read every run's summary and tool calls |

## Agents

| Agent | When | Does |
|---|---|---|
| Finance | Weekdays 08:00 | Matches Stripe payments to retainers, flags overdue clients, drafts chasers, sends a Friday cash summary |
| Weekly reports | Mondays 07:00 | Every client's WhatsApp report from Meta Ads, leads and tasks |
| Month-end reports | 1st, 09:00 | One executive report per client from the month's data |
| Client health | Weekdays 08:30 | CPL against target, lead volume, creative fatigue, leads left untouched in GHL |
| Inbox | On demand | Sorts Gmail by client, drafts replies, creates tasks |
| Call prep | On demand | A brief before each client call, with every lead by name |
| Onboarding | On demand | The Signed-to-Scaling set-up plan for a new client |
| Sales | On demand | Prospect follow-ups and discovery-call prep |
| Ask Jarvis | On demand | Answers any question about the agency. Read-only |

On the 1st of each month a billing job (no AI) also creates that month's payment rows.

**Safety:**
- Every agent has a level: read-only, asks before any change, or updates the OS itself and asks before anything external.
- Sending an email or message, creating a Stripe invoice and posting to Slack always need your approval.
- Some things are blocked even if someone approves them: deleting anything, changing Ads Manager, and Stripe refunds or payouts.

Agents use Claude (Anthropic API). They reach Gmail, Calendar, Drive, Meta Ads, GoHighLevel, Stripe and Slack through Composio. Without Composio they still run on the OS database alone.

## Deploy to Vercel

1. **Import the repo:** vercel.com → Add New → Project → import `1media2027`. The framework (Next.js) is detected automatically.
2. **Add a database:** in the project, Storage → Create → Neon (Postgres). This sets `DATABASE_URL`.
3. **Add environment variables** (Settings → Environment Variables). See `.env.example` for the full list:
   - `ADMIN_PASSWORD`: the dashboard login.
   - `AUTH_SECRET`: any long random string.
   - `CRON_SECRET`: any long random string.
   - `ANTHROPIC_API_KEY`
   - `COMPOSIO_API_KEY`, and optionally `COMPOSIO_USER_ID`.
   - Optional: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `SLACK_WEBHOOK_URL`.
4. **Create the tables:** run this once from your computer, with `DATABASE_URL` set to the Neon URL:
   ```bash
   npm install
   ```
   ```bash
   npm run db:migrate
   ```
5. **Redeploy.** The cron jobs in `vercel.json` start running automatically.
6. **Stripe:** Developers → Webhooks → add the endpoint `https://<your-app>.vercel.app/api/webhooks/stripe` with the event `invoice.paid`, and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
7. **Connect your apps:** run `npm run connect`, then open each login link and sign in with the 1Media accounts.

**Notes:**
- Cron times are UTC, so jobs run an hour later in Irish summer time.
- On Vercel's Hobby plan, crons run at most once a day and functions stop at 300 seconds. Pro is recommended for the weekly report run.
- To pause every scheduled agent, set `AGENTS_PAUSED=true`.

## Bring your data across from Notion (read-only)

```bash
NOTION_TOKEN=secret_xxx npm run import:notion
```

This imports clients and payment history from the old Notion OS and writes nothing to Notion. Set up the token like this:
1. Create an internal integration at notion.so/profile/integrations.
2. Share "Client Portals" and "Payment Collection" with it.

After importing, fill in each client's Meta ad account IDs, GHL location, CPL target and report rules in the app.

## Run locally

```bash
cp .env.example .env
```

Edit `.env` and set at least `DATABASE_URL`, `ADMIN_PASSWORD` and `AUTH_SECRET`. Then:

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

## Code map

```
app/                    pages, server actions, API routes (cron, Stripe webhook)
proxy.ts                login gate
src/db/                 schema (Drizzle) and connection
src/lib/runner.ts       the agent loop: Claude + OS tools + Composio tools, with guardrails
src/lib/guardrails.ts   what each agent may do on its own
src/lib/os-tools.ts     tools that let agents read and write the OS database
src/lib/approvals.ts    runs approved actions
src/lib/billing.ts      VAT, monthly rows, payment state, totals
src/agents/             one folder per agent: settings and playbook
drizzle/                database migrations
scripts/                demo seed, Notion import, Composio connect
tests/                  unit tests
```

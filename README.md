# 1Media OS

The operating system for 1Media: clients, cash, delivery and the AI agents that run the agency, in one web app. It deploys on Vercel.

## What's in it

| Page | What it does |
|---|---|
| **Dashboard** | MRR, collected and outstanding this month, overdue payments, red/yellow clients, tasks due, approvals waiting, recent agent runs |
| **Clients** | Every client with retainer, VAT, billing method, Meta ad accounts, GHL location, Stripe customer, CPL target and report rules |
| **Payments** | One row per client per month, generated from the retainer. Record payments in one click; Stripe payments are recorded automatically |
| **Tasks** | Board (to do / in progress / review / done), filtered by client. Agents add tasks too |
| **Client health** | Weekly traffic light per client, scored from the numbers (CPL vs target, lead volume vs the previous 4 weeks, creative fatigue, GHL leads untouched over 24h) with the reason for each, and a 6-week history |
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
| Inbox | On demand | Sorts Gmail by client, creates tasks, notes each client's emails on their page; replies wait in Approvals |
| Call prep | On demand, or "Prep for call" on a client | A brief on the client page before each call, with every lead by name |
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

1. **Import the repo:** go to [vercel.com/new](https://vercel.com/new), find **1media2027** under "Import Git Repository" (connect GitHub if asked), and click **Import**.
2. **Add a password:** before clicking Deploy, open **Environment Variables** and add:
   - `ADMIN_PASSWORD`: your dashboard login.
   - `CRON_SECRET`: any long random string.
   - `ANTHROPIC_API_KEY`: for the agents.
   Then click **Deploy**.
3. **Add the database:** in the new project, go to **Storage → Create Database → Neon → Create → Connect**, then **Deployments → ⋯ → Redeploy**. The tables are created automatically during the build.
4. Open the site and log in with `ADMIN_PASSWORD`.

**Optional, any time later** (Settings → Environment Variables, then redeploy):
- `COMPOSIO_API_KEY` connects Gmail, Calendar, Meta Ads, GoHighLevel and Stripe for the agents. After adding it, run `npm run connect` and open each login link.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` record Stripe payments automatically. In Stripe → Developers → Webhooks, add the endpoint `https://<your-app>.vercel.app/api/webhooks/stripe` with the event `invoice.paid`.
- `SLACK_WEBHOOK_URL` sends agent summaries and approval alerts to Slack.
- **Jarvis in Slack** (`/jarvis <question>` and Approve / Reject buttons on approval alerts): create a Slack app from `docs/slack-app-manifest.yml` (replace `YOUR-APP` with the site's domain), install it to the workspace and pick the alerts channel. Then set `SLACK_SIGNING_SECRET` (Basic Information → Signing Secret), `SLACK_WEBHOOK_URL` (Incoming Webhooks, from this app so the buttons work) and `SLACK_ALLOWED_USER_IDS` (who may ask and approve). Questions are read-only; approvals run through the same guardrails as the Approvals page.
- `AGENTS_PAUSED=true` pauses every scheduled agent.

**Notes:**
- Cron times are UTC, so jobs run an hour later in Irish summer time.
- On Vercel's Hobby plan, crons run at most once a day and functions stop after 300 seconds. Pro is recommended.

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

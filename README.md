# 1Media OS

The operating system for 1Media: clients, cash, delivery and the AI agents that run the agency, in one web app. It deploys on Vercel.

## What's in it

| Page | What it does |
|---|---|
| **Dashboard** | Your morning brief, your tasks, your team's end-of-day status, the latest voice-note business update, then MRR, money, red/yellow clients, approvals and agent runs |
| **Tasks** | Board or list. Filter by person, client, priority, status, due date and source; quick filters for My tasks, Delegated by me, My team, Overdue. Edit and delegate any task |
| **End of day** | Each person's daily report (done, blockers, tomorrow), pre-filled from the tasks they finished, with dictation. Managers see their team's |
| **Voice notes** | Talk through the business in the browser; Claude checks it against the OS and writes a full update for your manager |
| **SOP library** | Skool-style lessons grouped into modules: Loom video, a clean breakdown written by Claude, a checklist and progress per person. Any SOP can be handed to an agent on a schedule (e.g. Monday touchpoint, monthly report) |
| **Activity log** | Everything people and agents do, filterable by person, agent, kind, date and text |
| **Team** | Accounts and the reporting line (Alex → Jamie → Ryan) |
| **Clients** | Every client with retainer, VAT, billing method, Meta ad accounts, GHL location, Stripe customer, CPL target and report rules |
| **Payments** | One row per client per month, generated from the retainer. Record payments in one click; Stripe payments are recorded automatically |
| **Client health** | Weekly traffic light per client, with a 6-week history |
| **Reports** | Weekly WhatsApp reports and month-end reports written by the agents: edit, copy, mark sent |
| **Approvals** | Anything an agent wants to send, charge or change outside the OS waits here. Approve runs it; reject drops it |
| **Agents** | Run any agent now (dry run by default) and read every run's summary and tool calls |

## Agents

| Agent | When | Does |
|---|---|---|
| Morning brief | Weekdays 06:00 | A brief for each person: their day, their team's EODs and blockers, what needs attention |
| Finance | Weekdays 08:00 | Matches Stripe payments to retainers, flags overdue clients, drafts chasers, sends a Friday cash summary |
| Weekly reports | Mondays 07:00 | Every client's WhatsApp report from Meta Ads, leads and tasks |
| Month-end reports | 1st, 09:00 | One executive report per client from the month's data |
| Client health | Weekdays 08:30 | CPL against target, lead volume, creative fatigue, leads left untouched in GHL |
| Inbox | On demand | Sorts Gmail by client, drafts replies, creates tasks |
| Call prep | On demand | A brief before each client call, with every lead by name |
| Onboarding | On demand | The Signed-to-Scaling set-up plan for a new client |
| Sales | On demand | Prospect follow-ups and discovery-call prep |
| Ask Jarvis | On demand | Answers any question about the agency. Read-only |

Two more run behind the scenes: **SOP agents** (any SOP in the library with automation on, started daily at 06:30 on the days it's scheduled, once per client if set) and the **voice-note update** (runs when someone sends a voice note).

On the 1st of each month a billing job (no AI) also creates that month's payment rows. Weekdays at 17:00 a reminder goes to Slack listing anyone who hasn't sent an end-of-day report.

## Team and delegation

Everyone has their own login. Who reports to whom sets what you can do:
- You can assign or delegate tasks to yourself and anyone below you (Alex → Jamie → Ryan, so Jamie can delegate to Ryan but not to Alex). The owner can assign to anyone.
- You see your own and your team's end-of-day reports, voice notes and activity. The owner sees everything.
- Owners and managers approve agent actions. Only the owner manages the team and can give an SOP agent full autonomy.

The first time: sign in with `ADMIN_PASSWORD` (it always signs in as the owner), then go to **Team** and set passwords for Jamie and Ryan.

## Voice notes

Recording uses the browser's own speech recognition (Chrome, Edge and Safari), so there's no extra key or cost: the words appear as you talk, and you can fix them before sending. Firefox can't do this; type instead, or use a phone keyboard's mic. Audio isn't stored, only the text.

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
4. Open the site and log in with `ADMIN_PASSWORD` (name: Alex, or leave it blank). Then set the team's passwords under **Team**.

**Optional, any time later** (Settings → Environment Variables, then redeploy):
- `COMPOSIO_API_KEY` connects Gmail, Calendar, Meta Ads, GoHighLevel and Stripe for the agents. After adding it, run `npm run connect` and open each login link.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` record Stripe payments automatically. In Stripe → Developers → Webhooks, add the endpoint `https://<your-app>.vercel.app/api/webhooks/stripe` with the event `invoice.paid`.
- `SLACK_WEBHOOK_URL` sends agent summaries and approval alerts to Slack.
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
src/lib/team.ts         reporting line: who can delegate to and see whom
src/lib/activity.ts     the activity log
src/lib/sops.ts         SOP schedules, video embeds, templates
src/lib/sop-ai.ts       Claude turns a rough SOP into a clean breakdown
src/lib/billing.ts      VAT, monthly rows, payment state, totals
src/agents/             one folder per agent: settings and playbook
drizzle/                database migrations
scripts/                demo seed, Notion import, Composio connect
tests/                  unit tests
```

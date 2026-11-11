# 1Media OS: road to fully working

Status: 11 Nov 2026. Owner: Alex. This chat is the CTO session: it plans, briefs other sessions, reviews their work and merges it.
Each workstream below is written as a brief another session can pick up on its own.

## Where we are

**Works today (live at 1media2027.vercel.app, `main` auto-deploys):**
- Next.js app on Vercel (Paris region), Supabase Postgres (Paris), tables created on every deploy.
- Pages: Home (Jarvis), Dashboard, Clients, Payments, Tasks, Client health, Reports, Approvals, Agents.
- 9 agents, approval queue, guardrails (hard blocks on deletes, Ads Manager edits, refunds), daily crons.
- 1Media branding, single-password login.

**Not working yet:**
- Agents can't think: no `ANTHROPIC_API_KEY`.
- Agents can't see Gmail, Meta Ads, GHL, Stripe or Slack: no Composio account connected.
- The database is empty: Notion data not imported.
- Clicking any agent run opens a missing page (`/agents/runs/[id]`).
- Jarvis answers land on the Agents page, not where you asked.
- One shared password; no per-person logins or audit trail.
- Preview deploys use the production database (and migrate it).
- No CI: nothing runs the tests before code reaches `main`.

## What only Alex can do (blocking)

| # | Item | Why | Where |
|---|---|---|---|
| A1 | Add `ANTHROPIC_API_KEY` | Every agent and Jarvis | console.anthropic.com → Vercel env |
| A2 | Composio account + `COMPOSIO_API_KEY`, then sign in to each app | Gmail, Calendar, Drive, Meta Ads, Facebook, GHL, Stripe, Slack | dashboard.composio.dev; `npm run connect` gives login links |
| A3 | Notion integration token, shared with "Client Portals" and "Payment Collection" | Import real clients and payment history | notion.so/profile/integrations |
| A4 | Stripe webhook + keys | Payments auto-marked paid | Stripe → Developers → Webhooks |
| A5 | Slack incoming webhook (optional) | Agent summaries and approval alerts | Slack app settings |
| A6 | Decide Vercel plan | Hobby stops functions at 300s; weekly reports for all clients may exceed that | Vercel billing |
| A7 | Say who needs a login (e.g. Jamie) and what they may see | Workstream W3 | Tell the CTO chat |

## Workstreams (handed to other sessions)

Order = priority. Each ships as a pull request into `main`; the CTO chat reviews and merges.

### W1. Make agents usable  · P0, ~1 day
- Build `/agents/runs/[id]`: summary, every tool call with input/output, approvals raised, tokens, errors.
- Jarvis answers inline: asking on Home shows a thinking state, then the answer on the same page (stream or poll the run), with history of recent questions.
- Agent run failures notify (Slack when configured, and a red item in the Home action inbox).
- Done when: ask Jarvis on Home, see the answer there; every run link opens a detail page.

### W2. Real data in  · P0, ~1 day (needs A3)
- Run and harden `scripts/import-notion.ts` against the real Notion OS: dedupe the three client lists, map payment history Sep–Nov, report what didn't map.
- Client set-up checklist on each client page (Meta ad account IDs, GHL location, Stripe customer, CPL target, report rules) so missing config is obvious.
- Done when: real clients and payment history show in the app and the import report lists nothing unexplained.

### W3. Team logins and safety  · P1, ~2 days (needs A7)
- Replace the shared password with per-person sign-in (email magic link via Supabase Auth, or Google sign-in limited to @1media.ie).
- Roles: owner (everything), team (no payments/finance), and an audit log of who approved what.
- Separate preview database (Supabase branch or second project) so previews never touch production; enable RLS on all tables as a backstop.
- Done when: Alex and Jamie sign in as themselves; approvals show who approved; a preview deploy can't change production data.

### W4. Engineering hygiene  · P1, ~0.5 day
- GitHub Actions: typecheck, tests and build on every PR; block merge on failure.
- Error monitoring (Sentry or Vercel's built-in) with alerts.
- Playwright smoke test of login → Home → each page against a seeded database.
- Daily database backup check (Supabase Pro has daily backups; on free tier, a nightly `pg_dump` to Drive).
- Done when: a broken PR shows red before merge, and an error on the live site alerts within minutes.

### W5. Money loop live  · P1, ~2 days (needs A2, A4)
- Finance agent end-to-end on real data: Stripe payments reconcile automatically, overdue chasers drafted for approval, Friday cash summary.
- Revolut/AIB payments: record from a bank CSV upload, matched to retainers.
- Done when: this month's payments page matches the bank, and overdue chasers wait in Approvals.

### W6. Reporting loop live  · P1, ~3 days (needs A2)
- Weekly report agent on real Meta Ads + GHL data for every client; per-client runs so one slow account can't time out the rest.
- Month-end report as a PDF in each client's Drive folder.
- Send step: copy-to-WhatsApp stays manual for now; decide later on the WhatsApp Business API.
- Done when: Monday 07:00 produces a draft for every active client, ready to review in Reports.

### W7. Health, inbox, calls  · P2 (needs A2)
- Client health from real CPL, lead volume, creative fatigue, untouched GHL leads.
- Inbox triage and call-prep briefs before each calendar call.
- Jarvis in Slack (ask and approve from Slack).

### W8. Growth and product  · P3 (Q2–H2 2027)
- Onboarding agent + GHL snapshot; Sales agent.
- Client-facing portal (each client sees their own live numbers).
- Custom domain, e.g. os.1media.ie.

## How we run it
- One session per workstream, each on its own branch, each ending in a PR to `main`.
- The CTO chat writes the brief, checks the PR (tests, preview deploy, screenshots) and merges.
- `main` deploys to production automatically.

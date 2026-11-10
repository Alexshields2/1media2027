# 1Media OS 2027: AI-Native Agency Blueprint

Status: v0.2 (10 Nov 2026). Built: see README.md. The OS now runs as its own web app on Vercel with its own Postgres database; Notion is no longer the source of truth (a read-only import script brings existing data across).
Source: mapped from Notion "1Media Operating System 2.0" (SOPs, databases, prompts)

---

## 1. Where we are today (OS 2.0)

**Business:** revenue infrastructure for Irish home-improvement companies. Paid Meta lead-gen, GoHighLevel CRM builds, websites, reporting. A portfolio of retainer clients, plus an AI product line already sold ("AI" retainer). Current figures live in Notion, not here.

**What runs on Notion now:**

| Area | Notion asset | How it works today |
|---|---|---|
| Clients | Client Portals DB, Client Data Base For Monthly Reports, Sales CRM | 3 overlapping client lists |
| Money | Payment Collection DB (+ Expense DB in Owner View) | Logged by hand: tick Paid, type amount |
| Delivery | Tasks Tracker, Projects - Client Portal, Meeting Notes | Manual |
| Health | Client Traffic Light Tracker | Manual weekly G/Y/R |
| Reporting | Weekly Reports Log, Month-End Client Reports | Claude prompt + Chrome + CSV zip uploads, Jamie copies to WhatsApp |
| Playbooks | Onboarding SOP, Weekly Report SOP, Monthly Report prompt, KPI page | Text, run by a human |

**Where it breaks:**

1. **The payment log is stale.** From September on, almost no row has `Paid` ticked and most `Amount Collected` cells are blank. Either the log hasn't been updated or real money is outstanding. You can't tell which, and that's the problem.
2. **Config lives in prompts, not data.** Ad account IDs, client rules, and CPL targets are hardcoded in the weekly report prompt and the KPI page. Every new client means editing prompts.
3. **Reporting is browser-driven.** It reads Ads Manager through Chrome and needs CSV zips uploaded by hand. That's fragile and slow.
4. **Clients are duplicated** across three databases.
5. **Nothing runs on its own.** Every "automation" needs someone to paste a prompt.

---

## 2. Target architecture (OS 2027)

```
             ┌──────────────────────────────────────────────┐
             │ JARVIS: owner/team interface                 │
             │ (Slack or Claude chat: ask, approve, command)│
             └───────────────────────┬──────────────────────┘
                                     │
   ┌─────────────────────────────────┼─────────────────────────────────┐
   │ AGENT LAYER (Claude Agent SDK, scheduled + event triggered)       │
   │ Finance · Reporting · Client Health · Inbox · Meetings ·          │
   │ Onboarding · Sales · Creative                                     │
   └─────────────────────────────────┬─────────────────────────────────┘
                                     │ tool calls
   ┌─────────────────────────────────┼─────────────────────────────────┐
   │ COMPOSIO: managed OAuth + tools for every external app            │
   │ Gmail · Calendar · Drive/Sheets · Notion · Meta Ads · Facebook ·  │
   │ HighLevel · Stripe · WhatsApp · Slack                             │
   └─────────────────────────────────┬─────────────────────────────────┘
                                     │
   ┌─────────────────────────────────┴─────────────────────────────────┐
   │ DATA SPINE: Notion stays the single source of truth               │
   │ Clients (one DB) · Payments · Tasks · Health · Reports · SOPs     │
   └───────────────────────────────────────────────────────────────────┘
```

**Principle:** agents read and write Notion; Composio is how they touch everything else; humans approve anything that goes to a client or moves money, until each agent has earned autonomy.

---

## 3. Composio: what to plug in, and why

Composio gives the agents managed OAuth and ready-made tools for each app. You connect an account once, and every agent can use it without us writing API code.

| Toolkit | Composio slug | Used for | Replaces |
|---|---|---|---|
| **Gmail** | `gmail` | Triage inbox, label by client, draft replies, send invoice chasers, pull receipts into Expenses | Manual inbox |
| **Google Calendar** | `googlecalendar` | Mon/Wed/Fri client call prep, booking, meeting → notes link | Manual prep |
| **Google Drive / Sheets / Docs** | `googledrive`, `googlesheets`, `googledocs` | Client tracker sheets (SOP step 3), goal docs, PDF month-end reports | Manual sheet builds |
| **Notion** | `notion` | Read/write every OS database | (spine) |
| **Meta Ads** | `metaads` | Spend, leads, CPL, impressions, link clicks per account; creative performance | Chrome browsing of Ads Manager |
| **Facebook** | `facebook` | Lead form leads, Pages, ad accounts, business assets | CSV zip downloads |
| **HighLevel** | `highlevel` / `highlevel_location` | Contacts, pipeline stages, conversations, workflows per client sub-account. Shows whether clients actually work their leads. | Checking GHL by hand |
| **Stripe** | `stripe` | Invoices, payment links, payment status, then auto-reconcile Payment Collection | Manual tick-boxes |
| **WhatsApp** | `whatsapp` | New-lead alerts, 1:1 nudges (see caveat below) | n/a |
| **Slack** | `slack` | Jarvis interface, approvals, alerts (Client Portals already has a Slack Channel field) | n/a |
| Optional | `canva`, others | Creative variants when the Health agent flags fatigue | Manual |

**Gaps to check before relying on them:**

- **WhatsApp groups:** you report into client WhatsApp groups. The WhatsApp Business API is built for 1:1 messaging and generally can't post into normal groups. Plan: agents draft, and a human pastes into the group (as now). Alternatively, move reports to 1:1 or email, or send through GHL's WhatsApp channel.
- **Revolut / AIB / cash payments:** no confirmed Composio toolkit. Options: (a) move every retainer to Stripe invoicing or subscriptions (recommended); (b) Revolut Business API directly; (c) weekly bank CSV export → agent reconciles.
- **Accounting (Xero / QuickBooks?):** unknown what you use. If either, Composio has toolkits for both, so we'd add one.
- **HighLevel permissions:** some Meta and ad actions need extra scopes (e.g. `adPublishing`) on the location token.
- Check action lists and auth on each toolkit page before building. Composio's catalogue changes often.

---

## 4. The agents

Each agent is a folder in this repo with: a system prompt (lifted from your existing Notion SOPs), a tool allowlist, a trigger, and an autonomy level.

**Autonomy ladder:** `L0 read-only` → `L1 drafts for approval` → `L2 acts internally (Notion/GHL), drafts external` → `L3 acts externally within rules`.

### A. Finance agent ("Collections")  · *priority 1*
- **Triggers:** daily 8am; Stripe `invoice.paid` webhook; 1st of month.
- **Does:**
  - Reconciles Stripe payments into Payment Collection (ticks Paid, fills Amount Collected and Date Paid).
  - On the 1st, creates and sends invoices for each retainer.
  - Sends chaser emails at day 3, 7 and 14 overdue (drafted for approval at first).
  - Sends a Friday cash summary: collected, outstanding, late.
  - Pulls receipts from Gmail into the Expense DB.
- **Tools:** Stripe, Notion, Gmail, Slack.
- **Start at:** L2 (Notion writes); chasers at L1.
- **First job:** clean up Sep–Nov 2026, then confirm against the bank what was actually paid.

### B. Weekly Reporting agent  · *priority 1*
- **Trigger:** Monday 7am.
- **Does:** your existing Weekly Report SOP, but data comes from the Meta Ads API (not Chrome) and leads from Facebook Lead Ads / HighLevel (not CSV zips). Notion tasks give the completed and outstanding lists. Client-specific rules come from the Clients DB, not the prompt. It writes the Weekly Reports Log entry and posts each draft to Slack or Notion for Jamie to approve and paste.
- **Tools:** Meta Ads, Facebook, HighLevel, Notion, Slack.
- **Level:** L1 (same rule you have today: never message clients).

### C. Month-End Report agent
- **Trigger:** 1st of month, after the last weekly run.
- **Does:** your existing monthly prompt, run on the Weekly Reports Log, producing a PDF in each client's Drive folder plus a completion summary.
- **Tools:** Notion, Google Drive/Docs.
- **Level:** L1.

### D. Client Health agent (Traffic Light)  · *priority 2*
- **Trigger:** daily.
- **Does:**
  - Compares CPL against each client's KPI target (from the KPI page, moved into the DB).
  - Watches lead volume trend and creative frequency/fatigue.
  - **Checks GHL pipeline movement: are leads being called and moved?**
  - Auto-writes the weekly G/Y/R row with Issue, Reason and Action Needed, and alerts on Red.
- **Tools:** Meta Ads, HighLevel, Notion, Slack.
- **Level:** L2.

### E. Inbox agent
- **Trigger:** every 30 min.
- **Does:** labels mail by client, drafts replies in house style, turns requests into Tasks Tracker items linked to the client, flags anything urgent.
- **Tools:** Gmail, Notion, Slack.
- **Level:** L1 → L2.

### F. Meetings & Call-Prep agent
- **Trigger:** before each Mon/Wed/Fri client call; after each meeting.
- **Does:**
  - Before the call: a one-page brief with this week's numbers, each lead by name with its GHL stage (per your SOP: go through every lead by name), and open tasks.
  - After the call: notes → action items in Tasks Tracker.
- **Tools:** Calendar, HighLevel, Meta Ads, Notion.
- **Level:** L2.

### G. Onboarding agent  · *priority 3*
- **Trigger:** contract signed and deposit paid (GHL Documents or Stripe).
- **Does:** runs SOP steps 1–4 automatically:
  - Creates the Notion client portal from the template and the Drive folder.
  - Builds the goal doc and Revenue Goal Breakdown.
  - Creates the tracker Sheet.
  - Generates the full onboarding task list in Tasks Tracker.
  - Sets up the GHL sub-account from a snapshot.
  - Creates the Payment Collection rows.
  - Drafts the welcome message.
- **Tools:** Notion, Drive, Sheets, HighLevel, Stripe, Gmail.
- **Level:** L2.

### H. Sales agent
- **Trigger:** daily, and on new CRM entries.
- **Does:** researches prospects (Irish home-improvement firms), enriches the Sales CRM, drafts cold emails and follow-ups, preps discovery calls booked through the GHL booking link, and tracks the cold-calling tracker.
- **Tools:** Notion, Gmail, Calendar, HighLevel, web search.
- **Level:** L1.

### I. Creative agent (later)
- **Trigger:** the Health agent flags "Creative Fatigue".
- **Does:** writes new ad angles and copy, and builds static variants in Canva for approval.
- **Level:** L1.

### Jarvis (orchestrator)
The one interface (Slack DM or Claude). It answers questions like "what's outstanding?", "how's <client> this week?", and "onboard X". It routes the work to the agents above and holds the approval queue. Your SOPs already say "Jarvis context", so this formalises that.

---

## 5. Data-spine fixes (do these first)

Agents are only as good as the data. Before building:

1. **One Clients DB.** Merge Client Portals, Client Data Base For Monthly Reports and the client side of Sales CRM. Add fields:
   - `Meta Ad Account IDs`, `GHL Location ID`, `Stripe Customer ID`
   - `CPL Target` (from the KPI page), `Retainer ex VAT`, `VAT treatment`, `Billing method`
   - `Report Rules` (the client-specific lines from SOP section 7), `Report Greeting`, `Currency`
   - `WhatsApp Group`, `Slack Channel`, `Drive Folder`, `Account Manager`, `Active` (checkbox)
2. **Payment Collection:** make `Paid` a formula (`Amount Collected >= Amount Due`) instead of a manual tick, and add `Stripe Invoice ID`.
3. **Tasks Tracker:** require the `Client` relation; add `Source` (agent / human) and `Created by agent` so agent work can be audited.
4. **Weekly Reports Log:** add numeric fields (Leads, Spend, CPL, Impressions, Clicks) so month-end and health trends compute from data, not prose.
5. **Agent Run Log** (new DB): every agent run records what it read, what it changed, and what it is waiting on for approval.

---

## 6. Repo layout (this repo)

```
1media2027/
  BLUEPRINT.md            ← this file
  agents/
    finance/              prompt.md · tools.yaml · schedule
    weekly-report/
    month-end-report/
    client-health/
    inbox/
    meetings/
    onboarding/
    sales/
    jarvis/
  lib/
    composio.ts           connect + tool loading per agent
    notion-schema.ts      typed IDs for every OS database
    approvals.ts          Slack approval queue
  config/
    clients.example.yaml  (real config lives in Notion, not git)
  .github/workflows/      cron triggers (or Claude scheduled tasks)
```

**Stack:**
- Language: TypeScript (or Python).
- Agents: Claude Agent SDK.
- Tools: Composio SDK.
- Triggers: GitHub Actions cron or Claude Code scheduled tasks for schedules; Composio triggers and Stripe webhooks for events.

**Secrets:** API keys live in the runner's secret store. No client data or ad account IDs go in git.

---

## 7. Roadmap

| Phase | When | Ship | Outcome |
|---|---|---|---|
| **0. Foundations** | Nov–Dec 2026 | Merge Clients DB; reconcile Sep–Nov payments; move config out of prompts; Composio account; connect Gmail, Calendar, Notion, Meta Ads, Facebook, HighLevel, Stripe, Slack | Clean data, all tools connected |
| **1. Money + Reporting** | Jan 2027 | Finance agent, Weekly Report agent, Month-End agent | Monday reporting drops from hours to a review; every euro accounted for |
| **2. Visibility** | Feb–Mar 2027 | Client Health agent, Inbox agent, Call-Prep agent, Jarvis v1 in Slack | Red clients caught early; no lead ignored by clients |
| **3. Growth** | Q2 2027 | Onboarding agent + GHL snapshot, Sales agent | New client live in days with no manual setup; pipeline filled |
| **4. Productise** | H2 2027 | Live client dashboards, Creative agent; package the AI agents as a client offer (extends the existing AI retainer) | AI becomes something you sell, not just how you operate |

**North-star metrics for 2027:**
- MRR
- Revenue per head
- Hours/week on reporting (target: under 1)
- Days to onboard (target: 3 or fewer)
- Overdue receivables (target: €0 over 14 days)
- % clients Green

---

## 8. Open questions (needed before Phase 1)

1. Accounting tool: Xero, QuickBooks, or a bookkeeper with spreadsheets?
2. Can all retainers move to Stripe (invoice or subscription)? Today they're spread across Invoice, Stripe, Revolut, AIB and cash.
3. WhatsApp: keep human copy-paste into groups, or switch reports to email / 1:1?
4. Who approves what? (Alex = money and new clients, Jamie = client comms?)
5. Slack or Claude as Jarvis's home?
6. One GHL agency account covering all client sub-accounts (needed for `highlevel_agency`)?

# 1Media OS 2027

The AI layer for 1Media's agency operations. Notion stays the source of truth. [Composio](https://composio.dev) connects the agents to Gmail, Calendar, Drive, Notion, Meta Ads, HighLevel, Stripe and Slack. Claude does the work.

The plan, the agents and the roadmap are in **[BLUEPRINT.md](BLUEPRINT.md)**.

## Structure

```
src/
  cli.ts                 npm run agent -- <agent>
  config.ts              env + model
  lib/
    runner.ts            the agent loop: Claude ↔ Composio tools, with guardrails
    guardrails.ts        autonomy levels L0–L3 and hard blocks
    composio.ts          Composio client + toolkit list
    notion.ts            IDs of every OS database in Notion
    runlog.ts            audit trail of every run (runs/)
  agents/
    house-rules.md       rules every agent follows
    registry.ts
    <agent>/index.ts     tools, autonomy, schedule, task
    <agent>/prompt.md    the agent's playbook (from the Notion SOPs)
scripts/connect.ts       connect 1Media's accounts to Composio
.github/workflows/       scheduled runs (off until switched on)
```

## Agents

| Agent | Autonomy | When | Does |
|---|---|---|---|
| `finance` | L2 | Weekdays 08:00 | Reconciles Stripe into Payment Collection, flags overdue, drafts chasers, Friday cash summary |
| `weekly-report` | L1 | Mon 07:00 | Every client's WhatsApp report from Meta Ads, leads and Notion tasks |
| `month-end-report` | L2 | 1st, 09:00 | Monthly executive report per client from the weekly log |
| `client-health` | L2 | Weekdays 08:30 | Traffic light: CPL against target, volume, fatigue, leads untouched in GHL |
| `inbox` | L2 | Every 30 min | Labels, drafts replies, creates tasks, files receipts |
| `meetings` | L2 | Mon/Wed/Fri 07:00 | Call-prep briefs (every lead by name); meeting notes into tasks |
| `onboarding` | L2 | On demand | Signed-to-Scaling SOP set-up for a new client |
| `sales` | L1 | Weekdays 09:00 | CRM follow-ups and discovery-call prep |
| `jarvis` | L0 | On demand | Ask anything about the agency |

**Autonomy levels:**
- **L0**: read-only.
- **L1**: every write is proposed for approval.
- **L2**: internal writes (Notion, GHL, Drive) run; anything that reaches a client or moves money is proposed.
- **L3**: everything runs.

**Always blocked, at every level:**
- Deleting anything
- Any change in Ads Manager
- Stripe refunds and payouts

**Sending an email always needs approval.** Agents only create Gmail drafts.

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Then put your `ANTHROPIC_API_KEY` and `COMPOSIO_API_KEY` in `.env`.

```bash
npm run connect
```

That prints a login link for each app. Open each one and log in with the 1Media account.

## Run

```bash
npm run agent -- list
```

```bash
npm run agent -- finance --dry-run
```

```bash
npm run agent -- jarvis "What's outstanding this month?"
```

```bash
npm run agent -- onboarding "New client: Acme Roofing, €1,500 + VAT, starts 1 Dec, contact Mark mark@acme.ie"
```

`--dry-run` forces read-only, so start every agent there. Each run prints a summary and the actions waiting for approval, and saves a full log to `runs/`.

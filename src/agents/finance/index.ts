import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const finance: AgentDefinition = {
  name: "finance",
  title: "Finance",
  description: "Matches Stripe payments to retainers, flags overdue clients, drafts chasers, and sends a Friday cash summary.",
  prompt,
  autonomy: "L2",
  toolkits: ["stripe", "gmail"],
  schedule: "0 8 * * 1-5",
  scheduleLabel: "Weekdays 08:00",
  effort: "high",
  maxTurns: 40,
  task: ({ today }) => `Today is ${today}. Run the daily finance check:
1. List outstanding payments.
2. For clients with a Stripe customer ID, check Stripe for payments and paid invoices, and record any that cover an outstanding row.
3. List what's still outstanding, grouped by client, with days overdue.
4. Draft chaser emails (Gmail drafts) for rows 3, 7 or 14+ days overdue.
5. If today is Friday, add the weekly cash summary: collected this week, collected this month, outstanding, and the three largest overdue amounts.`,
};

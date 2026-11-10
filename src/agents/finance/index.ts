import type { AgentDefinition } from "../types.js";

export const finance: AgentDefinition = {
  name: "finance",
  description: "Reconciles payments into Notion, flags overdue retainers, drafts chasers and the weekly cash summary.",
  autonomy: "L2", // Notion updates run; emails and Stripe invoices are proposed
  toolkits: ["notion", "stripe", "gmail"],
  schedule: "0 8 * * 1-5", // weekdays 08:00
  effort: "high",
  maxTurns: 40,
  task: ({ today }) => `Today is ${today}. Run the daily finance check:
1. Read every Payment Collection row due on or before today that is not fully collected.
2. Match them against Stripe payments and invoices. For each confirmed payment, update the row: Amount Collected, Date Paid, Method = Stripe.
3. List anything still outstanding, grouped by client, with days overdue.
4. For anything 3, 7 or 14+ days overdue, draft the chaser email (Gmail draft) to the client's billing email from the Client Portals database.
5. If today is Friday, finish with the weekly cash summary: collected this week, collected this month, outstanding, and the three largest overdue amounts.`,
};

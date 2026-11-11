import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const finance: AgentDefinition = {
  name: "finance",
  title: "Finance",
  description: "Flags overdue clients by age, queues chasers for approval, and saves a Friday cash summary (posted to Slack when configured). Stripe and bank payments reconcile on the Payments page.",
  prompt,
  autonomy: "L2",
  toolkits: ["stripe", "gmail"],
  osTools: ["OS_LIST_CLIENTS", "OS_LIST_PAYMENTS", "OS_GET_RECEIVABLES", "OS_RECORD_PAYMENT", "OS_QUEUE_CHASER", "OS_SAVE_CASH_SUMMARY", "OS_CREATE_TASK"],
  schedule: "0 8 * * 1-5",
  scheduleLabel: "Weekdays 08:00",
  effort: "high",
  maxTurns: 40,
  task: ({ today }) => {
    const friday = new Date(`${today}T12:00:00Z`).getUTCDay() === 5;
    return `Today is ${today}${friday ? " (Friday)" : ""}. Run the daily finance check:
1. Call OS_GET_RECEIVABLES.
2. If Stripe is connected, check for paid invoices from clients with a Stripe customer ID that still show as owed, and record any the webhook missed (with proof).
3. For every client with chaserDue set, queue one chaser with OS_QUEUE_CHASER.
4. List unmatched payments waiting for the owner, and anything that needs manual confirmation.${
      friday ? "\n5. It's Friday: call OS_SAVE_CASH_SUMMARY with a two or three sentence commentary on what needs attention." : ""
    }`;
  },
};

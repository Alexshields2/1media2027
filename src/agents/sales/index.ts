import type { AgentDefinition } from "../types.js";

export const sales: AgentDefinition = {
  name: "sales",
  description: "Works the Sales CRM: researches prospects, drafts outreach and follow-ups, preps discovery calls.",
  autonomy: "L1",
  toolkits: ["notion", "gmail", "googlecalendar"],
  schedule: "0 9 * * 1-5",
  effort: "medium",
  maxTurns: 40,
  task: ({ today }) => `Today is ${today}.
1. In the Sales CRM, find prospects due a follow-up (no touch in 3+ days, not Won or Lost) and draft the next message for each.
2. Find discovery calls in Calendar for the next 2 days, and write a short prep note for each (who they are, what they do, likely pain, the 1Media pitch angle).`,
};

import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const sales: AgentDefinition = {
  name: "sales",
  title: "Sales",
  description: "Drafts prospect follow-ups from Gmail and preps upcoming discovery calls.",
  prompt,
  autonomy: "L1",
  toolkits: ["gmail", "googlecalendar"],
  osTools: ["OS_LIST_REPORTS", "OS_CREATE_TASK"],
  allow: ["OS_CREATE_TASK"],
  effort: "medium",
  maxTurns: 40,
  task: ({ today }) => `Today is ${today}.
1. In Gmail, find prospect threads where we sent the last message 3+ days ago with no reply, and draft the next follow-up for each.
2. Find discovery calls in Calendar for the next 2 days, and create a prep task for each (who they are, what they do, likely pain, the 1Media angle).`,
};

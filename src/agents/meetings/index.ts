import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const meetings: AgentDefinition = {
  name: "meetings",
  title: "Call prep",
  description: "Writes a one-page brief on the client page before each client call, with every recent lead by name and where it stands.",
  prompt,
  autonomy: "L2",
  toolkits: ["googlecalendar", "highlevel", "metaads"],
  // Call prep only reads outside the OS: no calendar invites, no messages to leads.
  excludeTools: [/SEND/, /^HIGHLEVEL_.*(CREATE|UPDATE|ADD|REMOVE)/, /^GOOGLECALENDAR_.*(CREATE|UPDATE|PATCH|QUICK_ADD|MOVE)/],
  osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_LIST_HEALTH", "OS_LIST_REPORTS", "OS_LIST_BRIEFS", "OS_SAVE_BRIEF", "OS_CREATE_TASK"],
  effort: "medium",
  maxTurns: 60,
  task: ({ today, instruction }) =>
    instruction
      ? `Today is ${today}. Prep the client call described below and save the brief.`
      : `Today is ${today}. Find today's client calls in Google Calendar and write a call-prep brief for each.`,
};

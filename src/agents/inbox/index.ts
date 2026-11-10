import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const inbox: AgentDefinition = {
  name: "inbox",
  title: "Inbox",
  description: "Sorts Gmail by client, drafts replies, and turns client requests into tasks.",
  prompt,
  autonomy: "L2",
  toolkits: ["gmail"],
  osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_CREATE_TASK"],
  effort: "medium",
  maxTurns: 40,
  task: ({ today }) =>
    `Today is ${today}. Process unread inbox email from the last 24 hours that doesn't have the "1M/Processed" label yet. Add "1M/Processed" to each email when you're done with it.`,
};

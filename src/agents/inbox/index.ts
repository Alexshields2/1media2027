import type { AgentDefinition } from "../types.js";

export const inbox: AgentDefinition = {
  name: "inbox",
  description: "Triages Gmail: labels by client, drafts replies, turns requests into Notion tasks, files receipts.",
  autonomy: "L2", // labels, drafts and Notion tasks run; sending is proposed
  toolkits: ["gmail", "notion"],
  schedule: "*/30 8-19 * * 1-5", // every 30 min in working hours
  effort: "medium",
  maxTurns: 40,
  task: ({ today }) => `Today is ${today}. Process unread email in the inbox from the last 24 hours that you haven't labelled "1M/Processed" yet. When done with each email, add the "1M/Processed" label.`,
};

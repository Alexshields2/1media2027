import type { AgentDefinition } from "../types.js";

export const jarvis: AgentDefinition = {
  name: "jarvis",
  description: "Ask anything about the agency: clients, money, tasks, performance. Read-only for now.",
  autonomy: "L0",
  toolkits: ["notion", "metaads", "highlevel", "stripe", "gmail", "googlecalendar"],
  effort: "medium",
  maxTurns: 30,
  // On demand: npm run agent -- jarvis "What's outstanding this month?"
  task: ({ today }) => `Today is ${today}. Answer the question in the extra instruction below.`,
};

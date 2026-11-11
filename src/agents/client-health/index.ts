import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const clientHealth: AgentDefinition = {
  name: "client-health",
  title: "Client health",
  description: "Traffic light for every client from the numbers: CPL against target, lead volume against the previous 4 weeks, creative fatigue, and leads left untouched in GHL over 24h.",
  prompt,
  autonomy: "L2",
  toolkits: ["metaads", "highlevel"],
  // Scoring and saving go through OS_SCORE_HEALTH only, so the rules decide the colour.
  osTools: ["OS_LIST_CLIENTS", "OS_LIST_HEALTH", "OS_SCORE_HEALTH", "OS_LIST_TASKS", "OS_CREATE_TASK"],
  schedule: "30 8 * * 1-5",
  scheduleLabel: "Weekdays 08:30",
  effort: "medium",
  maxTurns: 80,
  task: ({ today }) =>
    `Today is ${today}. Gather the numbers for every active client and score each one with OS_SCORE_HEALTH. Finish with the red and yellow clients and the single most important action for each.`,
};

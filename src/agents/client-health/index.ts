import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const clientHealth: AgentDefinition = {
  name: "client-health",
  title: "Client health",
  description: "Traffic light for every client: CPL against target, lead volume, creative fatigue, and leads left untouched in GHL.",
  prompt,
  autonomy: "L2",
  toolkits: ["metaads", "highlevel"],
  schedule: "30 8 * * 1-5",
  scheduleLabel: "Weekdays 08:30",
  effort: "medium",
  maxTurns: 60,
  task: ({ today }) =>
    `Today is ${today}. Check every active client's health and save this week's traffic light for each. Finish with the red and yellow clients and the single most important action for each.`,
};

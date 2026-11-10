import type { AgentDefinition } from "../types.js";

export const clientHealth: AgentDefinition = {
  name: "client-health",
  description: "Daily traffic-light check per client: CPL against target, lead volume, creative fatigue, and whether leads are being worked in GHL.",
  autonomy: "L2", // writes Traffic Light rows; Slack alerts proposed until approvals are wired
  toolkits: ["metaads", "highlevel", "notion", "slack"],
  schedule: "30 8 * * 1-5", // weekdays 08:30
  effort: "medium",
  maxTurns: 60,
  task: ({ today }) => `Today is ${today}. Check every active client's health and log it in the Client Traffic Light Tracker for this week (Week Of = this Monday). Update this week's row if one exists; otherwise create it. Finish with the list of Red and Yellow clients and the single most important action for each.`,
};

import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const weeklyReport: AgentDefinition = {
  name: "weekly-report",
  title: "Weekly reports",
  description: "Writes every client's Monday WhatsApp report from Meta Ads, leads and tasks, ready for Jamie to copy and send.",
  prompt,
  autonomy: "L1",
  allow: ["OS_SAVE_REPORT"], // saving a draft is safe; nothing goes to a client
  toolkits: ["metaads", "facebook", "highlevel"],
  schedule: "0 7 * * 1",
  scheduleLabel: "Mondays 07:00",
  effort: "high",
  maxTurns: 80,
  task: ({ today }) =>
    `Today is ${today}. Write the weekly report for every active client with a Meta ad account, for the 7 full days before today. Save each one as a weekly report draft.`,
};

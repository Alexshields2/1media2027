import type { AgentDefinition } from "../types.js";

export const weeklyReport: AgentDefinition = {
  name: "weekly-report",
  description: "Builds every client's Monday WhatsApp report from Meta Ads, leads and Notion tasks, for Jamie to review.",
  autonomy: "L1", // drafts only: never messages a client
  toolkits: ["metaads", "facebook", "highlevel", "notion"],
  schedule: "0 7 * * 1", // Mondays 07:00
  effort: "high",
  maxTurns: 80,
  task: ({ today }) => `Today is ${today}. Write the weekly client reports for the last 7 days (the 7 full days before today; today is not included).
Cover every active client in the Client Portals database that has a Meta ad account.
Save each report as a new row in the Weekly Reports Log (it will be proposed for approval) and return all the messages in your final summary, one after another, ready to copy into WhatsApp.`,
};

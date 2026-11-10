import type { AgentDefinition } from "../types.js";

export const monthEndReport: AgentDefinition = {
  name: "month-end-report",
  description: "Combines the month's weekly reports into one executive report per active client.",
  autonomy: "L2", // writes into Notion; never sends
  toolkits: ["notion", "googledrive", "googledocs"],
  schedule: "0 9 1 * *", // 1st of the month 09:00
  effort: "high",
  maxTurns: 80,
  task: ({ today }) => `Today is ${today}. Write the month-end report for the previous calendar month for every active client, following your instructions. Write each report into that client's page in Month-End Client Reports, then set its Status to Completed.`,
};

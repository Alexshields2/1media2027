import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const monthEndReport: AgentDefinition = {
  name: "month-end-report",
  title: "Month-end reports",
  description: "Turns the month's weekly reports, tasks and health checks into one executive report per client.",
  prompt,
  autonomy: "L2",
  toolkits: [],
  schedule: "0 9 1 * *",
  scheduleLabel: "1st of the month 09:00",
  effort: "high",
  maxTurns: 80,
  task: ({ today }) => `Today is ${today}. Write the month-end report for the previous calendar month for every active client.`,
};

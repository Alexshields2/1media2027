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
  task: ({ today, client, period }) =>
    client && period
      ? `Today is ${today}. Write the month-end report for ONE client only: ${client.name} (client_id=${client.id}), for ${period.label} (${period.start} to ${period.end}).\n` +
        `Read the client's weekly reports for the month with OS_LIST_REPORTS (client_id ${client.id}, kind "weekly", period_prefix "${period.period}"); each one carries spend, leads, impressions and clicks. ` +
        `Save the report with OS_SAVE_REPORT: client_id ${client.id}, kind "monthly", period "${period.period}", with the month's totals for spend, leads, impressions and clicks. ` +
        `A PDF is made from your report automatically, so write it in the report format.`
      : `Today is ${today}. Write the month-end report for the previous calendar month for every active client.`,
};

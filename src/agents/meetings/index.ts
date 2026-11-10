import type { AgentDefinition } from "../types.js";

export const meetings: AgentDefinition = {
  name: "meetings",
  description: "Prepares a one-page brief before each client call, and turns meeting notes into tasks afterwards.",
  autonomy: "L2",
  toolkits: ["googlecalendar", "highlevel", "metaads", "notion"],
  schedule: "0 7 * * 1,3,5", // Mon, Wed, Fri 07:00, before the client calls
  effort: "medium",
  maxTurns: 60,
  task: ({ today }) => `Today is ${today}.
1. Find today's client calls in Google Calendar. For each, write a call-prep brief and save it as a page in Meeting Notes (title: "<Client> call prep <date>").
2. Find Meeting Notes from the last 3 days without linked tasks, and create Tasks Tracker items from their action items.`,
};

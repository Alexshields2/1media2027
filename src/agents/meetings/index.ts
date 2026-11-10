import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const meetings: AgentDefinition = {
  name: "meetings",
  title: "Call prep",
  description: "Writes a one-page brief before each client call, with every lead by name and where it stands.",
  prompt,
  autonomy: "L2",
  toolkits: ["googlecalendar", "highlevel", "metaads"],
  effort: "medium",
  maxTurns: 60,
  task: ({ today }) => `Today is ${today}. Find today's client calls in Google Calendar and write a call-prep brief for each.`,
};

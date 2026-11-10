import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const jarvis: AgentDefinition = {
  name: "jarvis",
  title: "Ask Jarvis",
  description: "Ask anything about the agency: money, clients, tasks, performance. Read-only.",
  prompt,
  autonomy: "L0",
  toolkits: ["metaads", "highlevel", "stripe", "gmail", "googlecalendar"],
  needsInstruction: true,
  effort: "medium",
  maxTurns: 30,
  task: ({ today }) => `Today is ${today}. Answer the question below.`,
};

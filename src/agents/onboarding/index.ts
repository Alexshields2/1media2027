import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const onboarding: AgentDefinition = {
  name: "onboarding",
  title: "Onboarding",
  description: "Creates the full set-up plan for a new client from the Signed-to-Scaling SOP: tasks, docs and the welcome email.",
  prompt,
  autonomy: "L2",
  toolkits: ["googledrive", "googlesheets", "googledocs", "gmail"],
  needsInstruction: true,
  effort: "high",
  maxTurns: 60,
  task: ({ today }) =>
    `Today is ${today}. Onboard the client named in the instruction below. If you can't find them in the client list, stop and say so.`,
};

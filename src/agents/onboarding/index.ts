import type { AgentDefinition } from "../types.js";

export const onboarding: AgentDefinition = {
  name: "onboarding",
  description: "Runs the Signed-to-Scaling SOP set-up for a new client: Notion portal, tasks, Drive, tracker sheet, payment rows.",
  autonomy: "L2",
  toolkits: ["notion", "googledrive", "googlesheets", "googledocs", "highlevel", "gmail"],
  effort: "high",
  maxTurns: 60,
  // Run on demand: npm run agent -- onboarding "New client: Acme Roofing, €1,500 + VAT, starts 1 Dec, contact Mark mark@acme.ie"
  task: ({ today }) => `Today is ${today}. Onboard the new client described in the extra instruction below, following the onboarding SOP. If key details are missing (business name, retainer, start date, contact), stop and list what you need.`,
};

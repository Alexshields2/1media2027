import type { AgentDefinition } from "./types.js";
import { finance } from "./finance/index.js";
import { weeklyReport } from "./weekly-report/index.js";
import { monthEndReport } from "./month-end-report/index.js";
import { clientHealth } from "./client-health/index.js";
import { inbox } from "./inbox/index.js";
import { meetings } from "./meetings/index.js";
import { onboarding } from "./onboarding/index.js";
import { sales } from "./sales/index.js";
import { jarvis } from "./jarvis/index.js";

export const AGENTS: Record<string, AgentDefinition> = Object.fromEntries(
  [finance, weeklyReport, monthEndReport, clientHealth, inbox, meetings, onboarding, sales, jarvis].map((a) => [a.name, a]),
);

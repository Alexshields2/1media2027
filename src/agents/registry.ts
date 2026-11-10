import type { AgentDefinition } from "./types";
import { finance } from "./finance";
import { weeklyReport } from "./weekly-report";
import { monthEndReport } from "./month-end-report";
import { clientHealth } from "./client-health";
import { inbox } from "./inbox";
import { meetings } from "./meetings";
import { onboarding } from "./onboarding";
import { sales } from "./sales";
import { jarvis } from "./jarvis";

export const AGENT_LIST: AgentDefinition[] = [finance, weeklyReport, monthEndReport, clientHealth, inbox, meetings, onboarding, sales, jarvis];

export const AGENTS: Record<string, AgentDefinition> = Object.fromEntries(AGENT_LIST.map((a) => [a.name, a]));

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
import { morningBrief } from "./morning-brief";
import { voiceUpdate } from "./voice-update";

export const AGENT_LIST: AgentDefinition[] = [morningBrief, finance, weeklyReport, monthEndReport, clientHealth, inbox, meetings, onboarding, sales, jarvis, voiceUpdate];

export const AGENTS: Record<string, AgentDefinition> = Object.fromEntries(AGENT_LIST.map((a) => [a.name, a]));

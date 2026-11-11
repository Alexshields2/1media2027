import type { Autonomy } from "../lib/guardrails";
import type { ToolkitSlug } from "../lib/composio";

export interface AgentContext {
  /** Today's date in Europe/Dublin, YYYY-MM-DD. */
  today: string;
  /** Free text from the person running it, e.g. "only one client". */
  instruction?: string;
}

export interface AgentDefinition {
  /** Folder name, URL slug and CLI name, e.g. "finance". */
  name: string;
  title: string;
  description: string;
  /** The agent's playbook. */
  prompt: string;
  /** Default autonomy. A dry run forces L0. */
  autonomy: Autonomy;
  /** Composio toolkits (external apps) this agent may use. */
  toolkits: ToolkitSlug[];
  /** Optional exact Composio tool slugs; when set, only these load. */
  tools?: string[];
  /** Composio tools this agent must never see or call (regexes on the tool slug), e.g. sending email. */
  excludeTools?: RegExp[];
  /** 1Media OS database tools this agent gets (default: all). */
  osTools?: string[];
  /** Write tools allowed to run even though autonomy would propose them. */
  allow?: string[];
  /** Cron (UTC) when scheduled in vercel.json; shown in the UI. */
  schedule?: string;
  /** Plain-English schedule for the UI. */
  scheduleLabel?: string;
  /** Agents that need an instruction to run (e.g. onboarding, jarvis). */
  needsInstruction?: boolean;
  effort: "low" | "medium" | "high" | "xhigh";
  /** Max model turns before the run stops. */
  maxTurns: number;
  /** The task message for one run. */
  task: (ctx: AgentContext) => string;
}

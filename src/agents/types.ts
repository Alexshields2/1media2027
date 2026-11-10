import type { Autonomy } from "../lib/guardrails.js";
import type { ToolkitSlug } from "../lib/composio.js";

export interface AgentContext {
  /** Today's date in Europe/Dublin, YYYY-MM-DD. */
  today: string;
  /** Free text passed on the command line, e.g. "only one client". */
  instruction?: string;
}

export interface AgentDefinition {
  /** Folder name and CLI name, e.g. "finance". */
  name: string;
  description: string;
  /** Default autonomy. --dry-run forces L0. */
  autonomy: Autonomy;
  /** Composio toolkits this agent may use. */
  toolkits: ToolkitSlug[];
  /** Optional exact tool slugs; when set, only these load (overrides toolkits). */
  tools?: string[];
  /** Write tools allowed to run even though autonomy would propose them. */
  allow?: string[];
  /** Cron in Europe/Dublin time, documentation for the scheduler. */
  schedule?: string;
  effort: "low" | "medium" | "high" | "xhigh";
  /** Max model turns before the run stops. */
  maxTurns: number;
  /** The task message for one run. */
  task: (ctx: AgentContext) => string;
}

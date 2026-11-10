import { mkdirSync, writeFileSync } from "node:fs";

// Every run leaves an audit trail: what the agent called, what it was blocked from,
// and what it proposed for approval. Written to runs/ locally for now; the plan is
// to mirror this into an "Agent Run Log" database in Notion (BLUEPRINT.md section 5).

export interface ToolEvent {
  tool: string;
  input: unknown;
  outcome: "ran" | "proposed" | "blocked" | "error";
  note?: string;
  result?: string;
}

export interface RunRecord {
  agent: string;
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  task: string;
  events: ToolEvent[];
  summary?: string;
  stopReason?: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export function newRun(agent: string, task: string, dryRun: boolean): RunRecord {
  return {
    agent,
    task,
    dryRun,
    startedAt: new Date().toISOString(),
    events: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  };
}

export function saveRun(run: RunRecord): string {
  mkdirSync("runs", { recursive: true });
  const file = `runs/${run.agent}-${run.startedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(run, null, 2));
  return file;
}

export function proposals(run: RunRecord): ToolEvent[] {
  return run.events.filter((e) => e.outcome === "proposed");
}

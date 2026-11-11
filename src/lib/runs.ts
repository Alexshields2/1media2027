import { and, desc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import { db, schema } from "../db";
import type { AgentRun } from "../db/schema";

/**
 * Runs execute in the background (`after()`), and Vercel stops a function after 300 seconds.
 * A run still "running" well past that was cut off and will never finish.
 */
export const STALE_AFTER_MS = 6 * 60 * 1000;

export type RunState = AgentRun["status"] | "stalled";

/** The run's status, with long-dead "running" rows shown as "stalled". */
export function runState(run: Pick<AgentRun, "status" | "startedAt">, now = Date.now()): RunState {
  if (run.status === "running" && now - run.startedAt.getTime() > STALE_AFTER_MS) return "stalled";
  return run.status;
}

export function runTone(state: RunState): "green" | "blue" | "red" | "yellow" {
  if (state === "completed") return "green";
  if (state === "running") return "blue";
  if (state === "error" || state === "stalled") return "red";
  return "yellow";
}

/** Runs that failed (error, or cut off while running) in the last `hours` hours, newest first. */
export async function recentFailedRuns(hours = 24, limit = 5): Promise<AgentRun[]> {
  const since = new Date(Date.now() - hours * 3600_000);
  return db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        gte(schema.agentRuns.startedAt, since),
        or(eq(schema.agentRuns.status, "error"), and(eq(schema.agentRuns.status, "running"), lt(schema.agentRuns.startedAt, new Date(Date.now() - STALE_AFTER_MS)))),
      ),
    )
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(limit);
}

/** The last few questions asked of Jarvis, newest first. */
export async function recentJarvisRuns(limit = 5): Promise<AgentRun[]> {
  return db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agent, "jarvis"), isNotNull(schema.agentRuns.instruction), inArray(schema.agentRuns.trigger, ["manual", "cli"])))
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(limit);
}

/** What the Home page polls for while Jarvis is thinking. */
export interface RunPoll {
  id: number;
  status: RunState;
  question: string | null;
  answer: string | null;
  error: string | null;
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
}

export function toPoll(run: AgentRun): RunPoll {
  const state = runState(run);
  return {
    id: run.id,
    status: state,
    question: run.instruction,
    answer: state === "completed" || state === "stopped" ? run.summary : null,
    error: state === "error" ? (run.error ?? run.summary) : state === "stalled" ? "This run was cut off before it finished (server time limit). Try asking again." : null,
    toolCalls: run.toolCalls,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

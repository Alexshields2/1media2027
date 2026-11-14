import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ToolEvent } from "@/db/schema";
import { AGENTS } from "@/agents/registry";
import { describeAction } from "@/lib/approvals";
import { runState, runTone } from "@/lib/runs";
import { Badge, Card, Empty, Notice, PageHeader, Stat, btnGhost } from "../../../_components/ui";
import { Icon } from "../../../_components/icons";
import { AutoRefresh } from "../../../_components/client-bits";
import { Markdown } from "../../../_components/markdown";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const OUTCOME_TONE: Record<ToolEvent["outcome"], string> = { ran: "green", proposed: "brand", blocked: "yellow", error: "red" };
const APPROVAL_TONE: Record<string, string> = { pending: "yellow", approved: "blue", executed: "green", rejected: "gray", failed: "red" };

const dt = (d: Date) => d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const n = (x: number) => x.toLocaleString("en-IE");

function duration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Pretty-prints JSON (or JSON inside a string); anything else is shown as-is. */
function pretty(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
  if (!run) notFound();
  const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, id)).orderBy(asc(schema.approvals.createdAt));

  const agent = AGENTS[run.agent];
  const state = runState(run);
  const events = run.events ?? [];
  const blocked = events.filter((e) => e.outcome === "blocked");
  const toolErrors = events.filter((e) => e.outcome === "error");
  const runError = run.error ?? (run.status === "error" ? run.summary?.replace(/^Error:\s*/, "") : null);
  const took = run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;
  const showSummary = run.summary && run.status !== "error";

  return (
    <>
      {state === "running" && <AutoRefresh everyMs={3000} />}
      <PageHeader
        title={`${agent?.title ?? run.agent} · run #${run.id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={runTone(state)} dot>
              {state}
            </Badge>
            <span className="capitalize">{run.trigger}</span>
            {run.dryRun && <Badge tone="gray">dry run</Badge>}
            <span className="text-muted">started {dt(run.startedAt)}</span>
          </span>
        }
        actions={
          <Link href="/agents" className={btnGhost}>
            <Icon name="chevronLeft" /> All runs
          </Link>
        }
      />

      {state === "running" && (
        <Notice tone="info">Still running. This page updates by itself.</Notice>
      )}
      {state === "stalled" && (
        <Notice tone="error" title="This run never finished">
          It was cut off (most likely the 300-second server time limit). Tool calls below are what was saved before it stopped.
        </Notice>
      )}
      {runError && (
        <Notice tone="error" title="Run failed">
          <p className="mt-0.5 break-words">{runError}</p>
        </Notice>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <Stat icon="clock" label="Duration" value={took !== null ? duration(took) : state === "running" ? "running…" : "—"} hint={run.finishedAt ? `finished ${dt(run.finishedAt)}` : undefined} />
        <Stat icon="bolt" label="Tool calls" value={n(run.toolCalls)} hint={`${run.proposed} to approve · ${run.blocked} blocked · ${run.errors} errors`} />
        <Stat icon="chart" label="Tokens in / out" value={`${n(run.inputTokens)} / ${n(run.outputTokens)}`} hint={`${n(run.cacheReadTokens)} read from cache`} />
        <Stat icon="shield" label="Autonomy" value={run.dryRun ? "L0" : (agent?.autonomy ?? "—")} hint={run.dryRun ? "dry run: read-only" : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          {run.instruction && (
            <Card title={run.agent === "jarvis" ? "Question" : "Instruction"}>
              <p className="text-sm whitespace-pre-wrap">{run.instruction}</p>
            </Card>
          )}

          <Card title={run.agent === "jarvis" ? "Answer" : "Summary"}>
            {showSummary ? <Markdown>{run.summary!}</Markdown> : <Empty>{state === "running" ? "Not finished yet." : "No summary was saved."}</Empty>}
          </Card>

          <Card title={`Tool calls (${events.length})`}>
            {events.length ? (
              <ol className="space-y-2">
                {events.map((e, i) => (
                  <li key={e.id ?? i}>
                    <details className="group rounded-xl border border-line bg-canvas/50 transition-colors hover:border-line-strong" open={e.outcome === "error"}>
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-sm">
                        <span className="num w-6 text-xs text-muted">{i + 1}</span>
                        <span className="font-mono text-[13px] break-all">{e.tool}</span>
                        <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Badge>
                        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                          {e.turn && <span>turn {e.turn}</span>}
                          {e.ms !== undefined && <span className="num">{duration(e.ms)}</span>}
                          <Icon name="chevronRight" className="size-4 transition-transform group-open:rotate-90" />
                        </span>
                      </summary>
                      <div className="space-y-3 border-t border-line px-3 py-3">
                        {e.note && <p className={`text-sm ${e.outcome === "error" ? "text-red-300" : "text-soft"}`}>{e.note}</p>}
                        <Block label="Input" text={pretty(e.input)} />
                        {e.result !== undefined && <Block label="Output" text={pretty(e.result)} />}
                        {e.result === undefined && e.outcome === "ran" && <p className="text-xs text-muted">No output saved (still running, or a run from before outputs were logged).</p>}
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty>{state === "running" ? "No tool calls yet." : "This run made no tool calls."}</Empty>
            )}
          </Card>
        </div>

        <aside className="min-w-0 space-y-6">
          <Card title={`Approvals raised (${approvals.length})`} actions={approvals.length ? <Link href="/approvals" className="text-xs text-muted hover:text-ink">Approvals →</Link> : undefined}>
            {approvals.length ? (
              <ul className="space-y-3 text-sm">
                {approvals.map((a) => (
                  <li key={a.id} className="space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words">{describeAction(a.tool, a.input)}</span>
                      <Badge tone={APPROVAL_TONE[a.status] ?? "gray"}>{a.status}</Badge>
                    </div>
                    <div className="font-mono text-xs text-muted break-all">{a.tool}</div>
                    {a.result && <p className="text-xs text-soft break-words">{a.result.slice(0, 300)}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty compact>None.</Empty>
            )}
          </Card>

          <Card title={`Blocked actions (${blocked.length})`}>
            {blocked.length ? (
              <ul className="space-y-2 text-sm">
                {blocked.map((e, i) => (
                  <li key={e.id ?? i}>
                    <div className="font-mono text-[13px] break-all">{e.tool}</div>
                    {e.note && <p className="text-xs text-amber-200/80">{e.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty compact>None.</Empty>
            )}
          </Card>

          <Card title={`Errors (${toolErrors.length + (runError ? 1 : 0)})`}>
            {toolErrors.length || runError ? (
              <ul className="space-y-2 text-sm">
                {runError && (
                  <li>
                    <div className="font-medium text-red-300">Run</div>
                    <p className="text-xs break-words text-soft">{runError}</p>
                  </li>
                )}
                {toolErrors.map((e, i) => (
                  <li key={e.id ?? i}>
                    <div className="font-mono text-[13px] break-all text-red-300">{e.tool}</div>
                    <p className="text-xs break-words text-soft">{e.note}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty compact>None.</Empty>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs whitespace-pre-wrap break-words text-soft">{text || "—"}</pre>
    </div>
  );
}

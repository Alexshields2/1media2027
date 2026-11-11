import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { AGENT_LIST } from "@/agents/registry";
import { composioEnabled } from "@/lib/composio";
import { runAgentAction } from "../actions";
import { Badge, Card, Empty, PageHeader, btn, input } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // runs started here continue in the background for up to 5 minutes

const LEVEL: Record<string, string> = {
  L0: "Read-only",
  L1: "Asks before any change",
  L2: "Updates the OS itself; asks before anything external",
  L3: "Full autonomy",
};

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ started?: string }> }) {
  const sp = await searchParams;
  const runs = await db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(25);
  const apiReady = !!process.env.ANTHROPIC_API_KEY;
  const appsReady = composioEnabled();

  return (
    <>
      <PageHeader title="Agents" subtitle="Each agent runs on its schedule, or now from here. Start with a dry run: it reads everything and changes nothing." />

      {sp.started && <div className="mb-4 rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">Started {sp.started}. It will appear under Recent runs; refresh in a minute.</div>}
      {(!apiReady || !appsReady) && (
        <div className="mb-4 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {!apiReady && <p>ANTHROPIC_API_KEY isn&rsquo;t set, so agents can&rsquo;t run yet.</p>}
          {!appsReady && <p>COMPOSIO_API_KEY isn&rsquo;t set. Agents can use the OS database only (no Gmail, Meta, GHL or Stripe).</p>}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {AGENT_LIST.map((a) => (
          <Card key={a.name} title={a.title} actions={<Badge tone="gray">{a.scheduleLabel ?? "On demand"}</Badge>}>
            <p className="text-sm text-ink/70">{a.description}</p>
            <p className="mt-2 text-xs text-ink/50">
              {LEVEL[a.autonomy]} · {a.toolkits.length ? `uses ${a.toolkits.join(", ")}` : "OS database only"}
            </p>
            <form action={runAgentAction} className="mt-3 space-y-2">
              <input type="hidden" name="agent" value={a.name} />
              {a.needsInstruction ? (
                <input name="instruction" required className={input} placeholder={a.name === "jarvis" ? "Ask a question, e.g. who owes us money?" : "Which client? e.g. Acme Roofing"} />
              ) : (
                <input name="instruction" className={input} placeholder="Optional extra instruction" />
              )}
              <div className="flex items-center gap-3">
                <SubmitButton className={btn} pendingText="Starting…">
                  Run now
                </SubmitButton>
                {a.autonomy !== "L0" && (
                  <label className="flex items-center gap-1.5 text-sm text-ink/70">
                    <input type="checkbox" name="dryRun" defaultChecked /> Dry run
                  </label>
                )}
              </div>
            </form>
          </Card>
        ))}
      </div>

      <Card title="Recent runs" className="mt-6">
        {runs.length ? (
          <ul className="divide-y divide-line/70 text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/agents/runs/${r.id}`} className="hover:underline">
                  <span className="font-medium">{r.agent}</span>
                  <span className="text-ink/50">
                    {" "}
                    · {r.startedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })} · {r.trigger}
                    {r.dryRun ? " · dry run" : ""}
                  </span>
                </Link>
                <span className="flex items-center gap-2 text-xs text-ink/50">
                  {r.toolCalls} calls{r.proposed ? ` · ${r.proposed} to approve` : ""}
                  <Badge tone={r.status === "completed" ? "green" : r.status === "running" ? "blue" : r.status === "error" ? "red" : "yellow"}>{r.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No runs yet.</Empty>
        )}
      </Card>
    </>
  );
}

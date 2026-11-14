import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { runState, runTone } from "@/lib/runs";
import { AGENT_LIST } from "@/agents/registry";
import { canRunAgent } from "@/lib/roles";
import { composioEnabled } from "@/lib/composio";
import { runAgentAction } from "../actions";
import { Badge, Card, Empty, List, Notice, PageHeader, btn, input } from "../_components/ui";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // runs started here continue in the background for up to 5 minutes

const LEVEL: Record<string, string> = {
  L0: "Read-only",
  L1: "Asks before any change",
  L2: "Updates the OS itself; asks before anything external",
  L3: "Full autonomy",
};

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ started?: string; notice?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const runs = await db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(25);
  const apiReady = !!process.env.ANTHROPIC_API_KEY;
  const appsReady = composioEnabled();

  return (
    <>
      <PageHeader title="Agents" subtitle="Each agent runs on its schedule, or now from here. Start with a dry run: it reads everything and changes nothing." />

      {sp.notice === "nokey" && (
        <Notice tone="warn">Nothing was run: add ANTHROPIC_API_KEY in Vercel (Settings → Environment Variables), then redeploy.</Notice>
      )}
      {sp.started && <Notice tone="success">Started {sp.started}. It will appear under Recent runs; refresh in a minute.</Notice>}
      {(!apiReady || !appsReady) && (
        <Notice tone="warn" title="Agents are only partly connected">
          {!apiReady && <p>ANTHROPIC_API_KEY isn&rsquo;t set, so agents can&rsquo;t run yet.</p>}
          {!appsReady && <p>COMPOSIO_API_KEY isn&rsquo;t set. Agents can use the OS database only (no Gmail, Meta, GHL or Stripe).</p>}
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {AGENT_LIST.map((a) => (
          <section key={a.name} className="surface flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-5 transition-colors hover:border-line-strong">
            <header className="flex items-start gap-3">
              <span className="brand-gradient grid size-10 shrink-0 place-items-center rounded-xl text-white shadow-[0_0_20px_rgb(4_153_242/0.3)]">
                <Icon name="spark" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-white">{a.title}</h2>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={a.scheduleLabel ? "brand" : "gray"}>
                    <Icon name="clock" className="size-3" /> {a.scheduleLabel ?? "On demand"}
                  </Badge>
                  <Badge tone={a.autonomy === "L0" ? "green" : "gray"}>{a.autonomy}</Badge>
                </div>
              </div>
            </header>
            <p className="mt-3 flex-1 text-sm text-soft">{a.description}</p>
            <p className="mt-2 text-xs text-muted">
              {LEVEL[a.autonomy]} · {a.toolkits.length ? `uses ${a.toolkits.join(", ")}` : "OS database only"}
            </p>
            {!canRunAgent(user.role, a.name) ? (
              <p className="mt-4 flex items-center gap-1.5 border-t border-line pt-4 text-xs text-muted">
                <Icon name="lock" className="size-3.5" /> Owners only: this agent works with payments.
              </p>
            ) : (
            <form action={runAgentAction} className="mt-4 space-y-3 border-t border-line pt-4">
              <input type="hidden" name="agent" value={a.name} />
              {a.needsInstruction ? (
                <input name="instruction" required aria-label={`Instruction for ${a.title}`} className={input} placeholder={a.name === "jarvis" ? "Ask a question, e.g. who owes us money?" : "Which client? e.g. Acme Roofing"} />
              ) : (
                <input name="instruction" aria-label={`Optional instruction for ${a.title}`} className={input} placeholder="Optional extra instruction" />
              )}
              <div className="flex items-center gap-3">
                <SubmitButton className={btn} pendingText="Starting…">
                  <Icon name="play" className="size-3.5" /> Run now
                </SubmitButton>
                {a.autonomy !== "L0" && (
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-soft">
                    <input type="checkbox" name="dryRun" defaultChecked /> Dry run
                  </label>
                )}
              </div>
            </form>
            )}
          </section>
        ))}
      </div>

      <Card title="Recent runs" description="Every run, with its summary and each tool call" className="mt-8">
        {runs.length ? (
          <List>
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={`/agents/runs/${r.id}`} className="group flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-white capitalize group-hover:text-brand-light">{r.agent.replaceAll("-", " ")}</span>
                    <span className="block truncate text-xs text-muted">
                      {r.startedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {r.trigger}
                      {r.dryRun ? " · dry run" : ""}
                    </span>
                  </span>
                  <span className="num text-xs text-muted">
                    {r.toolCalls} calls{r.proposed ? ` · ${r.proposed} to approve` : ""}
                  </span>
                  <Badge tone={runTone(runState(r))} dot>
                    {runState(r)}
                  </Badge>
                  <Icon name="chevronRight" className="size-4 text-muted group-hover:text-white" />
                </Link>
              </li>
            ))}
          </List>
        ) : (
          <Empty icon="spark" title="No runs yet" compact>
            Run an agent above. Start with a dry run: it reads everything and changes nothing.
          </Empty>
        )}
      </Card>
    </>
  );
}

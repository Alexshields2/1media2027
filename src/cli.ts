import "./config";
import { AGENT_LIST, AGENTS } from "./agents/registry";
import { runAgent } from "./lib/runner";
import { closeDb } from "./db";

// npm run agent -- list
// npm run agent -- <agent> [--dry-run] ["instruction"]
// npm run agent -- reports weekly|monthly [period]   one job per client, run here one after another

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (name === "reports") {
    const { enqueueReportJobs, drainJobs, currentPeriod } = await import("./lib/report-jobs");
    const { periodFor } = await import("./lib/report-metrics");
    const kind = rest[0] === "monthly" ? "monthly" : "weekly";
    const period = rest[1] ? periodFor(kind, rest[1]) : currentPeriod(kind);
    await enqueueReportJobs(kind, period);
    const jobs = await drainJobs(kind, period.period, { trigger: "cli" });
    for (const j of jobs) console.log(`client ${j.clientId}: ${j.status}${j.attempts ? ` (${j.attempts} attempt(s))` : ""}${j.lastError ? ` – ${j.lastError}` : ""}`);
    return;
  }
  if (!name || name === "list") {
    for (const a of AGENT_LIST) console.log(`${a.name.padEnd(18)} ${a.autonomy}  ${a.scheduleLabel ?? "on demand"}\n${"".padEnd(18)} ${a.description}\n`);
    return;
  }
  const agent = AGENTS[name];
  if (!agent) throw new Error(`Unknown agent "${name}". Try: npm run agent -- list`);
  const dryRun = rest.includes("--dry-run");
  const instruction = rest.filter((a) => a !== "--dry-run").join(" ") || undefined;

  console.log(`▶ ${agent.name} (${dryRun ? "dry run" : agent.autonomy})`);
  const run = await runAgent(agent, { dryRun, instruction, trigger: "cli" });
  console.log(`\n${run.summary}\n\nstatus ${run.status} · tool calls ${run.toolCalls} · proposed ${run.proposed} · blocked ${run.blocked} · errors ${run.errors} · tokens ${run.inputTokens}/${run.outputTokens}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

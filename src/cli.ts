import "./config.js";
import { AGENTS } from "./agents/registry.js";
import { runAgent } from "./lib/runner.js";
import { proposals } from "./lib/runlog.js";

// Usage:
//   npm run agent -- list
//   npm run agent -- <agent> [--dry-run] ["extra instruction"]
//   npm run agent -- finance --dry-run
//   npm run agent -- jarvis "What's outstanding this month?"

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];

  if (!name || name === "list" || name === "--help") {
    console.log("Agents:\n");
    for (const a of Object.values(AGENTS)) {
      console.log(`  ${a.name.padEnd(18)} ${a.autonomy}  ${a.schedule ?? "on demand"}\n  ${"".padEnd(18)} ${a.description}\n`);
    }
    console.log('Run: npm run agent -- <agent> [--dry-run] ["extra instruction"]');
    return;
  }

  const agent = AGENTS[name];
  if (!agent) {
    console.error(`Unknown agent "${name}". Try: npm run agent -- list`);
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const instruction = args.slice(1).filter((a) => a !== "--dry-run").join(" ") || undefined;

  console.log(`▶ ${agent.name} (${dryRun ? "dry run, read-only" : agent.autonomy})`);
  const run = await runAgent(agent, { dryRun, instruction });

  console.log("\n" + (run.summary ?? ""));
  const p = proposals(run);
  if (p.length) {
    console.log(`\n${p.length} action(s) waiting for approval:`);
    for (const e of p) console.log(`  - ${e.tool} ${JSON.stringify(e.input).slice(0, 200)}`);
  }
  const blocked = run.events.filter((e) => e.outcome === "blocked").length;
  const errors = run.events.filter((e) => e.outcome === "error").length;
  console.log(
    `\nTool calls: ${run.events.length} (blocked ${blocked}, errors ${errors}) · tokens in ${run.usage.inputTokens} / out ${run.usage.outputTokens} / cache read ${run.usage.cacheReadTokens}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

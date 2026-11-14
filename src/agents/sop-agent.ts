import type { AgentDefinition } from "./types";
import type { Sop, User } from "../db/schema";
import type { ToolkitSlug } from "../lib/composio";
import { TOOLKITS } from "../lib/composio";

const KNOWN = new Set<string>(Object.values(TOOLKITS));

/** Builds a one-off agent that follows an SOP from the library. */
export function sopAgent(sop: Sop, opts: { owner?: Pick<User, "name"> | null; client?: { id: number; name: string } | null } = {}): AgentDefinition {
  const text = sop.breakdown || sop.body || "";
  const prompt = `You carry out one of 1Media's standard operating procedures (SOPs), exactly as written.

# SOP: ${sop.title}
${sop.summary ? `\n${sop.summary}\n` : ""}
${text || "(The SOP is in the attached PDF.)"}
${sop.steps.length ? `\n## Checklist\n${sop.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

## Rules for running an SOP
- Follow the steps in order. If a step needs a tool or data you don't have, say so and carry on with the rest.
- ${opts.owner ? `${opts.owner.name} owns this SOP. Assign any tasks you create to ${opts.owner.name} unless the SOP says otherwise.` : "Assign tasks to whoever the SOP names."}
- Drafts for clients are saved as drafts (reports) or proposed for approval. Never message a client directly.
- In your final summary, go through the checklist: done, skipped (why), or needs a human.`;

  return {
    // Readable in the activity log and approvals, e.g. "SOP: Monday client touchpoint".
    name: `SOP: ${sop.title}`.slice(0, 80),
    title: `SOP: ${sop.title}`,
    description: sop.summary ?? sop.title,
    prompt,
    autonomy: sop.autonomy,
    toolkits: sop.toolkits.filter((t): t is ToolkitSlug => KNOWN.has(t)),
    allow: ["OS_SAVE_REPORT", "OS_SAVE_BRIEFING"],
    effort: "medium",
    maxTurns: 40,
    task: ({ today }) =>
      opts.client
        ? `Today is ${today}. Run this SOP for the client "${opts.client.name}" (client_id ${opts.client.id}) only.`
        : `Today is ${today}. Run this SOP now.`,
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, requireEnv } from "../config";

// Turns a rough SOP (pasted notes, a Loom transcript, an uploaded PDF) into a clean lesson:
// a one-line summary, a step-by-step breakdown and a checklist.

const Breakdown = z.object({
  summary: z.string().describe("One sentence: what this SOP achieves and when it is used."),
  breakdown: z
    .string()
    .describe(
      "Markdown. Sections: '## Purpose', '## When', '## Who', '## Tools needed', '## Steps' (numbered, one action per step, with the exact detail from the source), '## Quality check', '## Common mistakes'. Leave out a section if the source has nothing for it.",
    ),
  steps: z.array(z.string()).describe("Short checklist, 3-12 items, in order. Imperative, under 10 words each."),
});

export type SopBreakdown = z.infer<typeof Breakdown>;

const SYSTEM = `You write standard operating procedures for 1Media, an Irish agency that runs paid Meta lead generation, GoHighLevel CRM builds, websites and reporting for home-improvement companies.

Rewrite the source material into a clean SOP that a new team member could follow without asking questions.
- Keep every concrete detail from the source: names of tools, settings, numbers, time limits, who to tell.
- Never invent steps, tools or numbers that are not in the source. If something important is unclear, add it under '## Quality check' as "Confirm: ...".
- Plain Irish business English. No filler, no emojis.`;

export async function breakdownSop(input: { title: string; body?: string | null; videoUrl?: string | null; file?: { name: string; type: string; data: string } | null }): Promise<SopBreakdown> {
  requireEnv("ANTHROPIC_API_KEY");
  const client = new Anthropic();
  const content: Anthropic.ContentBlockParam[] = [];
  if (input.file?.type === "application/pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.data }, title: input.file.name });
  }
  const parts = [`SOP title: ${input.title}`];
  if (input.videoUrl) parts.push(`There is a video walkthrough (${input.videoUrl}). You cannot watch it; use the transcript or notes below.`);
  if (input.body) parts.push(`Source material:\n\n${input.body}`);
  if (!input.body && !content.length) throw new Error("Add the SOP text, a Loom transcript or a PDF first.");
  content.push({ type: "text", text: parts.join("\n\n") });

  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(Breakdown) },
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined to rewrite this SOP.");
  if (!res.parsed_output) throw new Error("Could not read the breakdown. Try again.");
  return res.parsed_output;
}

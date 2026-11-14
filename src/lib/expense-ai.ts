import Anthropic from "@anthropic-ai/sdk";
import { and, isNull, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { MODEL } from "../config";
import { CATEGORY_KEYS, EXPENSE_CATEGORIES, isCategory } from "./expense-rules";

// Optional: Claude categorises expenses that the merchant memory and built-in rules left empty.
// Only runs when ANTHROPIC_API_KEY is set. Cheap by design:
//   - one request per 150 *distinct merchants* (not per expense), with only merchant, description and amount;
//   - a fixed system prompt first, cached, so repeat batches read it from cache;
//   - low effort and structured output (a JSON list of {i, category}), so no prose is generated.
// Claude's answer never overrides the owner: it only fills rows that have no category, and it
// doesn't create merchant memory (only the owner's own choice does).

const BATCH = 150;

const SYSTEM = `You categorise business expenses for 1Media, a digital marketing agency in Ireland that runs Meta and Google ads for its clients.
Pick exactly one category key for each numbered merchant:
${EXPENSE_CATEGORIES.map((c) => `- ${c.key}: ${c.label}`).join("\n")}
Guidance: ad platforms (Meta/Facebook, Google Ads, TikTok) are "advertising"; SaaS, apps, domains and hosting are "software"; individual people paid by transfer are usually "contractors"; Revenue/ROS are "tax"; only use "transfers" for moving money between the agency's own accounts. Use "other" when unsure.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, category: { type: "string", enum: CATEGORY_KEYS } },
        required: ["i", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const aiCategoriserReady = () => !!process.env.ANTHROPIC_API_KEY;

type Create = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

export interface MerchantSample {
  key: string;
  merchant: string;
  description: string | null;
  amount: number;
}

/** One model call for up to BATCH merchants. Returns merchant key -> category. Exported for tests. */
export async function categoriseMerchants(samples: MerchantSample[], create: Create): Promise<Map<string, string>> {
  const lines = samples.map((s, i) => `${i}. ${s.merchant}${s.description ? ` | ${s.description.slice(0, 80)}` : ""} | €${s.amount.toFixed(2)}`).join("\n");
  const res = await create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Merchants:\n${lines}` }],
  });
  const out = new Map<string, string>();
  if (res.stop_reason === "refusal") return out;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) return out;
  let parsed: { items?: { i: number; category: string }[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  for (const it of parsed.items ?? []) {
    const s = samples[it.i];
    if (s && isCategory(it.category)) out.set(s.key, it.category);
  }
  return out;
}

/** Categorises uncategorised expenses with Claude. Returns how many rows got a category. */
export async function categoriseWithClaude(opts: { create?: Create; maxMerchants?: number } = {}): Promise<{ merchants: number; updated: number }> {
  const create = opts.create ?? (aiCategoriserReady() ? (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => new Anthropic().beta.messages.create(p) : null);
  if (!create) return { merchants: 0, updated: 0 };
  const rows = await db
    .select({ key: schema.expenses.merchantKey, merchant: schema.expenses.merchant, description: schema.expenses.description, amount: schema.expenses.amount })
    .from(schema.expenses)
    .where(isNull(schema.expenses.category))
    .limit(5000);
  const byKey = new Map<string, MerchantSample>();
  for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const samples = [...byKey.values()].slice(0, opts.maxMerchants ?? 600);
  let updated = 0;
  for (let i = 0; i < samples.length; i += BATCH) {
    const result = await categoriseMerchants(samples.slice(i, i + BATCH), create);
    const byCategory = new Map<string, string[]>();
    for (const [key, cat] of result) byCategory.set(cat, [...(byCategory.get(cat) ?? []), key]);
    for (const [category, keys] of byCategory) {
      const done = await db
        .update(schema.expenses)
        .set({ category, categorySource: "ai", updatedAt: new Date() })
        .where(and(isNull(schema.expenses.category), inArray(schema.expenses.merchantKey, keys)))
        .returning({ id: schema.expenses.id });
      updated += done.length;
    }
  }
  return { merchants: samples.length, updated };
}


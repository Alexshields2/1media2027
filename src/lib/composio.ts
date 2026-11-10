import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";
import { config, requireEnv } from "../config.js";

let client: Composio<AnthropicProvider> | undefined;

export function composio(): Composio<AnthropicProvider> {
  if (!client) {
    requireEnv("COMPOSIO_API_KEY");
    // cacheTools puts one prompt-cache breakpoint on the tool list, so repeat runs
    // of the same agent don't pay for the tool schemas again.
    client = new Composio({ provider: new AnthropicProvider({ cacheTools: true }) });
  }
  return client;
}

/** Composio toolkit slugs used across 1Media OS (see BLUEPRINT.md section 3). */
export const TOOLKITS = {
  gmail: "gmail",
  calendar: "googlecalendar",
  drive: "googledrive",
  sheets: "googlesheets",
  docs: "googledocs",
  notion: "notion",
  metaAds: "metaads",
  facebook: "facebook",
  highlevel: "highlevel",
  stripe: "stripe",
  slack: "slack",
  whatsapp: "whatsapp",
} as const;

export type ToolkitSlug = (typeof TOOLKITS)[keyof typeof TOOLKITS];

/**
 * Tools for one agent: either whole toolkits, or an explicit list of tool slugs
 * (tighter, cheaper, and safer once we know exactly which actions an agent needs).
 */
export async function loadTools(opts: { toolkits?: ToolkitSlug[]; tools?: string[] }) {
  const c = composio();
  const userId = config.composioUserId;
  if (opts.tools?.length) {
    return c.tools.get(userId, { tools: opts.tools });
  }
  return c.tools.get(userId, { toolkits: opts.toolkits ?? [], limit: 200 });
}

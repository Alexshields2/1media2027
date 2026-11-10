import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";
import { config } from "../config";

let client: Composio<AnthropicProvider> | undefined;

export function composioEnabled(): boolean {
  return !!process.env.COMPOSIO_API_KEY;
}

export function composio(): Composio<AnthropicProvider> {
  if (!composioEnabled()) throw new Error("COMPOSIO_API_KEY is not set.");
  // cacheTools puts one prompt-cache breakpoint on the tool list.
  client ??= new Composio({ provider: new AnthropicProvider({ cacheTools: true }) });
  return client;
}

/** Composio toolkit slugs used by 1Media OS. */
export const TOOLKITS = {
  gmail: "gmail",
  calendar: "googlecalendar",
  drive: "googledrive",
  sheets: "googlesheets",
  docs: "googledocs",
  metaAds: "metaads",
  facebook: "facebook",
  highlevel: "highlevel",
  stripe: "stripe",
  slack: "slack",
  whatsapp: "whatsapp",
} as const;

export type ToolkitSlug = (typeof TOOLKITS)[keyof typeof TOOLKITS];

/** Tools for one agent. Returns [] when Composio isn't configured, so agents still run on the OS database alone. */
export async function loadComposioTools(opts: { toolkits?: ToolkitSlug[]; tools?: string[] }) {
  if (!composioEnabled()) return [];
  const c = composio();
  const userId = config.composioUserId;
  if (opts.tools?.length) return c.tools.get(userId, { tools: opts.tools });
  if (!opts.toolkits?.length) return [];
  return c.tools.get(userId, { toolkits: opts.toolkits, limit: 200 });
}

/** Runs one Composio tool directly (used when a human approves a queued action). */
export async function executeComposioTool(slug: string, args: Record<string, unknown>): Promise<string> {
  const res = await composio().tools.execute(slug, {
    userId: config.composioUserId,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  return JSON.stringify(res);
}

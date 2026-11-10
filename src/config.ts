import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader so we don't need an extra dependency.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export const MODEL = "claude-opus-5-5";

export const config = {
  composioUserId: process.env.COMPOSIO_USER_ID ?? "1media-ops",
  slackApprovalsChannel: process.env.SLACK_APPROVALS_CHANNEL ?? "",
  timezone: "Europe/Dublin",
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and set it.`);
  return v;
}

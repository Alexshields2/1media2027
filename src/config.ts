import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader for the CLI and scripts (Next.js loads .env itself).
if (typeof process !== "undefined" && existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export const MODEL = "claude-opus-5-5";

export const config = {
  get composioUserId() {
    return process.env.COMPOSIO_USER_ID || "1media-ops";
  },
  timezone: "Europe/Dublin",
  vatRate: 0.23,
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. See .env.example.`);
  return v;
}

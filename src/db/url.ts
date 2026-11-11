// Which database this deployment talks to.
// Preview deploys (VERCEL_ENV=preview) must never touch production, so they only ever use
// PREVIEW_DATABASE_URL and ignore DATABASE_URL / POSTGRES_URL. scripts/migrate.mjs mirrors this.

type Env = Record<string, string | undefined>;

export function databaseUrl(env: Env = process.env): string | undefined {
  if (env.VERCEL_ENV === "preview") return env.PREVIEW_DATABASE_URL || undefined;
  return env.DATABASE_URL || env.POSTGRES_URL || undefined;
}

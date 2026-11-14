// Which database this deployment talks to.
// Preview deploys (VERCEL_ENV=preview) must never touch production, so they only ever use
// PREVIEW_DATABASE_URL and ignore DATABASE_URL / POSTGRES_URL. scripts/migrate.mjs mirrors this.

type Env = Record<string, string | undefined>;

export function databaseUrl(env: Env = process.env): string | undefined {
  if (env.VERCEL_ENV === "preview") return env.PREVIEW_DATABASE_URL || undefined;
  return env.DATABASE_URL || env.POSTGRES_URL || undefined;
}

/**
 * The URL the running app connects with. Serverless functions open many short-lived
 * connections, so a Supabase pooler URL in session mode (port 5432) runs out of slots
 * ("max clients reached in session mode"). Switch it to transaction mode (port 6543),
 * which shares a few server connections between all functions. Migrations keep the
 * original URL, since DDL is happier on a session connection.
 */
export function runtimeDatabaseUrl(env: Env = process.env): string | undefined {
  const url = databaseUrl(env);
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && (u.port === "5432" || u.port === "")) {
      u.port = "6543";
      return u.toString();
    }
  } catch {
    // not a URL we can parse; use it as given
  }
  return url;
}

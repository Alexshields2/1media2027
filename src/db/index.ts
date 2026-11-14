import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";
import { databaseUrl } from "./url";

// The connection opens on first use, so importing this module never needs DATABASE_URL
// (builds and unit tests work without a database).
//
// Serverless: Vercel freezes function instances between requests, and a frozen instance can't run
// idle timers, so connections it holds stay open. With Supabase's session pooler (port 5432) those
// pile up until the pool is full and sign-in fails. So the app talks to the *transaction* pooler
// (port 6543), which shares a few server connections between all clients, uses node-postgres
// (no query pipelining, which the transaction pooler can't follow), and lets Vercel close idle
// connections before an instance is suspended (attachDatabasePool).

type DB = NodePgDatabase<typeof schema>;
const g = globalThis as unknown as { __omPool?: Pool; __omDb?: DB };

/** Supabase pooler URLs: use the transaction pooler (6543) instead of the session pooler (5432). */
export function appConnectionString(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && (u.port === "5432" || u.port === "")) u.port = "6543";
    return u.toString();
  } catch {
    return url;
  }
}

function real(): DB {
  if (!g.__omDb) {
    const url = databaseUrl();
    if (!url) {
      throw new Error(
        process.env.VERCEL_ENV === "preview"
          ? "PREVIEW_DATABASE_URL is not set. Preview deploys never use the production DATABASE_URL."
          : "DATABASE_URL is not set. See .env.example.",
      );
    }
    const pool = new Pool({
      connectionString: appConnectionString(url),
      max: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error("postgres pool error", err.message));
    if (process.env.VERCEL) attachDatabasePool(pool);
    g.__omPool = pool;
    g.__omDb = drizzle(pool, { schema });
  }
  return g.__omDb;
}

export const db = new Proxy({} as DB, {
  get(_t, prop) {
    const target = real();
    const v = Reflect.get(target, prop, target);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

/** Close the pool (scripts and the CLI call this before exiting). */
export async function closeDb() {
  await g.__omPool?.end();
  g.__omPool = undefined;
  g.__omDb = undefined;
}

export { schema };

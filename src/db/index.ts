import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { runtimeDatabaseUrl } from "./url";

// The connection opens on first use, so importing this module never needs DATABASE_URL
// (builds and unit tests work without a database). On Vercel, use the pooled URL.

type DB = PostgresJsDatabase<typeof schema>;
const g = globalThis as unknown as { __omSql?: postgres.Sql; __omDb?: DB };

function real(): DB {
  if (!g.__omDb) {
    const url = runtimeDatabaseUrl();
    if (!url) {
      throw new Error(
        process.env.VERCEL_ENV === "preview"
          ? "PREVIEW_DATABASE_URL is not set. Preview deploys never use the production DATABASE_URL."
          : "DATABASE_URL is not set. See .env.example.",
      );
    }
    // On Vercel every function instance has its own pool, so keep it to one connection and
    // let idle ones close quickly; the pooler shares server connections between instances.
    const serverless = !!process.env.VERCEL;
    g.__omSql = postgres(url, { max: serverless ? 1 : 5, idle_timeout: serverless ? 5 : 30, connect_timeout: 15, prepare: false });
    g.__omDb = drizzle(g.__omSql, { schema });
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
  await g.__omSql?.end();
}

export { schema };

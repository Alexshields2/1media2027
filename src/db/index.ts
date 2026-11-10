import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The connection opens on first use, so importing this module never needs DATABASE_URL
// (builds and unit tests work without a database). On Vercel, use the pooled URL.

type DB = PostgresJsDatabase<typeof schema>;
const g = globalThis as unknown as { __omSql?: postgres.Sql; __omDb?: DB };

function real(): DB {
  if (!g.__omDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
    g.__omSql = postgres(url, { max: 5, prepare: false });
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

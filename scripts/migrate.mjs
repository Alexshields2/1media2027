// Runs database migrations during the Vercel build, so the tables exist before the app starts.
// Skips quietly when DATABASE_URL isn't set (e.g. a preview without a database).
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL, skipping");
  process.exit(0);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  console.log("migrate: database is up to date");
} finally {
  await sql.end();
}

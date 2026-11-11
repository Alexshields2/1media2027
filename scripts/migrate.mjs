// Runs database migrations during the Vercel build, so the tables exist before the app starts.
// Skips quietly when there is no database URL (e.g. a preview without a database).
//
// Preview safety: on a Vercel preview build (VERCEL_ENV=preview) this refuses to touch
// DATABASE_URL / POSTGRES_URL, which may point at production. It migrates PREVIEW_DATABASE_URL
// if set, and otherwise skips. Keep this in step with src/db/url.ts.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const preview = process.env.VERCEL_ENV === "preview";
const url = preview ? process.env.PREVIEW_DATABASE_URL : process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  if (preview) {
    console.log("migrate: REFUSING to migrate on a preview build: PREVIEW_DATABASE_URL is not set, and DATABASE_URL is never used for previews. Skipping.");
  } else {
    console.log("migrate: no DATABASE_URL, skipping");
  }
  process.exit(0);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  console.log(`migrate: ${preview ? "preview " : ""}database is up to date`);
} finally {
  await sql.end();
}

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Database tests run only when TEST_DATABASE_URL points at a Postgres server you can create databases on,
// e.g. TEST_DATABASE_URL=postgres://postgres@localhost:5433/postgres npm test
// Each test file gets its own throwaway database, migrated from drizzle/, dropped afterwards.
// DATABASE_URL is never used, so tests can't touch a real database by accident.

export const dbTestsEnabled = !!process.env.TEST_DATABASE_URL;
export const skipReason = dbTestsEnabled ? false : "set TEST_DATABASE_URL to run database tests";

let admin: postgres.Sql | undefined;
let name: string | undefined;

export async function createTestDb(): Promise<void> {
  const base = process.env.TEST_DATABASE_URL!;
  name = `om_test_${process.pid}_${Date.now()}`;
  admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  delete process.env.POSTGRES_URL;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  await sql.end();
}

export async function dropTestDb(): Promise<void> {
  const { closeDb } = await import("../../src/db");
  await closeDb();
  if (admin && name) {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

export function fixture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
}

export function stripeFixture<T = unknown>(name: string): T {
  return JSON.parse(fixture(`stripe/${name}.json`)) as T;
}

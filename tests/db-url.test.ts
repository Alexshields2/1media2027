import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeDatabaseUrl } from "../src/db/url";

test("a Supabase pooler URL in session mode is switched to transaction mode", () => {
  const url = runtimeDatabaseUrl({ DATABASE_URL: "postgresql://app.ref:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres" });
  assert.equal(url, "postgresql://app.ref:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres");
});

test("transaction-mode and non-Supabase URLs are left alone", () => {
  for (const u of [
    "postgresql://app.ref:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres",
    "postgres://postgres@localhost:5432/onemedia",
    "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres",
  ]) {
    assert.equal(runtimeDatabaseUrl({ DATABASE_URL: u }), u);
  }
});

test("preview deploys still only use PREVIEW_DATABASE_URL", () => {
  assert.equal(runtimeDatabaseUrl({ VERCEL_ENV: "preview", DATABASE_URL: "postgres://prod@x:5432/db" }), undefined);
});

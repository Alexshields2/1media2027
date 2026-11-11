import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import pkg from "../../../package.json";

// Uptime check: no auth (excluded in proxy.ts). 200 when the database answers within 3s, else 503.
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3000;

export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? pkg.version;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let db_: "ok" | "timeout" | "error";
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))),
    ]);
    db_ = "ok";
  } catch (err) {
    db_ = err instanceof Error && err.message === "timeout" ? "timeout" : "error";
  } finally {
    clearTimeout(timer);
  }
  const ok = db_ === "ok";
  return NextResponse.json({ ok, db: db_, version }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

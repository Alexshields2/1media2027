import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { toPoll } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** Status and answer of one agent run. Home polls this while Jarvis is thinking. Behind the login (proxy.ts). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Bad run id" }, { status: 400 });
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(toPoll(run), { headers: { "cache-control": "no-store" } });
}

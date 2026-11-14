import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { runAgent } from "@/lib/runner";
import { sopAgent } from "@/agents/sop-agent";

export function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/** The production domain is not behind Vercel deployment protection, unlike per-deployment URLs. */
export function sopBaseUrl(req: NextRequest): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : req.nextUrl.origin;
}

/** Runs one SOP (for one client, or on its own) as a scheduled agent run. */
export async function runSopTarget(sopId: number, clientId: number | null) {
  const [s] = await db.select().from(schema.sops).where(eq(schema.sops.id, sopId));
  if (!s) throw new Error(`SOP ${sopId} not found`);
  const [owner] = s.ownerId ? await db.select().from(schema.users).where(eq(schema.users.id, s.ownerId)) : [null];
  const [client] = clientId ? await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId)) : [null];
  const attachments =
    s.fileType === "application/pdf" && s.fileData && !s.breakdown
      ? [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: s.fileData }, title: s.fileName ?? "SOP" }]
      : undefined;
  return runAgent(sopAgent(s, { owner, client }), { trigger: "cron", sopId: s.id, clientId: client?.id, attachments });
}

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { isOsTool, runOsTool } from "./os-tools";
import { executeComposioTool } from "./composio";
import { decide } from "./guardrails";

/** Runs an approved action. Hard-blocked actions stay blocked even if approved. */
export async function executeApproval(approvalId: number): Promise<{ ok: boolean; result: string }> {
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  if (!a) throw new Error(`Approval ${approvalId} not found`);
  if (a.status !== "pending" && a.status !== "approved") {
    return { ok: false, result: `Already ${a.status}.` };
  }

  const d = decide(a.tool, "L3");
  if (d.action === "block") {
    await finish(a.id, "failed", `Blocked: ${d.reason}`);
    return { ok: false, result: d.reason };
  }

  await db.update(schema.approvals).set({ status: "approved", decidedAt: new Date() }).where(eq(schema.approvals.id, a.id));
  try {
    const result = isOsTool(a.tool) ? await runOsTool(a.tool, a.input) : await executeComposioTool(a.tool, a.input);
    await finish(a.id, "executed", result.slice(0, 4000));
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finish(a.id, "failed", msg);
    return { ok: false, result: msg };
  }
}

export async function rejectApproval(approvalId: number) {
  await db.update(schema.approvals).set({ status: "rejected", decidedAt: new Date() }).where(eq(schema.approvals.id, approvalId));
}

/** Moves a pending approval to "approved" in one statement, so two clicks can't both run it. */
export async function claimApproval(approvalId: number) {
  const [a] = await db
    .update(schema.approvals)
    .set({ status: "approved", decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
    .returning();
  return a ?? null;
}

/** Rejects an approval only if it is still pending. */
export async function rejectIfPending(approvalId: number) {
  const [a] = await db
    .update(schema.approvals)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
    .returning();
  return a ?? null;
}

async function finish(id: number, status: "executed" | "failed", result: string) {
  await db.update(schema.approvals).set({ status, result, decidedAt: new Date() }).where(eq(schema.approvals.id, id));
}

/** A short human label for an approval card, e.g. "Send email to x@y.ie: Invoice reminder". */
export function describeAction(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const to = s("recipient_email") ?? s("to") ?? s("email");
  const subject = s("subject") ?? s("title");
  const verb = tool.replace(/^[A-Z]+_/, "").toLowerCase().replace(/_/g, " ");
  return [verb, to && `to ${to}`, subject && `– ${subject}`].filter(Boolean).join(" ");
}

import { db, schema } from "../db";

export type AuditAction =
  | "auth.sign_in"
  | "auth.sign_in_failed"
  | "auth.sign_out"
  | "auth.setup_owner"
  | "approval.approve"
  | "approval.reject"
  | "payment.record"
  | "payment.add"
  | "payment.generate_month"
  | "client.create"
  | "client.update"
  | "agent.ask"
  | "agent.create"
  | "agent.update"
  | "agent.reset"
  | "chat.delete"
  | "user.create"
  | "user.update"
  | "user.reset_password"
  | "user.change_password";

/** Writes one audit row. Never throws: a failed audit write must not break the action itself. */
export async function audit(
  action: AuditAction,
  opts: { userId?: number | null; target?: string | null; detail?: Record<string, unknown>; ip?: string | null } = {},
) {
  try {
    await db.insert(schema.auditLog).values({
      action,
      userId: opts.userId ?? null,
      target: opts.target ?? null,
      detail: opts.detail ?? null,
      ip: opts.ip ?? null,
    });
  } catch (e) {
    console.error("audit write failed", action, e);
  }
}

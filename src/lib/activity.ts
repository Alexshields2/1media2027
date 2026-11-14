import { db, schema } from "../db";
import type { User } from "../db/schema";

export interface LogEntry {
  action: string;
  summary: string;
  entity?: string;
  entityId?: number | null;
  meta?: Record<string, unknown>;
}

export type Actor = { type: "user"; user: Pick<User, "id" | "name"> } | { type: "agent"; name: string } | { type: "system"; name?: string };

/** Writes one line to the activity log. Never throws: logging must not break the action it records. */
export async function logActivity(actor: Actor, e: LogEntry): Promise<void> {
  try {
    await db.insert(schema.activity).values({
      actorType: actor.type,
      actor: actor.type === "user" ? actor.user.name : actor.type === "agent" ? actor.name : (actor.name ?? "system"),
      userId: actor.type === "user" ? actor.user.id : null,
      action: e.action,
      summary: e.summary.slice(0, 1000),
      entity: e.entity,
      entityId: e.entityId ?? null,
      meta: e.meta,
    });
  } catch (err) {
    console.error("activity log failed:", err);
  }
}

export const asUser = (user: Pick<User, "id" | "name">): Actor => ({ type: "user", user });
export const asAgent = (name: string): Actor => ({ type: "agent", name });
export const asSystem = (name = "system"): Actor => ({ type: "system", name });

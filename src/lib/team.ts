import type { User } from "../db/schema";

// Pure helpers for the reporting line (Alex -> Jamie -> Ryan). No database access, so they're easy to test.

type Node = Pick<User, "id" | "managerId">;
type RoleNode = Pick<User, "id" | "managerId" | "role">;

/** Everyone below `userId` in the reporting line (not including them). */
export function downline(users: Node[], userId: number): number[] {
  const out: number[] = [];
  const queue = [userId];
  const seen = new Set<number>([userId]);
  while (queue.length) {
    const boss = queue.shift()!;
    for (const u of users) {
      if (u.managerId === boss && !seen.has(u.id)) {
        seen.add(u.id);
        out.push(u.id);
        queue.push(u.id);
      }
    }
  }
  return out;
}

/** Everyone above `userId`, nearest first. */
export function upline(users: Node[], userId: number): number[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const out: number[] = [];
  let cur = byId.get(userId)?.managerId ?? null;
  while (cur !== null && cur !== userId && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.managerId ?? null;
  }
  return out;
}

/** You can hand work to yourself or anyone below you. The owner can hand work to anyone. */
export function canAssign(users: RoleNode[], actorId: number, targetId: number): boolean {
  if (actorId === targetId) return true;
  if (users.find((u) => u.id === actorId)?.role === "owner") return true;
  return downline(users, actorId).includes(targetId);
}

/** You can see your own reports, voice notes and log, and those of everyone below you. The owner sees everything. */
export const canSee = canAssign;

/** Would making `managerId` the manager of `userId` create a loop? */
export function wouldLoop(users: Node[], userId: number, managerId: number | null): boolean {
  if (managerId === null) return false;
  return managerId === userId || downline(users, userId).includes(managerId);
}

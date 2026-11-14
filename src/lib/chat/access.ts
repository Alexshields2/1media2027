import type { AgentProfile, Conversation } from "../../db/schema";
import { can, isMoneyTool, type Role } from "../roles";

// Who may use which chat agent and which tools. Pure functions; the pages, server actions and
// /api/chat call them on the server.

type ProfileAccess = Pick<AgentProfile, "ownerOnly" | "active" | "osTools" | "slug">;

/** May this role chat with this agent? Owner-only agents (Payments) and money agents are owners only. */
export function canUseProfile(role: Role | null | undefined, profile: ProfileAccess): boolean {
  if (!role || !profile.active) return false;
  if (profile.ownerOnly || profile.slug === "payments") return can(role, "payments");
  return true;
}

/** May this role see this agent in the list (owners also see inactive ones, to edit them)? */
export function canSeeProfile(role: Role | null | undefined, profile: ProfileAccess): boolean {
  if (role === "owner") return true;
  return canUseProfile(role, profile);
}

/** Owners write agents' instructions and pick their tools. */
export function canEditProfiles(role: Role | null | undefined): boolean {
  return can(role, "manage_agents");
}

/** A person only ever sees their own conversations. */
export function ownsConversation(user: { id: number }, conversation: Pick<Conversation, "userId">): boolean {
  return conversation.userId === user.id;
}

/** True when this role may use this tool in a chat (team members never get money tools). */
export function toolAllowedForRole(role: Role, tool: string): boolean {
  return can(role, "payments") || !isMoneyTool(tool);
}

/** The OS tools a profile offers to this person. */
export function osToolsFor(role: Role, profile: Pick<AgentProfile, "osTools">): string[] {
  return profile.osTools.filter((t) => toolAllowedForRole(role, t));
}

/** Toolkits a profile offers to this person (Stripe is money). */
export function toolkitsFor(role: Role, profile: Pick<AgentProfile, "toolkits">): string[] {
  return profile.toolkits.filter((t) => can(role, "payments") || t !== "stripe");
}

/** Client fields a team member doesn't see (src/lib/roles.ts "client_billing"). */
const BILLING_FIELDS = ["retainerExVat", "vat", "billingMethod", "stripeCustomerId"];

/** Removes billing fields from a tool result for people without client_billing (OS_LIST_CLIENTS returns them). */
export function redactToolResult(role: Role, tool: string, out: string): string {
  if (can(role, "client_billing") || tool !== "OS_LIST_CLIENTS") return out;
  try {
    const rows = JSON.parse(out) as Record<string, unknown>[];
    if (!Array.isArray(rows)) return out;
    return JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !BILLING_FIELDS.includes(k)))));
  } catch {
    return out;
  }
}

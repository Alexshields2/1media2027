import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { AgentProfile } from "@/db/schema";
import { listProfiles } from "@/lib/chat/profiles";
import { canSeeProfile } from "@/lib/chat/access";
import { approvalStatuses } from "@/lib/chat/engine";
import { toUiMessages, type UiMessage } from "@/lib/chat/view";
import type { CurrentUser } from "@/lib/session";

export interface SidebarAgent {
  slug: string;
  name: string;
  icon: string;
  description: string;
  active: boolean;
  ownerOnly: boolean;
}

export interface SidebarConversation {
  id: number;
  title: string;
  updatedAt: string;
}

export const toSidebarAgent = (p: AgentProfile): SidebarAgent => ({ slug: p.slug, name: p.name, icon: p.icon, description: p.description, active: p.active, ownerOnly: p.ownerOnly });

/** Agents this person may see, in sidebar order. */
export async function visibleProfiles(user: CurrentUser): Promise<AgentProfile[]> {
  return (await listProfiles()).filter((p) => canSeeProfile(user.role, p));
}

/** This person's conversations with one agent, most recent first. */
export async function conversationsFor(user: CurrentUser, profileId: number): Promise<SidebarConversation[]> {
  const rows = await db
    .select({ id: schema.conversations.id, title: schema.conversations.title, updatedAt: schema.conversations.updatedAt })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.userId, user.id), eq(schema.conversations.agentProfileId, profileId)))
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(100);
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

/** A conversation's messages ready for the chat (only if this person owns it). */
export async function loadMessages(user: CurrentUser, profileId: number, conversationId: number): Promise<{ title: string; messages: UiMessage[] } | null> {
  const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!c || c.userId !== user.id || c.agentProfileId !== profileId) return null;
  const rows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.conversationId, c.id)).orderBy(asc(schema.chatMessages.id));
  const messages = toUiMessages(rows);
  const ids = messages.flatMap((m) => (m.role === "assistant" ? m.parts.flatMap((p) => (p.type === "tool" && p.event.approvalId ? [p.event.approvalId] : [])) : []));
  const statuses = await approvalStatuses(ids);
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) if (p.type === "tool" && p.event.approvalId) p.event.approval = statuses.get(p.event.approvalId) ?? { status: "missing" };
  }
  return { title: c.title, messages };
}

/** This person's latest chats with one agent (Home shows the Jarvis ones). */
export async function recentChats(user: CurrentUser, slug: string, limit = 5): Promise<SidebarConversation[]> {
  const rows = await db
    .select({ id: schema.conversations.id, title: schema.conversations.title, updatedAt: schema.conversations.updatedAt })
    .from(schema.conversations)
    .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.conversations.agentProfileId))
    .where(and(eq(schema.conversations.userId, user.id), eq(schema.agentProfiles.slug, slug)))
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

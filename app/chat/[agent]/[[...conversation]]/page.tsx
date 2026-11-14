import { notFound, redirect } from "next/navigation";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";
import { canEditProfiles, canUseProfile } from "@/lib/chat/access";
import { modelReady } from "@/lib/runner";
import { NoAccess } from "../../../_components/ui";
import { ChatWorkspace } from "../../_components/chat-workspace";
import { conversationsFor, loadMessages, toSidebarAgent, visibleProfiles } from "../../load";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Home's Ask Jarvis box continues the last Jarvis chat if it was used in the last few hours. */
const CONTINUE_WITHIN_MS = 6 * 60 * 60 * 1000;

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ agent: string; conversation?: string[] }>;
  searchParams: Promise<{ q?: string; continue?: string }>;
}) {
  const user = await requireUser();
  const { agent, conversation } = await params;
  const sp = await searchParams;
  const profiles = await visibleProfiles(user);
  const profile = profiles.find((p) => p.slug === agent);
  if (!profile) {
    // Exists but owner-only, or doesn't exist at all.
    const exists = (await db.select({ id: schema.agentProfiles.id }).from(schema.agentProfiles).where(eq(schema.agentProfiles.slug, agent))).length > 0;
    if (exists) return <NoAccess what="This agent" />;
    notFound();
  }
  if (!canUseProfile(user.role, profile)) {
    // Owners can open an inactive agent's settings, not chat with it.
    redirect(`/chat/${profile.slug}/settings`);
  }

  const conversationId = conversation?.length === 1 ? Number(conversation[0]) : null;
  if (conversation && (conversation.length !== 1 || !conversationId)) notFound();

  const q = sp.q?.trim().slice(0, 2000);
  if (!conversationId && q && sp.continue === "1") {
    const [recent] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.userId, user.id), eq(schema.conversations.agentProfileId, profile.id), gt(schema.conversations.updatedAt, new Date(Date.now() - CONTINUE_WITHIN_MS))))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(1);
    if (recent) redirect(`/chat/${profile.slug}/${recent.id}?q=${encodeURIComponent(q)}`);
  }

  const loaded = conversationId ? await loadMessages(user, profile.id, conversationId) : null;
  if (conversationId && !loaded) notFound();

  return (
    <ChatWorkspace
      key={profile.slug}
      agents={profiles.map(toSidebarAgent)}
      agent={toSidebarAgent(profile)}
      conversations={await conversationsFor(user, profile.id)}
      conversationId={conversationId}
      title={loaded?.title ?? null}
      messages={loaded?.messages ?? []}
      initialPrompt={q ?? null}
      role={user.role}
      canEdit={canEditProfiles(user.role)}
      apiReady={modelReady()}
      webSearch={profile.webSearch}
    />
  );
}

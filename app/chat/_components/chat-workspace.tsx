"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Role } from "@/lib/roles";
import type { UiMessage } from "@/lib/chat/view";
import { deleteConversation, renameConversation } from "../actions";
import type { SidebarAgent, SidebarConversation } from "../load";
import { AgentAvatar, ChatIcon } from "./agent-icon";
import { Conversation } from "./conversation";

export interface WorkspaceProps {
  agents: SidebarAgent[];
  agent: SidebarAgent;
  conversations: SidebarConversation[];
  conversationId: number | null;
  title: string | null;
  messages: UiMessage[];
  initialPrompt: string | null;
  role: Role;
  canEdit: boolean;
  apiReady: boolean;
  webSearch: boolean;
}

/** The claude.ai-style chat: agents and their conversations on the left (a drawer on phones), the chat on the right. */
export function ChatWorkspace(props: WorkspaceProps) {
  const [drawer, setDrawer] = useState(false);
  const [activeId, setActiveId] = useState(props.conversationId);
  const pathname = usePathname();
  useEffect(() => setActiveId(props.conversationId), [props.conversationId]);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const sidebar = <Sidebar {...props} activeId={activeId} onNavigate={() => setDrawer(false)} />;

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] overflow-hidden rounded-2xl border border-line bg-panel/40 md:h-[calc(100dvh-8rem)]">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-sidebar/70 md:flex" aria-label="Agents and chats">
        {sidebar}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Agents and chats">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[85%] max-w-80 flex-col border-r border-line bg-sidebar shadow-2xl">
            <div className="flex justify-end px-2 pt-2">
              <button type="button" onClick={() => setDrawer(false)} className="rounded-lg p-2 text-ink/60 hover:bg-ink/[0.06] hover:text-ink" aria-label="Close agents">
                <ChatIcon name="close" className="size-5" />
              </button>
            </div>
            {sidebar}
          </aside>
        </div>
      )}

      <Conversation
        agent={props.agent}
        conversationId={props.conversationId}
        title={props.title}
        messages={props.messages}
        initialPrompt={props.initialPrompt}
        role={props.role}
        canEdit={props.canEdit}
        apiReady={props.apiReady}
        webSearch={props.webSearch}
        onConversation={setActiveId}
        onOpenDrawer={() => setDrawer(true)}
      />
    </div>
  );
}

function Sidebar({ agents, agent, conversations, canEdit, activeId, onNavigate }: WorkspaceProps & { activeId: number | null; onNavigate: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-[10px] font-semibold tracking-[0.16em] text-ink/40 uppercase">Agents</span>
        {canEdit && (
          <Link href="/chat/new" onClick={onNavigate} className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-ink/50 hover:bg-ink/[0.05] hover:text-ink">
            <ChatIcon name="plus" className="size-3.5" /> New agent
          </Link>
        )}
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {agents.map((a) => {
          const on = a.slug === agent.slug;
          return (
            <div key={a.slug}>
              <Link
                href={`/chat/${a.slug}`}
                onClick={onNavigate}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors ${on ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"} ${a.active ? "" : "opacity-50"}`}
              >
                <AgentAvatar icon={a.icon} size="sm" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{a.name}</span>
                    {a.ownerOnly && <ChatIcon name="lock" className="size-3 shrink-0 text-ink/35" />}
                  </span>
                  <span className="block truncate text-xs text-ink/45">{a.active ? a.description : "Turned off"}</span>
                </span>
              </Link>
              {on && <ConversationList agent={a} conversations={conversations} activeId={activeId} onNavigate={onNavigate} />}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function ConversationList({ agent, conversations, activeId, onNavigate }: { agent: SidebarAgent; conversations: SidebarConversation[]; activeId: number | null; onNavigate: () => void }) {
  return (
    <div className="mt-1 mb-3 ml-5 border-l border-line pl-2">
      <Link
        href={`/chat/${agent.slug}`}
        onClick={onNavigate}
        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${activeId === null ? "bg-brand-soft text-brand-light" : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink"}`}
      >
        <ChatIcon name="plus" className="size-3.5" /> New chat
      </Link>
      {conversations.length > 0 && (
        <ul className="mt-1 space-y-0.5" aria-label={`${agent.name} chats`}>
          {conversations.map((c) => (
            <ConversationRow key={c.id} agent={agent} c={c} active={c.id === activeId} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationRow({ agent, c, active, onNavigate }: { agent: SidebarAgent; c: SidebarConversation; active: boolean; onNavigate: () => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [pending, start] = useTransition();
  useEffect(() => setTitle(c.title), [c.title]);

  if (editing) {
    return (
      <li>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            start(async () => {
              await renameConversation(c.id, title);
              router.refresh();
            });
          }}
        >
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTitle(c.title);
                setEditing(false);
              }
            }}
            maxLength={120}
            aria-label="Chat title"
            className="w-full rounded-lg border border-brand/50 bg-canvas px-2 py-1 text-sm outline-none"
          />
        </form>
      </li>
    );
  }

  return (
    <li className={`group relative flex items-center rounded-lg ${active ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"} ${pending ? "opacity-50" : ""}`}>
      <Link href={`/chat/${agent.slug}/${c.id}`} onClick={onNavigate} className={`min-w-0 flex-1 truncate px-2.5 py-1.5 text-sm ${active ? "text-ink" : "text-ink/65"}`} title={title}>
        {title}
      </Link>
      <span className={`flex shrink-0 items-center pr-1 ${active ? "" : "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"}`}>
        <button type="button" onClick={() => setEditing(true)} className="rounded-md p-1 text-ink/40 hover:bg-ink/[0.08] hover:text-ink" aria-label={`Rename “${title}”`} title="Rename">
          <ChatIcon name="pencil" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirm(`Delete “${title}”? This can't be undone.`)) return;
            start(async () => {
              await deleteConversation(c.id);
              if (active) router.push(`/chat/${agent.slug}`);
              router.refresh();
            });
          }}
          className="rounded-md p-1 text-ink/40 hover:bg-red-500/15 hover:text-red-300"
          aria-label={`Delete “${title}”`}
          title="Delete"
        >
          <ChatIcon name="trash" className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

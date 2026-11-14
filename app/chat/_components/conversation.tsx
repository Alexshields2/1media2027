"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { canDecide, type Role } from "@/lib/roles";
import type { UiMessage, UiPart, UiToolEvent } from "@/lib/chat/view";
import type { ChatEvent } from "@/lib/chat/engine";
import { Markdown } from "../../_components/markdown";
import { btnBrand, btnGhost } from "../../_components/ui";
import { decideChatApproval } from "../actions";
import type { SidebarAgent } from "../load";
import { AgentAvatar, ChatIcon } from "./agent-icon";

/** Must match src/lib/chat/attachments.ts (kept here so the browser bundle doesn't pull in the server code). */
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.tsv,.txt,.md,.json,.xlsx";
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5;

type Assistant = Extract<UiMessage, { role: "assistant" }> & { streaming?: boolean };
type Banner = { tone: "error" | "notice"; text: string };

const SUGGESTIONS: Record<string, string[]> = {
  jarvis: ["Who owes us money right now?", "Which clients need attention this week?", "What should I focus on today?"],
  fulfilment: ["What's still open for our newest client?", "Which clients are missing set-up details?", "Turn this request into tasks"],
  reporting: ["Which weekly reports are still missing?", "How did last week compare to the week before?", "Draft this month's report for a client"],
  "project-management": ["What's overdue across all clients?", "Who has the most open tasks?", "Plan next week's priorities"],
  payments: ["Who owes us money right now?", "Which chasers are due today?", "Summarise cash for this month"],
  sales: ["Which prospects need a follow-up?", "Prep me for my next discovery call", "Draft a follow-up for a quiet lead"],
  inbox: ["What came in from clients today?", "Which emails need a reply?", "Turn client requests into tasks"],
  "client-health": ["Which clients are red or yellow?", "Why is a client yellow this week?", "What's the one action per red client?"],
};

export function Conversation({
  agent,
  conversationId,
  title,
  messages: initial,
  initialPrompt,
  role,
  canEdit,
  apiReady,
  webSearch,
  onConversation,
  onOpenDrawer,
}: {
  agent: SidebarAgent;
  conversationId: number | null;
  title: string | null;
  messages: UiMessage[];
  initialPrompt: string | null;
  role: Role;
  canEdit: boolean;
  apiReady: boolean;
  webSearch: boolean;
  onConversation: (id: number) => void;
  onOpenDrawer: () => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<UiMessage[]>(initial);
  const [convId, setConvId] = useState(conversationId);
  const [streaming, setStreaming] = useState(false);
  const [banners, setBanners] = useState<Banner[]>([]);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Take the server's copy whenever it changes (navigation, or the refresh after a reply), unless a reply is streaming.
  useEffect(() => {
    if (busy.current) return;
    setMessages(initial);
    setConvId(conversationId);
  }, [initial, conversationId]);
  useEffect(() => setBanners([]), [conversationId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateLast = (fn: (m: Assistant) => Assistant) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      if (!last || last.role !== "assistant") return ms;
      return [...ms.slice(0, -1), fn({ ...last, parts: [...last.parts] })];
    });

  const send = useCallback(
    async (text: string, files: File[] = [], regenerate = false) => {
      if (busy.current) return;
      busy.current = true;
      stick.current = true;
      setBanners([]);
      setMessages((ms) => {
        const base = regenerate ? dropLastReply(ms) : [...ms, { id: `local-u${Date.now()}`, role: "user" as const, text, attachments: files.map((f) => ({ name: f.name, mediaType: f.type, size: f.size })) }];
        return [...base, { id: `local-a${Date.now()}`, role: "assistant", parts: [], streaming: true } as Assistant];
      });
      const fd = new FormData();
      fd.set("agent", agent.slug);
      if (convId) fd.set("conversationId", String(convId));
      fd.set("text", text);
      if (regenerate) fd.set("regenerate", "1");
      for (const f of files) fd.append("files", f);

      const ac = new AbortController();
      abort.current = ac;
      setStreaming(true);
      let saved = !!convId;
      const handle = (e: ChatEvent) => {
        if (e.type === "conversation") saved = true;
        if (e.type === "conversation" && e.created) {
          setConvId(e.id);
          onConversation(e.id);
          window.history.replaceState(null, "", `/chat/${agent.slug}/${e.id}`);
        } else if (e.type === "text") {
          updateLast((m) => {
            const last = m.parts.at(-1);
            if (last?.type === "text") m.parts[m.parts.length - 1] = { type: "text", text: last.text + e.text };
            else m.parts.push({ type: "text", text: e.text });
            return m;
          });
        } else if (e.type === "tool") {
          updateLast((m) => {
            const i = m.parts.findIndex((p) => p.type === "tool" && p.event.id === e.event.id);
            const part: UiPart = { type: "tool", event: e.event.outcome === "proposed" && e.event.approvalId ? { ...e.event, approval: { status: "pending" } } : e.event };
            if (i >= 0) m.parts[i] = part;
            else m.parts.push(part);
            return m;
          });
        } else if (e.type === "notice") {
          setBanners((b) => [...b, { tone: "notice", text: e.text }]);
        } else if (e.type === "error") {
          setBanners((b) => [...b, { tone: "error", text: e.message }]);
        }
      };

      let stopped = false;
      try {
        const res = await fetch("/api/chat", { method: "POST", body: fd, signal: ac.signal });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `The server said ${res.status}. Try again.`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) handle(JSON.parse(line) as ChatEvent);
          }
        }
      } catch (err) {
        if (ac.signal.aborted) stopped = true;
        else setBanners((b) => [...b, { tone: "error", text: err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Couldn't reach the server. Check your connection and try again." }]);
      } finally {
        updateLast((m) => ({ ...m, streaming: false }));
        setMessages((ms) => (ms.at(-1)?.role === "assistant" && !(ms.at(-1) as Assistant).parts.length ? ms.slice(0, -1) : ms));
        abort.current = null;
        busy.current = false;
        setStreaming(false);
        // Pick up the saved messages (ids, approvals) and the sidebar. After a stop, give the server a moment to save the partial reply.
        // If nothing was saved (e.g. no API key), keep the message on screen with the error instead.
        if (saved) setTimeout(() => router.refresh(), stopped ? 800 : 0);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.slug, convId],
  );

  // Home's Ask Jarvis box arrives with ?q=…: send it once and drop it from the URL.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialPrompt || sentInitial.current) return;
    sentInitial.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    send(initialPrompt);
  }, [initialPrompt, send]);

  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  const empty = messages.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Chat with ${agent.name}`}>
      <header className="flex items-center gap-3 border-b border-line px-3 py-2.5 md:px-5">
        <button type="button" onClick={onOpenDrawer} className="rounded-lg p-2 text-ink/60 hover:bg-ink/[0.06] hover:text-ink md:hidden" aria-label="Show agents and chats">
          <ChatIcon name="menu" className="size-5" />
        </button>
        <AgentAvatar icon={agent.icon} size="sm" />
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
          <p className="truncate text-xs text-ink/45">{title ?? (convId ? "Chat" : "New chat")}</p>
        </div>
        {webSearch && (
          <span className="hidden items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink/50 sm:flex" title="This agent can search the web">
            <ChatIcon name="globe" className="size-3" /> Web
          </span>
        )}
        {canEdit && (
          <Link href={`/chat/${agent.slug}/settings`} className="rounded-lg p-2 text-ink/50 hover:bg-ink/[0.06] hover:text-ink" aria-label={`${agent.name} settings`} title="Agent settings">
            <ChatIcon name="gear" className="size-4.5" />
          </Link>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {empty ? (
          <EmptyState agent={agent} apiReady={apiReady} onPick={(s) => send(s)} disabled={streaming} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6">
            {!apiReady && <NoKey />}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <UserBubble key={m.id} m={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m as Assistant}
                  agent={agent}
                  role={role}
                  isLast={i === lastAssistant && i === messages.length - 1}
                  busy={streaming}
                  onRegenerate={() => send("", [], true)}
                />
              ),
            )}
            {banners.map((b, i) => (
              <p key={i} role={b.tone === "error" ? "alert" : "status"} className={`flex gap-2 rounded-xl px-3 py-2 text-sm ${b.tone === "error" ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-200"}`}>
                <ChatIcon name="alert" className="mt-0.5 size-4 shrink-0" />
                {b.text}
              </p>
            ))}
          </div>
        )}
      </div>

      <Composer agent={agent} streaming={streaming} onSend={(t, f) => send(t, f)} onStop={() => abort.current?.abort()} />
    </section>
  );
}

function dropLastReply(ms: UiMessage[]): UiMessage[] {
  const i = ms.findLastIndex((m) => m.role === "user");
  return i >= 0 ? ms.slice(0, i + 1) : ms;
}

function NoKey() {
  return (
    <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
      Agents can&rsquo;t answer until ANTHROPIC_API_KEY is added in Vercel (Settings → Environment Variables), then redeploy.
    </p>
  );
}

function EmptyState({ agent, apiReady, onPick, disabled }: { agent: SidebarAgent; apiReady: boolean; onPick: (s: string) => void; disabled: boolean }) {
  return (
    <div className="home-glow flex min-h-full flex-col items-center justify-center px-4 py-10 text-center">
      <AgentAvatar icon={agent.icon} size="lg" />
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">
        Chat with <span className="brand-text">{agent.name}</span>
      </h2>
      {agent.description && <p className="mt-1.5 max-w-md text-sm text-ink/55">{agent.description}</p>}
      <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
        {(SUGGESTIONS[agent.slug] ?? ["What can you help me with?", "What do you know about our clients?"]).map((s) => (
          <button key={s} type="button" disabled={disabled} onClick={() => onPick(s)} className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink/65 hover:border-brand/40 hover:text-ink disabled:opacity-50">
            {s}
          </button>
        ))}
      </div>
      {!apiReady && (
        <div className="mt-6 max-w-md">
          <NoKey />
        </div>
      )}
    </div>
  );
}

function fileSize(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function UserBubble({ m }: { m: Extract<UiMessage, { role: "user" }> }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-role="user">
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {m.attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1 text-xs text-ink/70">
              <ChatIcon name="file" className="size-3.5 text-brand-light" />
              <span className="max-w-48 truncate">{a.name}</span>
              <span className="text-ink/35">{fileSize(a.size)}</span>
            </span>
          ))}
        </div>
      )}
      {m.text && <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink/[0.08] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{m.text}</div>}
    </div>
  );
}

function AssistantMessage({ m, agent, role, isLast, busy, onRegenerate }: { m: Assistant; agent: SidebarAgent; role: Role; isLast: boolean; busy: boolean; onRegenerate: () => void }) {
  const text = m.parts
    .filter((p): p is Extract<UiPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const waiting = m.streaming && !m.parts.some((p) => p.type === "text" || (p.type === "tool" && p.event.running));
  return (
    <div className="group flex gap-3" data-role="assistant">
      <div className="hidden pt-0.5 sm:block">
        <AgentAvatar icon={agent.icon} size="sm" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {m.parts.map((p, i) =>
          p.type === "text" ? (
            <Markdown key={i}>{p.text}</Markdown>
          ) : (
            <div key={p.event.id ?? i} className="space-y-2">
              <ToolChip e={p.event} />
              {p.event.outcome === "proposed" && p.event.approvalId && <ApprovalCard e={p.event} agent={agent.slug} role={role} />}
            </div>
          ),
        )}
        {waiting && <Dots label={`${agent.name} is thinking`} />}
        {m.stopReason === "stopped" && !m.streaming && <p className="text-xs text-ink/40">Stopped.</p>}
        {!m.streaming && text && (
          <div className={`flex gap-1 ${isLast ? "" : "md:opacity-0 md:group-hover:opacity-100"}`}>
            <CopyBtn text={text} />
            {isLast && (
              <button type="button" disabled={busy} onClick={onRegenerate} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink/45 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40" title="Regenerate">
                <ChatIcon name="refresh" className="size-3.5" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Dots({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink/50" role="status">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span key={d} className="size-1.5 animate-pulse rounded-full bg-brand-light" style={{ animationDelay: `${d}ms` }} />
        ))}
      </span>
      {label}…
    </p>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink/45 hover:bg-ink/[0.06] hover:text-ink"
      title="Copy"
    >
      <ChatIcon name={copied ? "check" : "copy"} className="size-3.5" /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

const OUTCOME: Record<string, { icon: "check" | "lock" | "alert" | "clip"; tone: string; word: string }> = {
  ran: { icon: "check", tone: "text-emerald-300", word: "Done" },
  proposed: { icon: "clip", tone: "text-brand-light", word: "Needs approval" },
  blocked: { icon: "lock", tone: "text-amber-300", word: "Blocked" },
  error: { icon: "alert", tone: "text-red-300", word: "Failed" },
};

function ToolChip({ e }: { e: UiToolEvent }) {
  const [open, setOpen] = useState(false);
  const o = OUTCOME[e.outcome] ?? OUTCOME.ran;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink/70 hover:border-brand/40 hover:text-ink"
      >
        {e.running ? (
          <span className="size-3 animate-spin rounded-full border-2 border-brand-light/30 border-t-brand-light" aria-label="Running" />
        ) : (
          <ChatIcon name={e.tool === "web_search" ? "globe" : o.icon} className={`size-3.5 ${o.tone}`} />
        )}
        <span className="truncate">{e.label ?? e.tool}</span>
        {!e.running && e.outcome !== "ran" && <span className={`${o.tone} shrink-0`}>· {o.word}</span>}
        <ChatIcon name="chevron" className={`size-3 shrink-0 text-ink/35 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-xl border border-line bg-canvas/60 p-3 text-xs">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-ink/50">
            <span className="font-mono">{e.tool}</span>
            {typeof e.ms === "number" && <span>{e.ms} ms</span>}
          </div>
          {e.note && <p className="text-ink/70">{e.note}</p>}
          {e.input !== undefined && Object.keys((e.input as object) ?? {}).length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-ink/[0.04] p-2 font-mono text-[11px] whitespace-pre-wrap text-ink/70">{JSON.stringify(e.input, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_WORD: Record<string, string> = { pending: "Waiting for approval", approved: "Approved, running…", executed: "Approved and done", rejected: "Rejected", failed: "Approved, but it failed", missing: "No longer in the queue" };

function ApprovalCard({ e, agent, role }: { e: UiToolEvent; agent: string; role: Role }) {
  const [approval, setApproval] = useState(e.approval ?? { status: "pending" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setApproval(e.approval ?? { status: "pending" }), [e.approval]);
  const input = (e.input ?? {}) as Record<string, unknown>;
  const body = ["body", "message_body", "text", "message", "description"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const rest = Object.entries(input).filter(([k, v]) => !["body", "message_body", "text", "message", "description"].includes(k) && v !== undefined && v !== null && v !== "");
  const allowed = canDecide(role, agent, e.tool);
  const decide = (d: "approve" | "reject") =>
    start(async () => {
      setError(null);
      const r = await decideChatApproval(e.approvalId!, d);
      setApproval({ status: r.status, result: r.result });
      if (r.error) setError(r.error);
    });
  const tone = approval.status === "executed" ? "border-emerald-400/30" : approval.status === "rejected" || approval.status === "failed" ? "border-line" : "border-brand/40";

  return (
    <div className={`rounded-2xl border bg-panel p-4 ${tone}`} data-approval={approval.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{e.label ?? e.tool}</p>
        <span className={`text-xs ${approval.status === "pending" ? "text-brand-light" : approval.status === "executed" ? "text-emerald-300" : approval.status === "failed" ? "text-red-300" : "text-ink/45"}`}>{STATUS_WORD[approval.status] ?? approval.status}</span>
      </div>
      {rest.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {rest.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink/45">{k}</dt>
              <dd className="break-all text-ink/80">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-ink/[0.04] p-3 font-sans text-xs whitespace-pre-wrap text-ink/80">{body}</pre>}
      {approval.result && approval.status !== "pending" && <p className="mt-2 line-clamp-3 text-xs text-ink/45">{approval.result}</p>}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      {approval.status === "pending" &&
        (allowed ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={() => decide("approve")} className={`${btnBrand} px-3 py-1.5 text-xs`}>
              {pending ? "Working…" : "Approve and run"}
            </button>
            <button type="button" disabled={pending} onClick={() => decide("reject")} className={`${btnGhost} px-3 py-1.5 text-xs`}>
              Reject
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink/45">An owner needs to approve this.</p>
        ))}
    </div>
  );
}

function Composer({ agent, streaming, onSend, onStop }: { agent: SidebarAgent; streaming: boolean; onSend: (text: string, files: File[]) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const add = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)];
    setError(null);
    if (next.length > MAX_FILES) return setError(`Attach at most ${MAX_FILES} files per message.`);
    if (next.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) return setError("Attachments can add up to 4 MB per message.");
    setFiles(next);
  };

  const submit = () => {
    if (streaming || (!text.trim() && !files.length)) return;
    onSend(text.trim(), files);
    setText("");
    setFiles([]);
    setError(null);
    area.current?.focus();
  };

  return (
    <div className="border-t border-line bg-canvas/40 px-3 pt-3 pb-3 md:px-5">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files.length) add(e.dataTransfer.files);
          }}
          className={`rounded-2xl border bg-panel p-2 shadow-[0_0_40px_rgb(4_153_242/0.08)] focus-within:border-brand/60 ${drag ? "border-brand" : "border-line"}`}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1.5 pt-1 pb-2">
              {files.map((f, i) => (
                <span key={i} className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 py-1 text-xs">
                  <ChatIcon name="file" className="size-3.5 text-brand-light" />
                  <span className="max-w-40 truncate">{f.name}</span>
                  <span className="text-ink/35">{fileSize(f.size)}</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-ink/40 hover:text-ink" aria-label={`Remove ${f.name}`}>
                    <ChatIcon name="close" className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={20000}
            placeholder={`Message ${agent.name}…`}
            aria-label={`Message ${agent.name}`}
            className="block max-h-[220px] w-full resize-none bg-transparent px-2 py-2 text-sm leading-relaxed outline-none placeholder:text-ink/35"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center">
              <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (e.target.files && add(e.target.files), (e.target.value = ""))} />
              <button type="button" onClick={() => picker.current?.click()} className="rounded-lg p-2 text-ink/50 hover:bg-ink/[0.06] hover:text-ink" aria-label="Attach files" title="Attach PDF, image, CSV, XLSX or text (4 MB max)">
                <ChatIcon name="clip" className="size-4.5" />
              </button>
              <span className="hidden text-[11px] text-ink/30 sm:inline">Enter to send · Shift+Enter for a new line</span>
            </div>
            {streaming ? (
              <button type="button" onClick={onStop} className="flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1.5 text-xs font-medium text-ink/80 hover:border-red-400/50 hover:text-red-200" aria-label="Stop">
                <ChatIcon name="stop" className="size-3.5" /> Stop
              </button>
            ) : (
              <button type="submit" disabled={!text.trim() && !files.length} aria-label="Send" className="brand-gradient grid size-9 place-items-center rounded-full text-white shadow-[0_0_18px_rgb(4_153_242/0.45)] disabled:opacity-40 disabled:shadow-none">
                <ChatIcon name="send" className="size-4" />
              </button>
            )}
          </div>
        </div>
        {error && <p className="mt-1.5 px-2 text-xs text-red-300">{error}</p>}
      </form>
    </div>
  );
}

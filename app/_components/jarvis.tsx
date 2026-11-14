"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { askJarvis } from "../actions";
import type { RunPoll } from "@/lib/runs";
import { Icon } from "./icons";
import { Markdown } from "./markdown";

type Status = RunPoll["status"] | "sending";

export interface JarvisItem {
  key: string;
  runId?: number;
  question: string;
  status: Status;
  answer?: string | null;
  error?: string | null;
  toolCalls?: number;
  startedAt: string;
}

const POLL_MS = 1500;
/** Matches STALE_AFTER_MS in src/lib/runs.ts: give up on the spinner after this. */
const GIVE_UP_MS = 6 * 60 * 1000;

const isPending = (s: Status) => s === "sending" || s === "running";

export function JarvisBox({ suggestions, initial, apiReady }: { suggestions: string[]; initial: JarvisItem[]; apiReady: boolean }) {
  const [items, setItems] = useState<JarvisItem[]>(initial);
  const [question, setQuestion] = useState("");
  const [sending, startSending] = useTransition();
  const [open, setOpen] = useState<string | null>(initial[0]?.key ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<JarvisItem>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  function ask(q: string) {
    const text = q.trim();
    if (!text || sending) return;
    const key = `new-${Date.now()}`;
    setItems((xs) => [{ key, question: text, status: "sending" as const, startedAt: new Date().toISOString() }, ...xs].slice(0, 6));
    setOpen(key);
    setQuestion("");
    startSending(async () => {
      try {
        const res = await askJarvis(text);
        if ("error" in res) update(key, { status: "error", error: res.error });
        else update(key, { runId: res.runId, status: "running" });
      } catch {
        update(key, { status: "error", error: "Couldn't reach the server. Check your connection and try again." });
      }
    });
  }

  // Poll every run that's still thinking until it finishes.
  const waiting = items.filter((i) => i.status === "running" && i.runId).map((i) => `${i.key}:${i.runId}`);
  const waitingKey = waiting.join(",");
  useEffect(() => {
    if (!waitingKey) return;
    let cancelled = false;
    const tick = async () => {
      for (const entry of waitingKey.split(",")) {
        const [key, id] = entry.split(":");
        try {
          const r = await fetch(`/api/runs/${id}`, { cache: "no-store" });
          if (!r.ok) continue;
          const p: RunPoll = await r.json();
          if (cancelled) return;
          if (p.status === "running" && Date.now() - Date.parse(p.startedAt) > GIVE_UP_MS) {
            update(key, { status: "stalled", error: "Jarvis didn't finish in time. Open the run for details, or ask again." });
          } else {
            update(key, { status: p.status, answer: p.answer, error: p.error, toolCalls: p.toolCalls });
          }
        } catch {
          // network blip: try again next tick
        }
      }
    };
    const t = setInterval(tick, POLL_MS);
    tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [waitingKey]);

  return (
    <div className="mt-8 w-full max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 shadow-[0_0_40px_rgb(4_153_242/0.10)] transition focus-within:border-brand/60 focus-within:shadow-[0_0_50px_rgb(4_153_242/0.22)]">
          <Icon name="spark" className="size-4 shrink-0 text-brand-light" />
          <input
            ref={inputRef}
            name="instruction"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            required
            maxLength={2000}
            placeholder="Ask Jarvis anything…"
            aria-label="Ask Jarvis"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted focus-visible:outline-none"
          />
          <button
            type="submit"
            disabled={sending || !question.trim()}
            aria-label="Ask"
            className="brand-gradient grid size-9 shrink-0 place-items-center rounded-full text-white shadow-[0_0_18px_rgb(4_153_242/0.5)] transition hover:brightness-110 disabled:opacity-50"
          >
            <Icon name="send" className="size-4" />
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            disabled={sending}
            onClick={() => ask(s)}
            className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-soft transition-colors hover:border-brand/40 hover:text-white disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
      {!apiReady && (
        <p className="mt-6 text-center text-xs text-amber-300">Jarvis can&rsquo;t answer until ANTHROPIC_API_KEY is added in Vercel.</p>
      )}

      {items.length > 0 && (
        <ul className="mt-8 space-y-2" aria-label="Recent questions">
          {items.map((i) => (
            <Answer key={i.key} item={i} open={open === i.key} onToggle={() => setOpen(open === i.key ? null : i.key)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Answer({ item, open, onToggle }: { item: JarvisItem; open: boolean; onToggle: () => void }) {
  const pending = isPending(item.status);
  const failed = item.status === "error" || item.status === "stalled";
  const show = open || pending;
  return (
    <li className={`rounded-2xl border bg-panel/80 text-left ${failed ? "border-red-400/30" : "border-line"}`} data-status={item.status}>
      <button type="button" onClick={onToggle} aria-expanded={show} className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left">
        <span className="min-w-0 flex-1 text-sm font-medium">{item.question}</span>
        <span className="shrink-0 pt-0.5 text-[11px] text-muted" suppressHydrationWarning>
          {pending ? "" : failed ? <span className="text-red-300">failed</span> : when(item.startedAt)}
        </span>
      </button>
      {show && (
        <div className="border-t border-line px-4 py-3">
          {pending ? (
            <Thinking item={item} />
          ) : failed ? (
            <p className="text-sm text-red-300">{item.error ?? "Something went wrong."}</p>
          ) : item.answer ? (
            <Markdown>{item.answer}</Markdown>
          ) : (
            <p className="text-sm text-muted">No answer was saved for this run.</p>
          )}
          {item.runId && !pending && (
            <Link href={`/agents/runs/${item.runId}`} className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-brand-light">
              How Jarvis worked this out <Icon name="arrow" className="size-3" />
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function Thinking({ item }: { item: JarvisItem }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - Date.parse(item.startedAt)) / 1000));
  return (
    <p className="flex items-center gap-2 text-sm text-soft" role="status">
      <span className="thinking" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      Jarvis is thinking… <span className="num text-xs text-muted" suppressHydrationWarning>{secs}s{item.toolCalls ? ` · ${item.toolCalls} lookups` : ""}</span>
    </p>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", ...(sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" }) });
}

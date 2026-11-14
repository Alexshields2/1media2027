import Link from "next/link";
import { ChatIcon } from "./agent-icon";

/**
 * Home's Ask Jarvis box. Asking opens the Jarvis chat and sends the question there, continuing
 * the last Jarvis chat if it was used in the last few hours (see app/chat/[agent]/[[...conversation]]/page.tsx).
 * A plain GET form, so it works before any JavaScript loads.
 */
export function AskJarvis({ suggestions, recent, apiReady }: { suggestions: string[]; recent: { id: number; title: string; updatedAt: string }[]; apiReady: boolean }) {
  return (
    <div className="mt-8 w-full max-w-xl">
      <form action="/chat/jarvis" method="get">
        <input type="hidden" name="continue" value="1" />
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 shadow-[0_0_40px_rgb(4_153_242/0.10)] focus-within:border-brand/60">
          <ChatIcon name="spark" className="size-4 shrink-0 text-brand-light" />
          <input
            name="q"
            required
            maxLength={2000}
            autoComplete="off"
            placeholder="Ask Jarvis anything…"
            aria-label="Ask Jarvis"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-ink/35"
          />
          <button type="submit" aria-label="Ask" className="brand-gradient grid size-9 shrink-0 place-items-center rounded-full text-white shadow-[0_0_18px_rgb(4_153_242/0.5)]">
            <ChatIcon name="send" className="size-4" />
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <Link key={s} href={`/chat/jarvis?continue=1&q=${encodeURIComponent(s)}`} className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink/60 hover:border-brand/40 hover:text-ink">
            {s}
          </Link>
        ))}
      </div>
      {!apiReady && <p className="mt-6 text-center text-xs text-amber-300/80">Jarvis can&rsquo;t answer until ANTHROPIC_API_KEY is added in Vercel.</p>}

      {recent.length > 0 && (
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between px-1 text-xs text-ink/40">
            <span>Recent Jarvis chats</span>
            <Link href="/chat/jarvis" className="hover:text-ink">
              All chats →
            </Link>
          </div>
          <ul className="space-y-1.5" aria-label="Recent Jarvis chats">
            {recent.map((c) => (
              <li key={c.id}>
                <Link href={`/chat/jarvis/${c.id}`} className="flex items-center gap-3 rounded-xl border border-line bg-panel/80 px-4 py-2.5 text-sm hover:border-brand/40">
                  <ChatIcon name="chat" className="size-4 shrink-0 text-ink/35" />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="shrink-0 text-[11px] text-ink/35">
                    {new Date(c.updatedAt).toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short" })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

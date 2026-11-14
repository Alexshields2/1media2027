import Link from "next/link";
import type { AgentRun, Brief } from "@/db/schema";
import { Badge, Card, Empty, btnBrand } from "../../_components/ui";
import { SubmitButton } from "../../_components/client-bits";
import { prepForCall } from "./call-prep-actions";

const when = (d: Date) => d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Latest call-prep brief with every lead by name, plus the "Prep for call" button. */
export function CallPrepCard({ clientId, brief, lastRun, started }: { clientId: number; brief?: Brief; lastRun?: AgentRun; started: boolean }) {
  const running = lastRun?.status === "running";
  const failed = lastRun && (lastRun.status === "error" || lastRun.status === "stopped") && (!brief || lastRun.startedAt > brief.createdAt);
  return (
    <Card
      title="Call prep"
      actions={
        <form action={prepForCall.bind(null, clientId)}>
          <SubmitButton className={`${btnBrand} !px-3 !py-1 text-xs`} pendingText="Starting…">
            Prep for call
          </SubmitButton>
        </form>
      }
    >
      {(started || running) && (
        <p className="mb-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-xs text-brand-light">
          Call prep is running. The brief appears here when it&apos;s done (refresh in a minute).
        </p>
      )}
      {failed && !running && (
        <p className="mb-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          The last call prep didn&apos;t finish: {(lastRun.summary ?? lastRun.status).slice(0, 200)}{" "}
          <Link href={`/agents/runs/${lastRun.id}`} className="underline">
            See the run
          </Link>
        </p>
      )}
      {brief ? (
        <div className="space-y-3 text-sm">
          <div>
            <div className="font-medium">{brief.title}</div>
            <div className="text-xs text-muted">
              Written {when(brief.createdAt)}
              {brief.callAt && <> · call {when(brief.callAt)}</>}
            </div>
          </div>
          {brief.leads.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Every lead ({brief.leads.length})</div>
              <ul className="divide-y divide-line/70">
                {brief.leads.map((l, i) => (
                  <li key={i} className="flex items-start justify-between gap-2 py-1.5">
                    <span>
                      <span className="font-medium">{l.name}</span>
                      {l.note && <span className="block text-xs text-muted">{l.note}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-soft">
                      {l.stage}
                      {typeof l.daysSinceContact === "number" && <span>· {l.daysSinceContact}d</span>}
                      {l.untouched && <Badge tone="red" dot>untouched</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted">No leads listed in this brief.</p>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-soft hover:text-ink">Full brief</summary>
            <pre className="mt-2 rounded-xl border border-line bg-canvas/60 p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap text-soft">{brief.body}</pre>
          </details>
        </div>
      ) : (
        !started && !running && <Empty icon="mail" title="No call prep yet" compact>
            Click Prep for call before the next call: every lead by name, the numbers and questions to ask.
          </Empty>
      )}
    </Card>
  );
}

/** Inbox notes the inbox agent left for this client. */
export function InboxNotesCard({ notes }: { notes: Brief[] }) {
  if (!notes.length) return null;
  return (
    <Card title="Inbox">
      <ul className="divide-y divide-line/70 text-sm">
        {notes.map((n) => (
          <li key={n.id} className="py-2">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{n.title}</span>
              <span>{when(n.createdAt)}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-soft">{n.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

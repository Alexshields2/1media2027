import Link from "next/link";
import { desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/approvals";
import { canDecide } from "@/lib/roles";
import { approve, reject } from "../actions";
import { Badge, Card, Empty, List, PageHeader, btnBrand, btnGhost, btnLink } from "../_components/ui";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { pending: "yellow", approved: "blue", executed: "green", rejected: "gray", failed: "red" };

/** Shows the fields that matter for an email or message first, then the rest. */
function Preview({ input }: { input: Record<string, unknown> }) {
  const body = (input.body ?? input.message_body ?? input.text ?? input.message) as string | undefined;
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !["body", "message_body", "text", "message"].includes(k)));
  return (
    <div className="space-y-2 text-sm">
      {Object.keys(rest).length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-canvas/50 px-4 py-3">
          {Object.entries(rest).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-xs font-medium text-muted">{k.replaceAll("_", " ")}</dt>
              <dd className="break-all text-white">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {typeof body === "string" && <pre className="rounded-xl border border-line bg-canvas/70 p-4 font-sans leading-relaxed whitespace-pre-wrap text-soft">{body}</pre>}
    </div>
  );
}

const decider = alias(schema.users, "decider");

const VERB: Record<string, string> = { approved: "Approved", executed: "Approved", failed: "Approved", rejected: "Rejected" };

export default async function ApprovalsPage() {
  const user = await requireUser();
  const [pending, recent] = await Promise.all([
    db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).orderBy(desc(schema.approvals.createdAt)),
    db
      .select({ a: schema.approvals, by: decider.name })
      .from(schema.approvals)
      .leftJoin(decider, eq(decider.id, schema.approvals.decidedBy))
      .where(ne(schema.approvals.status, "pending"))
      .orderBy(desc(schema.approvals.decidedAt))
      .limit(20),
  ]);

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Anything an agent wants to send, charge or change outside the OS waits here for you."
        actions={pending.length ? <Badge tone="yellow" dot>{pending.length} waiting</Badge> : <Badge tone="green" dot>All clear</Badge>}
      />
      {pending.length ? (
        <div className="space-y-4">
          {pending.map((a) => (
            <Card
              key={a.id}
              className="border-brand/25 shadow-[0_0_40px_rgb(4_153_242/0.06)]"
              title={
                <span className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-canvas/60 text-brand-light">
                    <Icon name={a.tool.includes("GMAIL") || a.tool.includes("EMAIL") ? "mail" : a.tool.includes("STRIPE") ? "euro" : "spark"} />
                  </span>
                  <span className="min-w-0">
                    <span className="block first-letter:uppercase">{describeAction(a.tool, a.input)}</span>
                    <span className="block text-xs font-normal text-muted">
                      <span className="capitalize">{a.agent}</span> agent · <span className="font-mono">{a.tool}</span> · {a.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                </span>
              }
              actions={<Badge tone="yellow" dot>Pending</Badge>}
            >
              <Preview input={a.input} />
              {a.reason && (
                <p className="mt-3 flex gap-1.5 text-xs text-muted">
                  <Icon name="info" className="mt-px size-3.5 shrink-0" /> {a.reason}
                </p>
              )}
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                {canDecide(user.role, a.agent, a.tool) ? (
                  <>
                    <form action={approve.bind(null, a.id)}>
                      <SubmitButton className={btnBrand} pendingText="Running…">
                        <Icon name="check" /> Approve and run
                      </SubmitButton>
                    </form>
                    <form action={reject.bind(null, a.id)}>
                      <SubmitButton className={btnGhost}>Reject</SubmitButton>
                    </form>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs text-soft">
                    <Icon name="lock" className="size-3.5" /> Finance action: an owner has to decide this one
                  </span>
                )}
                {a.runId && (
                  <Link href={`/agents/runs/${a.runId}`} className={`${btnLink} ml-auto`}>
                    See the run <Icon name="arrow" className="size-3" />
                  </Link>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="shield" title="Nothing waiting for approval" action={<Link href="/agents" className={btnGhost}>See agent runs</Link>}>
            When an agent wants to send an email, charge a card or post to Slack, it waits here for your OK.
          </Empty>
        </Card>
      )}

      <Card title="Recently decided" className="mt-8">
        {recent.length ? (
          <List>
            {recent.map(({ a, by }) => (
              <li key={a.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium text-white capitalize">{a.agent}</span> <span className="text-soft">· {describeAction(a.tool, a.input)}</span>
                  </span>
                  <Badge tone={TONE[a.status]} dot>
                    {a.status}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {VERB[a.status] ?? "Decided"} by {by ?? "unknown (before sign-ins)"}
                  {a.decidedAt && ` · ${a.decidedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                </p>
                {a.status === "failed" && a.result && <p className="mt-1 text-xs text-red-300">{a.result.slice(0, 300)}</p>}
              </li>
            ))}
          </List>
        ) : (
          <Empty icon="history" compact>
            Nothing decided yet.
          </Empty>
        )}
      </Card>
    </>
  );
}

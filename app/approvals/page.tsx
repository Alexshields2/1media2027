import Link from "next/link";
import { desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/approvals";
import { canDecide } from "@/lib/roles";
import { approve, reject } from "../actions";
import { Badge, Card, Empty, PageHeader, btnBrand, btnGhost } from "../_components/ui";
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
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {Object.entries(rest).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink/50">{k}</dt>
              <dd className="break-all">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {typeof body === "string" && <pre className="rounded-md bg-ink/[0.03] p-3 font-sans whitespace-pre-wrap">{body}</pre>}
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
      <PageHeader title="Approvals" subtitle="Anything an agent wants to send, charge or change outside the OS waits here for you." />
      {pending.length ? (
        <div className="space-y-4">
          {pending.map((a) => (
            <Card
              key={a.id}
              title={describeAction(a.tool, a.input)}
              actions={
                <span className="text-xs text-ink/50">
                  {a.agent} · {a.tool} · {a.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}
                </span>
              }
            >
              <Preview input={a.input} />
              {a.reason && <p className="mt-3 text-xs text-ink/50">{a.reason}</p>}
              <div className="mt-4 flex gap-2">
                {canDecide(user.role, a.agent, a.tool) ? (
                  <>
                    <form action={approve.bind(null, a.id)}>
                      <SubmitButton className={btnBrand} pendingText="Running…">
                        Approve and run
                      </SubmitButton>
                    </form>
                    <form action={reject.bind(null, a.id)}>
                      <SubmitButton className={btnGhost}>Reject</SubmitButton>
                    </form>
                  </>
                ) : (
                  <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink/50">Finance action: an owner has to decide this one</span>
                )}
                {a.runId && (
                  <Link href={`/agents/runs/${a.runId}`} className="self-center text-xs text-ink/50 underline">
                    See the run
                  </Link>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>Nothing waiting for approval.</Empty>
        </Card>
      )}

      <Card title="Recently decided" className="mt-6">
        {recent.length ? (
          <ul className="divide-y divide-line/70 text-sm">
            {recent.map(({ a, by }) => (
              <li key={a.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium">{a.agent}</span> · {describeAction(a.tool, a.input)}
                  </span>
                  <Badge tone={TONE[a.status]}>{a.status}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink/45">
                  {VERB[a.status] ?? "Decided"} by {by ?? "unknown (before sign-ins)"}
                  {a.decidedAt && ` · ${a.decidedAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                </p>
                {a.status === "failed" && a.result && <p className="mt-1 text-xs text-red-400">{a.result.slice(0, 300)}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing yet.</Empty>
        )}
      </Card>
    </>
  );
}

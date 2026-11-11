import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue, paymentState } from "@/lib/billing";
import { can } from "@/lib/roles";
import { eur, monthLabel } from "@/lib/dates";
import { setupProgress } from "@/lib/setup";
import { updateClient } from "../../actions";
import { Badge, Card, Empty } from "../../_components/ui";
import { ClientForm } from "../client-form";
import { ClientLogo } from "../../_components/client-logo";
import { requireUser } from "@/lib/session";
import { SignalList } from "../../health/signals";
import { CallPrepCard, InboxNotesCard } from "./call-prep";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = { paid: "green", part: "yellow", overdue: "red", due: "yellow", upcoming: "gray" };

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ prep?: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  const prepStarted = (await searchParams).prep === "started";
  if (!Number.isInteger(id)) notFound();
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  if (!client) notFound();

  const [payments, tasks, health, reports, briefs, [prepRun]] = await Promise.all([
    can(user.role, "payments") ? db.select().from(schema.payments).where(eq(schema.payments.clientId, id)).orderBy(desc(schema.payments.period)).limit(12) : Promise.resolve(null),
    db.select().from(schema.tasks).where(eq(schema.tasks.clientId, id)).orderBy(desc(schema.tasks.createdAt)).limit(15),
    db.select().from(schema.healthChecks).where(eq(schema.healthChecks.clientId, id)).orderBy(desc(schema.healthChecks.weekOf)).limit(8),
    db.select().from(schema.reports).where(eq(schema.reports.clientId, id)).orderBy(desc(schema.reports.createdAt)).limit(8),
    db.select().from(schema.briefs).where(eq(schema.briefs.clientId, id)).orderBy(desc(schema.briefs.createdAt)).limit(10),
    db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.agent, "meetings"), like(schema.agentRuns.instruction, `%(client_id ${id})%`)))
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(1),
  ]);
  const callPrep = briefs.find((b) => b.kind === "call_prep");
  const inboxNotes = briefs.filter((b) => b.kind === "inbox").slice(0, 3);

  const money = can(user.role, "client_billing");
  const setup = setupProgress(client, { billing: money });
  const latest = health[0];
  const openTasks = tasks.filter((t) => t.status !== "done").length;
  const sentReports = reports.filter((r) => r.status === "sent").length;
  const site = client.website?.trim();
  const siteHref = site ? (/^https?:\/\//.test(site) ? site : `https://${site}`) : null;
  const STATUS_TONE: Record<string, string> = { active: "green", onboarding: "blue", paused: "yellow", churned: "gray" };
  const glow = latest?.status === "red" ? "bg-red-400 shadow-[0_0_10px_#f87171]" : latest?.status === "yellow" ? "bg-amber-400 shadow-[0_0_10px_#fbbf24]" : latest ? "bg-emerald-400 shadow-[0_0_10px_#34d399]" : "bg-ink/20";
  const stats: { label: string; value: React.ReactNode; hint?: string }[] = [
    ...(money ? [{ label: "Retainer", value: eur(client.retainerExVat), hint: `${eur(amountDue(client))} billed / month` }] : []),
    { label: "Health", value: <span className="flex items-center gap-2"><span className={`size-2.5 rounded-full ${glow}`} />{latest ? latest.status[0].toUpperCase() + latest.status.slice(1) : "Not checked"}</span>, hint: latest ? `Week of ${latest.weekOf}` : "Runs weekdays once set up" },
    { label: "CPL target", value: eur(client.cplTarget, client.reportCurrency), hint: "Cost per lead" },
    { label: "Open tasks", value: String(openTasks), hint: `${tasks.length - openTasks} done` },
    { label: "Set-up", value: `${Math.round((setup.done / setup.total) * 100)}%`, hint: setup.complete ? "Ready for agents" : `${setup.total - setup.done} item(s) missing` },
  ];

  return (
    <>
      <Link href="/clients" className="mb-4 inline-block text-sm text-ink/50 hover:text-ink">← All clients</Link>
      <section className="relative mb-6 overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,rgb(4_153_242/0.18),transparent_60%),radial-gradient(40%_80%_at_100%_100%,rgb(56_196_250/0.08),transparent_70%)]" />
        <div className="relative flex flex-col gap-5 p-6 md:flex-row md:items-center md:p-8">
          <ClientLogo name={client.name} size={96} className="rounded-2xl shadow-[0_0_40px_rgb(4_153_242/0.18)]" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-[-0.02em]">{client.name}</h1>
              <Badge tone={STATUS_TONE[client.status]}>{client.status}</Badge>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink/55">
              {client.industry && <span>{client.industry}</span>}
              {client.contactName && <span>Contact: {client.contactName}</span>}
              {siteHref && (
                <a href={siteHref} target="_blank" rel="noreferrer" className="text-brand-light hover:underline">
                  {site!.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                </a>
              )}
              {client.startDate && <span>Client since {monthLabel(client.startDate)}</span>}
            </p>
          </div>
          <a href="#details" className="self-start rounded-full border border-line bg-canvas/60 px-4 py-2 text-sm hover:border-brand/50 md:self-center">
            Edit details
          </a>
        </div>
        <div className="relative grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((st) => (
            <div key={st.label} className="bg-panel px-6 py-4">
              <div className="text-[11px] font-medium tracking-wide text-ink/45 uppercase">{st.label}</div>
              <div className="num mt-1 text-lg font-semibold">{st.value}</div>
              {st.hint && <div className="text-[11px] text-ink/35">{st.hint}</div>}
            </div>
          ))}
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CallPrepCard clientId={id} brief={callPrep} lastRun={prepRun} started={prepStarted} />
          <InboxNotesCard notes={inboxNotes} />
          <details id="details" open={!setup.complete} className="group rounded-2xl border border-line bg-panel">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold">
              Client details & settings
              <span className="text-xs font-normal text-ink/45 group-open:hidden">Show</span>
              <span className="hidden text-xs font-normal text-ink/45 group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-line p-4">
              <ClientForm client={client} action={updateClient.bind(null, id)} submitLabel="Save changes" showBilling={money} />
            </div>
          </details>
        </div>
        <div className="space-y-6">
          <Card title="Set-up checklist" actions={<Badge tone={setup.complete ? "green" : "yellow"}>{setup.complete ? "Complete" : `${setup.done} of ${setup.total}`}</Badge>}>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-ink/10"
              role="progressbar"
              aria-label="Set-up progress"
              aria-valuemin={0}
              aria-valuemax={setup.total}
              aria-valuenow={setup.done}
            >
              <div className={`h-full rounded-full ${setup.complete ? "bg-emerald-400" : "brand-gradient"}`} style={{ width: `${Math.round((setup.done / setup.total) * 100)}%` }} />
            </div>
            <ul className="mt-3 space-y-2 text-sm">
              {setup.items.map((i) => (
                <li key={i.key} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${i.done ? "bg-emerald-500/15 text-emerald-300" : "ring-1 ring-inset ring-amber-400/50"}`}
                  >
                    {i.done ? "✓" : ""}
                  </span>
                  <span className="min-w-0">
                    {i.done ? (
                      <span className="text-ink/70">{i.label}</span>
                    ) : (
                      <a href={`#${i.field}`} className="font-medium text-amber-300 hover:underline">
                        {i.add}
                      </a>
                    )}
                    <span className="sr-only">{i.done ? " (done)" : " (missing)"}</span>
                    {!i.done && <span className="block text-xs text-ink/50">{i.why}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {payments && (
          <Card title="Payments">
            {payments.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {payments.map((p) => {
                  const s = paymentState(p);
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {monthLabel(p.period)} <span className="text-ink/50">{p.label !== "Retainer" ? `· ${p.label}` : ""}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="num">{eur(p.amountDue)}</span>
                        <Badge tone={STATE_TONE[s]}>{s}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>No payments yet.</Empty>
            )}
          </Card>
          )}
          <Card title="Health">
            {health.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {health.map((h, i) => (
                  <li key={h.id} className="py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-ink/60">Week of {h.weekOf}</span>
                      <Badge tone={h.status}>{h.status}</Badge>
                    </div>
                    {i === 0 && h.signals.length ? (
                      <div className="mt-1">
                        <SignalList signals={h.signals} compact />
                      </div>
                    ) : (
                      h.reason && <p className="mt-0.5 text-ink/70">{h.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No health checks yet.</Empty>
            )}
          </Card>
          <Card title="Tasks">
            {tasks.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <span className={t.status === "done" ? "text-ink/40 line-through" : ""}>{t.title}</span>
                    <span className="text-xs text-ink/50">{t.dueDate}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No tasks.</Empty>
            )}
          </Card>
          <Card title="Reports">
            {reports.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <Link href={`/reports#r${r.id}`} className="hover:underline">
                      {r.kind === "weekly" ? "Weekly" : "Monthly"} · {r.period}
                    </Link>
                    <Badge tone={r.status === "sent" ? "green" : "yellow"}>{r.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No reports yet.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

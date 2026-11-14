import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue, paymentState } from "@/lib/billing";
import { can } from "@/lib/roles";
import { eur, monthLabel } from "@/lib/dates";
import { setupProgress } from "@/lib/setup";
import { updateClient } from "../../actions";
import { Badge, Card, CardLink, DueChip, Empty, HealthDot, List, Progress, btnGhost, healthLabel } from "../../_components/ui";
import { Icon } from "../../_components/icons";
import { today } from "@/lib/dates";
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
  const stats: { label: string; value: React.ReactNode; hint?: string }[] = [
    ...(money ? [{ label: "Retainer", value: eur(client.retainerExVat), hint: `${eur(amountDue(client))} billed / month` }] : []),
    { label: "Health", value: <span className="flex items-center gap-2"><HealthDot status={latest?.status} />{healthLabel(latest?.status)}</span>, hint: latest ? `Week of ${latest.weekOf}` : "Runs weekdays once set up" },
    { label: "CPL target", value: eur(client.cplTarget, client.reportCurrency), hint: "Cost per lead" },
    { label: "Open tasks", value: String(openTasks), hint: `${tasks.length - openTasks} done` },
    { label: "Set-up", value: `${Math.round((setup.done / setup.total) * 100)}%`, hint: setup.complete ? "Ready for agents" : `${setup.total - setup.done} item(s) missing` },
  ];

  return (
    <>
      <Link href="/clients" className="mb-4 inline-flex items-center gap-1 rounded-full text-sm text-muted transition-colors hover:text-white">
        <Icon name="chevronLeft" /> All clients
      </Link>
      <section className="surface relative mb-6 overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,rgb(4_153_242/0.18),transparent_60%),radial-gradient(40%_80%_at_100%_100%,rgb(56_196_250/0.08),transparent_70%)]" />
        <div className="relative flex flex-col gap-5 p-6 md:flex-row md:items-center md:p-8">
          <ClientLogo name={client.name} size={96} className="rounded-2xl shadow-[0_0_40px_rgb(4_153_242/0.18)]" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-[-0.02em] text-white sm:text-3xl">{client.name}</h1>
              <Badge tone={STATUS_TONE[client.status]} dot>
                {client.status}
              </Badge>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-soft">
              {client.industry && <span>{client.industry}</span>}
              {client.contactName && <span>Contact: {client.contactName}</span>}
              {siteHref && (
                <a href={siteHref} target="_blank" rel="noreferrer" className="text-brand-light hover:underline">
                  {site!.replace(/^https?:\/\//, "").replace(/\/$/, "")} <Icon name="external" className="inline size-3.5" />
                </a>
              )}
              {client.startDate && <span>Client since {monthLabel(client.startDate)}</span>}
            </p>
          </div>
          <a href="#details" className={`${btnGhost} self-start md:self-center`}>
            <Icon name="edit" /> Edit details
          </a>
        </div>
        <div className="relative grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((st) => (
            <div key={st.label} className="bg-panel px-5 py-4 sm:px-6">
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{st.label}</div>
              <div className="num mt-1 text-lg font-semibold text-white">{st.value}</div>
              {st.hint && <div className="mt-0.5 text-[11px] text-muted">{st.hint}</div>}
            </div>
          ))}
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CallPrepCard clientId={id} brief={callPrep} lastRun={prepRun} started={prepStarted} />
          <InboxNotesCard notes={inboxNotes} />
          <details id="details" open={!setup.complete} className="group surface scroll-mt-24 rounded-2xl border border-line bg-panel">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-2xl px-5 py-4 text-sm font-semibold text-white">
              <span>
                Client details & settings
                <span className="mt-0.5 block text-xs font-normal text-muted">Contact, billing, integrations and report rules</span>
              </span>
              <Icon name="chevronDown" className="size-4 text-muted transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-line p-5">
              <ClientForm client={client} action={updateClient.bind(null, id)} submitLabel="Save changes" showBilling={money} />
            </div>
          </details>
        </div>
        <div className="space-y-6">
          <Card title="Set-up checklist" actions={<Badge tone={setup.complete ? "green" : "yellow"} dot>{setup.complete ? "Complete" : `${setup.done} of ${setup.total}`}</Badge>}>
            <Progress value={setup.done} max={setup.total} tone={setup.complete ? "green" : "brand"} label="Set-up progress" />
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
                      <span className="text-soft">{i.label}</span>
                    ) : (
                      <a href={`#${i.field}`} className="font-medium text-amber-300 hover:underline">
                        {i.add}
                      </a>
                    )}
                    <span className="sr-only">{i.done ? " (done)" : " (missing)"}</span>
                    {!i.done && <span className="block text-xs text-muted">{i.why}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {payments && (
          <Card title="Payments" actions={<CardLink href="/payments">All payments</CardLink>}>
            {payments.length ? (
              <List>
                {payments.map((p) => {
                  const s = paymentState(p);
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {monthLabel(p.period)} <span className="text-muted">{p.label !== "Retainer" ? `· ${p.label}` : ""}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="num">{eur(p.amountDue)}</span>
                        <Badge tone={STATE_TONE[s]} dot>{s === "part" ? "part paid" : s}</Badge>
                      </span>
                    </li>
                  );
                })}
              </List>
            ) : (
              <Empty icon="euro" compact>No payments yet.</Empty>
            )}
          </Card>
          )}
          <Card title="Health" actions={<CardLink href="/health">Client health</CardLink>}>
            {health.length ? (
              <List>
                {health.map((h, i) => (
                  <li key={h.id} className="py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-soft">Week of {h.weekOf}</span>
                      <span className="flex items-center gap-2 text-sm text-white">
                        <HealthDot status={h.status} size="sm" /> {healthLabel(h.status)}
                      </span>
                    </div>
                    {i === 0 && h.signals.length ? (
                      <div className="mt-1">
                        <SignalList signals={h.signals} compact />
                      </div>
                    ) : (
                      h.reason && <p className="mt-0.5 text-soft">{h.reason}</p>
                    )}
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="pulse" compact>No health checks yet.</Empty>
            )}
          </Card>
          <Card title="Tasks" actions={<CardLink href={`/tasks?client=${id}`}>Board</CardLink>}>
            {tasks.length ? (
              <List>
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <span className={t.status === "done" ? "text-muted line-through" : "text-white"}>{t.title}</span>
                    <DueChip date={t.dueDate} today={today()} done={t.status === "done"} />
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="check" compact>No tasks for this client.</Empty>
            )}
          </Card>
          <Card title="Reports">
            {reports.length ? (
              <List>
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <Link href={`/reports#r${r.id}`} className="hover:underline">
                      {r.kind === "weekly" ? "Weekly" : "Monthly"} · {r.period}
                    </Link>
                    <Badge tone={r.status === "sent" ? "green" : "yellow"} dot>{r.status}</Badge>
                  </li>
                ))}
              </List>
            ) : (
              <Empty icon="doc" compact>No reports yet.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

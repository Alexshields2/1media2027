import Link from "next/link";
import { desc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { eur, weekStart } from "@/lib/dates";
import { resolveHealth, saveHealthAction } from "../actions";
import { Badge, Card, Empty, HealthDot, PageHeader, btn, btnGhost, btnSm, healthLabel, input, label } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { requireUser } from "@/lib/session";
import { SignalList } from "./signals";

export const dynamic = "force-dynamic";

const ISSUES = ["Everything Healthy", "Campaign Learning", "Client Concern", "Budget Issue", "Tracking Issue", "Poor Lead Quality", "Creative Fatigue", "Lead Volume Down", "CPL Rising", "Leads Not Worked"];
const ORDER = { red: 0, yellow: 1, green: 2 } as const;
const RING = { red: "border-red-400/30 shadow-[0_0_40px_rgb(248_113_113/0.08)]", yellow: "border-amber-400/25", green: "border-line" } as const;
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", timeZone: "UTC" });

export default async function HealthPage() {
  await requireUser();
  const thisWeek = weekStart();
  // This week and the five before it.
  const weeks = Array.from({ length: 6 }, (_, i) => new Date(Date.parse(`${thisWeek}T12:00:00Z`) - (5 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
  const [rows, clients] = await Promise.all([
    db
      .select({ h: schema.healthChecks, client: schema.clients })
      .from(schema.healthChecks)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.healthChecks.clientId))
      .where(gte(schema.healthChecks.weekOf, weeks[0]))
      .orderBy(desc(schema.healthChecks.weekOf), schema.clients.name),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.status, "active")).orderBy(schema.clients.name),
  ]);
  const current = rows.filter((r) => r.h.weekOf === thisWeek).sort((a, b) => ORDER[a.h.status] - ORDER[b.h.status] || a.client.name.localeCompare(b.client.name));
  const unchecked = clients.filter((c) => !current.some((r) => r.client.id === c.id));
  const historyOf = (clientId: number) => new Map(rows.filter((r) => r.client.id === clientId).map((r) => [r.h.weekOf, r.h.status]));
  const count = (s: "red" | "yellow" | "green") => current.filter((r) => r.h.status === s).length;

  return (
    <>
      <PageHeader
        title="Client health"
        subtitle={`Week of ${shortDate(thisWeek)} · scored each weekday morning from Meta Ads and GHL: CPL vs target, lead volume vs the previous 4 weeks, creative fatigue and leads untouched for over 24h.`}
        actions={
          <a href="#log" className={btnGhost}>
            <Icon name="edit" /> Log a check
          </a>
        }
      />

      <div className="mb-6 grid grid-cols-3 gap-3">
        {(["red", "yellow", "green"] as const).map((s) => (
          <div key={s} className="surface flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 sm:px-5 sm:py-4">
            <HealthDot status={s} size="lg" />
            <div>
              <div className="num text-2xl font-semibold text-white">{count(s)}</div>
              <div className="text-xs text-muted">{s === "red" ? "Red" : s === "yellow" ? "Yellow" : "Green"}</div>
            </div>
          </div>
        ))}
      </div>

      {current.length || unchecked.length ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {current.map(({ h, client }) => {
            const hist = historyOf(client.id);
            return (
              <article key={h.id} className={`surface flex min-w-0 flex-col rounded-2xl border bg-panel p-5 ${RING[h.status]}`}>
                <header className="flex items-start gap-3">
                  <ClientLogo name={client.name} size={44} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/clients/${client.id}`} className="block truncate font-semibold text-white hover:text-brand-light">
                      {client.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-sm">
                      <HealthDot status={h.status} />
                      <span className="font-medium text-white">{healthLabel(h.status)}</span>
                      {h.issue && <span className="truncate text-muted">· {h.issue}</span>}
                    </div>
                  </div>
                  {h.resolved && (
                    <Badge tone="green" dot>
                      Resolved
                    </Badge>
                  )}
                </header>

                <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-line bg-canvas/50 p-3 text-center">
                  <div>
                    <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">CPL</dt>
                    <dd className={`num mt-0.5 font-semibold ${h.cpl != null && client.cplTarget != null && h.cpl > client.cplTarget ? "text-red-300" : "text-white"}`}>{eur(h.cpl, client.reportCurrency)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">Target</dt>
                    <dd className="num mt-0.5 font-semibold text-soft">{eur(client.cplTarget, client.reportCurrency)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">Leads</dt>
                    <dd className="num mt-0.5 font-semibold text-white">{h.leads ?? "–"}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex-1 text-soft">
                  {h.signals.length ? <SignalList signals={h.signals} /> : <p className="text-sm">{h.reason}</p>}
                  {h.source === "manual" && <span className="mt-1 block text-xs text-muted">Logged by hand</span>}
                </div>

                {h.actionNeeded && h.status !== "green" && (
                  <p className="mt-4 flex gap-2 rounded-xl border border-line bg-canvas/50 px-3 py-2.5 text-sm text-white">
                    <Icon name="bolt" className="mt-0.5 size-4 shrink-0 text-brand-light" />
                    {h.actionNeeded}
                  </p>
                )}

                <footer className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
                  <History weeks={weeks} hist={hist} />
                  {!h.resolved && h.status !== "green" && (
                    <form action={resolveHealth.bind(null, h.id)}>
                      <button className={`${btnGhost} ${btnSm}`} aria-label={`Mark ${client.name} resolved`}>
                        <Icon name="check" className="size-3.5" /> Resolve
                      </button>
                    </form>
                  )}
                </footer>
              </article>
            );
          })}
          {unchecked.map((c) => (
            <article key={c.id} className="flex min-w-0 flex-col rounded-2xl border border-dashed border-line bg-panel/40 p-5">
              <header className="flex items-center gap-3">
                <ClientLogo name={c.name} size={44} />
                <div className="min-w-0">
                  <Link href={`/clients/${c.id}`} className="block truncate font-semibold text-white hover:text-brand-light">
                    {c.name}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-sm text-muted">
                    <HealthDot status={null} /> Not checked this week
                  </div>
                </div>
              </header>
              <p className="mt-4 flex-1 text-sm text-muted">The health agent scores clients with Meta Ads and GHL set up. Log a check by hand below if you know how they&rsquo;re doing.</p>
              <footer className="mt-4 border-t border-line pt-3">
                <History weeks={weeks} hist={historyOf(c.id)} />
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="pulse" title="No checks yet" action={<a href="#log" className={btn}>Log a check</a>}>
            The health agent runs each weekday morning. Add active clients with Meta Ads and GHL set up to see them here.
          </Empty>
        </Card>
      )}

      <Card title="Log a check by hand" description="For anything the numbers don't show: a client concern, tracking issues, a campaign still learning." className="mt-8" id="log">
        <form action={saveHealthAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <div className="lg:col-span-2">
            <label className={label} htmlFor="h-client">
              Client
            </label>
            <select id="h-client" name="clientId" required className={input}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="h-status">
              Status
            </label>
            <select id="h-status" name="status" className={input}>
              <option value="green">Green</option>
              <option value="yellow">Yellow</option>
              <option value="red">Red</option>
            </select>
          </div>
          <div className="lg:col-span-2">
            <label className={label} htmlFor="h-issue">
              Issue
            </label>
            <select id="h-issue" name="issue" className={input}>
              {ISSUES.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="h-cpl">
              CPL
            </label>
            <input id="h-cpl" name="cpl" inputMode="decimal" placeholder="e.g. 14.50" className={`${input} num`} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className={label} htmlFor="h-reason">
              Reason
            </label>
            <input id="h-reason" name="reason" placeholder="What you saw" className={input} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className={label} htmlFor="h-action">
              Action needed
            </label>
            <input id="h-action" name="actionNeeded" placeholder="What to do next" className={input} />
          </div>
          <div className="sm:col-span-2 lg:col-span-6">
            <SubmitButton className={btn}>Save check</SubmitButton>
          </div>
        </form>
      </Card>
    </>
  );
}

/** Six small dots, oldest to newest, one per week. */
function History({ weeks, hist }: { weeks: string[]; hist: Map<string, "green" | "yellow" | "red"> }) {
  const color = { green: "bg-emerald-400", yellow: "bg-amber-400", red: "bg-red-400" };
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">6 wks</span>
      <ol className="flex items-center gap-1.5" aria-label="Last 6 weeks, oldest first">
        {weeks.map((w, i) => {
          const s = hist.get(w);
          const last = i === weeks.length - 1;
          return (
            <li key={w} title={`Week of ${shortDate(w)}: ${s ?? "no check"}`}>
              <span className={`block rounded-full ${last ? "size-3 ring-2 ring-ink/15" : "size-2.5"} ${s ? color[s] : "border border-line-strong bg-transparent"}`} aria-hidden />
              <span className="sr-only">
                Week of {shortDate(w)}: {s ?? "no check"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

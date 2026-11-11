import Link from "next/link";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Client, Report, ReportJob } from "@/db/schema";
import { addMonths, eur, today } from "@/lib/dates";
import { composioEnabled } from "@/lib/composio";
import { monthPeriod, pctChange, reportMonth, reportWeek, shiftWeek, weekPeriod, type Period } from "@/lib/report-metrics";
import { retryFailedReportsAction, retryReportJobAction, runReportsAction, saveReportToDriveAction, setReportStatus, updateReportBody } from "../actions";
import { Badge, Card, Empty, PageHeader, btn, btnBrand, btnGhost } from "../_components/ui";
import { SubmitButton, WhatsAppCopyButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // a fallback run started from here continues in the background

type Kind = "weekly" | "monthly";
type JobState = ReportJob["status"] | "not_started";

const STATE: Record<JobState, { label: string; tone: string }> = {
  done: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  running: { label: "Running", tone: "blue" },
  queued: { label: "Queued", tone: "yellow" },
  skipped: { label: "Skipped", tone: "gray" },
  not_started: { label: "Not run", tone: "gray" },
};

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ view?: string; week?: string; month?: string }> }) {
  const sp = await searchParams;
  const kind: Kind = sp.view === "month" ? "monthly" : "weekly";
  const period: Period =
    kind === "weekly"
      ? sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week)
        ? weekPeriod(sp.week)
        : reportWeek()
      : sp.month && /^\d{4}-\d{2}$/.test(sp.month)
        ? monthPeriod(sp.month)
        : reportMonth();
  const prev = kind === "weekly" ? weekPeriod(shiftWeek(period.period, -1)) : monthPeriod(addMonths(period.start, -1));
  const next = kind === "weekly" ? weekPeriod(shiftWeek(period.period, 1)) : monthPeriod(addMonths(period.start, 1));
  const latest = kind === "weekly" ? reportWeek() : reportMonth();
  const href = (p: Period) => (kind === "weekly" ? `/reports?view=week&week=${p.period}` : `/reports?view=month&month=${p.period}`);

  const [jobs, reportRows, prevReports, activeClients, olderDrafts] = await Promise.all([
    db.select().from(schema.reportJobs).where(and(eq(schema.reportJobs.kind, kind), eq(schema.reportJobs.period, period.period))),
    db
      .select({ r: schema.reports, client: schema.clients })
      .from(schema.reports)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.reports.clientId))
      .where(and(eq(schema.reports.kind, kind), eq(schema.reports.period, period.period)))
      .orderBy(asc(schema.clients.name), desc(schema.reports.updatedAt)),
    db.select().from(schema.reports).where(and(eq(schema.reports.kind, kind), eq(schema.reports.period, prev.period))),
    db.select().from(schema.clients).where(eq(schema.clients.status, "active")).orderBy(asc(schema.clients.name)),
    db
      .select({ period: schema.reports.period })
      .from(schema.reports)
      .where(and(eq(schema.reports.kind, kind), eq(schema.reports.status, "draft")))
      .orderBy(desc(schema.reports.period)),
  ]);

  // One card per client: the newest report for the period.
  const seen = new Set<number>();
  const reports = reportRows.filter(({ r }) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true)));
  const prevByClient = new Map(prevReports.map((r) => [r.clientId, r]));
  const jobByClient = new Map(jobs.map((j) => [j.clientId, j]));

  // Status strip: active clients plus anyone with a job or report this period.
  const extraIds = [...new Set([...jobs.map((j) => j.clientId), ...reports.map(({ r }) => r.clientId)])].filter((id) => !activeClients.some((c) => c.id === id));
  const extra = extraIds.length ? await db.select().from(schema.clients).where(inArray(schema.clients.id, extraIds)) : [];
  const stripClients = [...activeClients, ...extra];
  const reportByClient = new Map(reports.map(({ r }) => [r.clientId, r]));
  const stateOf = (c: Client): JobState => {
    const j = jobByClient.get(c.id);
    if (j) return j.status;
    return reportByClient.has(c.id) ? "done" : "not_started";
  };
  const counts = stripClients.reduce<Record<string, number>>((acc, c) => ((acc[stateOf(c)] = (acc[stateOf(c)] ?? 0) + 1), acc), {});
  const missing = activeClients.filter((c) => !jobByClient.has(c.id) && !reportByClient.has(c.id)).length;
  const failed = counts.failed ?? 0;
  const otherDraftPeriods = [...new Set(olderDrafts.map((d) => d.period).filter((p) => p !== period.period))];
  const driveReady = composioEnabled();

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={kind === "weekly" ? "Monday WhatsApp reports, one per client. Check the numbers, copy into WhatsApp, then mark sent." : "Month-end reports with a PDF for each client."}
        actions={
          <div className="flex rounded-full border border-line bg-panel p-0.5 text-sm">
            <Link href="/reports?view=week" className={`rounded-full px-3 py-1.5 ${kind === "weekly" ? "bg-brand-soft text-brand-light" : "text-ink/60 hover:text-ink"}`}>
              Weekly
            </Link>
            <Link href="/reports?view=month" className={`rounded-full px-3 py-1.5 ${kind === "monthly" ? "bg-brand-soft text-brand-light" : "text-ink/60 hover:text-ink"}`}>
              Month-end
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={href(prev)} className={btnGhost} aria-label="Previous">
            ←
          </Link>
          <div className="px-2">
            <div className="text-xs uppercase tracking-wide text-ink/50">{kind === "weekly" ? "Week" : "Month"}</div>
            <div className="font-semibold">{kind === "weekly" ? `${period.label} ${period.end.slice(0, 4)}` : period.label}</div>
          </div>
          <Link href={href(next)} className={btnGhost} aria-label="Next">
            →
          </Link>
          {period.period !== latest.period && (
            <Link href={href(latest)} className="text-xs text-ink/50 underline hover:text-ink">
              Latest
            </Link>
          )}
        </div>
        {otherDraftPeriods.length > 0 && (
          <p className="text-xs text-ink/50">
            Unsent drafts also in{" "}
            {otherDraftPeriods.slice(0, 3).map((p, i) => (
              <span key={p}>
                {i > 0 && ", "}
                <Link href={kind === "weekly" ? `/reports?view=week&week=${p}` : `/reports?view=month&month=${p}`} className="underline hover:text-ink">
                  {kind === "weekly" ? weekPeriod(p).label : monthPeriod(p).label}
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>

      <Card
        title="Run status"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {failed > 0 && (
              <form action={retryFailedReportsAction.bind(null, kind, period.period)}>
                <SubmitButton className={btnGhost} pendingText="Retrying…">
                  Retry {failed} failed
                </SubmitButton>
              </form>
            )}
            {missing > 0 && (
              <form action={runReportsAction.bind(null, kind, period.period)}>
                <SubmitButton className={btnBrand} pendingText="Starting…">
                  {jobs.length || reports.length ? `Run ${missing} missing` : kind === "weekly" ? "Run this week's reports" : "Run month-end reports"}
                </SubmitButton>
              </form>
            )}
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-ink/60">
          {(["done", "running", "queued", "failed", "skipped", "not_started"] as JobState[])
            .filter((s) => counts[s])
            .map((s) => (
              <span key={s} className="num">
                {STATE[s].label}: <b className="text-ink">{counts[s]}</b>
              </span>
            ))}
          <span className="text-ink/40">{kind === "weekly" ? "Runs Mondays 07:00 UTC" : "Runs on the 1st, 09:00 UTC"} · one job per client · failed jobs retry up to 3 times</span>
        </div>
        {stripClients.length ? (
          <ul className="flex flex-wrap gap-2">
            {stripClients.map((c) => {
              const s = stateOf(c);
              const j = jobByClient.get(c.id);
              const canRetry = j && (s === "failed" || s === "skipped" || s === "queued");
              return (
                <li key={c.id} className="flex items-center gap-2 rounded-xl border border-line bg-canvas/60 py-1.5 pl-3 pr-1.5 text-sm" title={j?.lastError ?? undefined}>
                  <a href={reportByClient.has(c.id) ? `#c${c.id}` : undefined} className={reportByClient.has(c.id) ? "hover:underline" : ""}>
                    {c.name}
                  </a>
                  <Badge tone={STATE[s].tone}>
                    {STATE[s].label}
                    {j && j.attempts > 1 ? ` · try ${j.attempts}` : ""}
                  </Badge>
                  {canRetry ? (
                    <form action={retryReportJobAction.bind(null, j.id)}>
                      <SubmitButton className="rounded-full border border-line px-2.5 py-0.5 text-xs hover:border-brand/50" pendingText="…">
                        Retry
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="w-1" />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No active clients.</Empty>
        )}
        {jobs.some((j) => j.lastError && (j.status === "failed" || j.status === "skipped")) && (
          <ul className="mt-3 space-y-1 text-xs text-ink/50">
            {jobs
              .filter((j) => j.lastError && (j.status === "failed" || j.status === "skipped"))
              .map((j) => (
                <li key={j.id}>
                  <span className="text-ink/70">{stripClients.find((c) => c.id === j.clientId)?.name}:</span> {j.lastError?.slice(0, 220)}
                  {j.runId ? (
                    <>
                      {" "}
                      <Link href={`/agents/runs/${j.runId}`} className="underline hover:text-ink">
                        run
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </Card>

      <div className="mt-6 space-y-4">
        {reports.length ? (
          reports.map(({ r, client }) => <ReportCard key={r.id} r={r} client={client} prev={prevByClient.get(client.id)} kind={kind} driveReady={driveReady} />)
        ) : (
          <Card>
            <Empty>
              No {kind === "weekly" ? "weekly" : "month-end"} reports for {period.label} yet.{" "}
              {period.period === latest.period && today() >= period.end ? "Run them above, or wait for the scheduled run." : ""}
            </Empty>
          </Card>
        )}
      </div>
    </>
  );
}

function Num({ label, value, delta, goodWhenDown, hint }: { label: string; value: string; delta?: number | null; goodWhenDown?: boolean; hint?: string }) {
  const good = delta != null && delta !== 0 && (goodWhenDown ? delta < 0 : delta > 0);
  return (
    <div className="rounded-xl border border-line bg-canvas/60 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink/50">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold">{value}</div>
      <div className="num h-4 text-[11px] text-ink/50">
        {delta != null && delta !== 0 ? (
          <span className={good ? "text-emerald-400" : "text-red-400"}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}%
          </span>
        ) : null}
        {hint ? <span className="ml-1">{hint}</span> : null}
      </div>
    </div>
  );
}

function ReportCard({ r, client, prev, kind, driveReady }: { r: Report; client: Client; prev?: Report; kind: Kind; driveReady: boolean }) {
  const cur = client.reportCurrency;
  const fmtInt = (n: number | null) => (n == null ? "–" : n.toLocaleString("en-IE"));
  const overTarget = r.cpl != null && client.cplTarget != null && r.cpl > client.cplTarget;
  const taId = `body-${r.id}`;
  return (
    <section id={`c${client.id}`} className="scroll-mt-4">
      <Card
        title={client.name}
        actions={
          <div className="flex items-center gap-2">
            {r.status === "sent" && r.sentAt && <span className="text-xs text-ink/50">sent {r.sentAt.toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short" })}</span>}
            <Badge tone={r.status === "sent" ? "green" : "yellow"}>{r.status}</Badge>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Num label="Spend" value={eur(r.spend, cur)} delta={pctChange(r.spend, prev?.spend)} />
          <Num label="Leads" value={fmtInt(r.leads)} delta={pctChange(r.leads, prev?.leads)} />
          <Num label="CPL" value={eur(r.cpl, cur)} delta={pctChange(r.cpl, prev?.cpl)} goodWhenDown hint={client.cplTarget != null ? `target ${eur(client.cplTarget, cur)}${overTarget ? " · over" : ""}` : undefined} />
          <Num label="Impressions" value={fmtInt(r.impressions)} delta={pctChange(r.impressions, prev?.impressions)} />
          <Num label="Link clicks" value={fmtInt(r.clicks)} delta={pctChange(r.clicks, prev?.clicks)} />
          <Num label="CTR" value={r.ctr == null ? "–" : `${r.ctr.toFixed(2)}%`} delta={pctChange(r.ctr, prev?.ctr)} />
        </div>
        {prev && <p className="mt-1 text-[11px] text-ink/40">Changes are against the previous {kind === "weekly" ? "week" : "month"}.</p>}

        {kind === "monthly" && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <a href={`/reports/${r.id}/pdf`} className={btn}>
              Download PDF
            </a>
            {r.driveUrl ? (
              <a href={r.driveUrl} target="_blank" rel="noreferrer" className={btnGhost}>
                Open in Drive
              </a>
            ) : (
              <span className="text-xs text-ink/50">{r.driveError ?? "Not in Drive yet."}</span>
            )}
            {driveReady && client.driveFolderId && (
              <form action={saveReportToDriveAction.bind(null, r.id)}>
                <SubmitButton className="text-xs text-ink/50 underline hover:text-ink" pendingText="Saving…">
                  {r.driveUrl ? "Save again to Drive" : "Save to Drive"}
                </SubmitButton>
              </form>
            )}
          </div>
        )}

        <form action={updateReportBody.bind(null, r.id)} className="mt-3">
          <textarea id={taId} name="body" defaultValue={r.body} rows={Math.min(22, r.body.split("\n").length + 1)} className="w-full rounded-md border border-line bg-ink/[0.02] p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-brand" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <WhatsAppCopyButton textareaId={taId} className={btn} />
            <SubmitButton className={btnGhost}>Save edits</SubmitButton>
            <span className="grow" />
          </div>
        </form>
        <form action={setReportStatus.bind(null, r.id, r.status === "sent" ? "draft" : "sent")} className="mt-2">
          {r.status === "sent" ? (
            <button className="text-xs text-ink/50 underline hover:text-ink">Mark as draft</button>
          ) : (
            <SubmitButton className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20">Mark sent</SubmitButton>
          )}
        </form>
      </Card>
    </section>
  );
}

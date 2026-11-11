import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { eur } from "@/lib/dates";
import { setReportStatus, updateReportBody } from "../actions";
import { Badge, Card, Empty, PageHeader, btnGhost, btn } from "../_components/ui";
import { CopyButton, SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const sp = await searchParams;
  const showSent = sp.show === "all";
  const rows = await db
    .select({ r: schema.reports, client: schema.clients })
    .from(schema.reports)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.reports.clientId))
    .where(showSent ? undefined : eq(schema.reports.status, "draft"))
    .orderBy(desc(schema.reports.createdAt))
    .limit(100);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Drafts from the weekly and month-end agents. Check, copy into WhatsApp or email, then mark sent."
        actions={
          <Link href={showSent ? "/reports" : "/reports?show=all"} className={btnGhost}>
            {showSent ? "Drafts only" : "Show sent too"}
          </Link>
        }
      />
      {rows.length ? (
        <div className="space-y-4">
          {rows.map(({ r, client }) => (
            <Card
              key={r.id}
              title={`${client.name} · ${r.kind === "weekly" ? "week of" : ""} ${r.period}`}
              actions={
                <div className="flex items-center gap-2">
                  {r.leads != null && <span className="num text-xs text-ink/50">{r.leads} leads · {eur(r.spend, client.reportCurrency)} · CPL {eur(r.cpl, client.reportCurrency)}</span>}
                  <Badge tone={r.status === "sent" ? "green" : "yellow"}>{r.status}</Badge>
                </div>
              }
            >
              <div id={`r${r.id}`} />
              <form action={updateReportBody.bind(null, r.id)}>
                <textarea name="body" defaultValue={r.body} rows={Math.min(24, r.body.split("\n").length + 1)} className="w-full rounded-md border border-ink/10 bg-ink/[0.02] p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-brand" />
                <div className="mt-2 flex flex-wrap gap-2">
                  <CopyButton text={r.body} className={btn} />
                  <SubmitButton className={btnGhost}>Save edits</SubmitButton>
                </div>
              </form>
              <form action={setReportStatus.bind(null, r.id, r.status === "sent" ? "draft" : "sent")} className="mt-2">
                <button className="text-xs text-ink/50 underline hover:text-ink">{r.status === "sent" ? "Mark as draft" : "Mark as sent"}</button>
              </form>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>No {showSent ? "" : "draft "}reports. The weekly-report agent writes them every Monday morning.</Empty>
        </Card>
      )}
    </>
  );
}

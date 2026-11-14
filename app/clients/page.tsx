import Link from "next/link";
import { desc, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue } from "@/lib/billing";
import { can } from "@/lib/roles";
import { eur, weekStart } from "@/lib/dates";
import { setupProgress } from "@/lib/setup";
import { ClientBanner, ClientLogo } from "../_components/client-logo";
import { Badge, Card, Empty, HealthDot, PageHeader, Progress, Segmented, Table, btn, healthLabel, td, tdNum } from "../_components/ui";
import { Icon } from "../_components/icons";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = { active: "green", onboarding: "blue", paused: "yellow", churned: "gray" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; view?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = sp.q?.trim();
  const view = sp.view === "table" ? "table" : "cards";
  const like = q ? `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%` : undefined;
  const [clients, health] = await Promise.all([
    db
      .select()
      .from(schema.clients)
      .where(like ? or(ilike(schema.clients.name, like), ilike(schema.clients.contactName, like), ilike(schema.clients.email, like)) : undefined)
      .orderBy(schema.clients.name),
    db.select().from(schema.healthChecks).where(eq(schema.healthChecks.weekOf, weekStart())).orderBy(desc(schema.healthChecks.updatedAt)),
  ]);
  const healthBy = new Map(health.map((h) => [h.clientId, h]));
  const money = can(user.role, "client_billing");

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={q ? `${clients.length} matching “${q}”` : `${clients.filter((c) => c.status === "active").length} active`}
        actions={
          <>
            <Segmented
              label="View"
              items={(["cards", "table"] as const).map((v) => ({
                href: `/clients?${new URLSearchParams({ ...(q ? { q } : {}), ...(v === "table" ? { view: v } : {}) })}`,
                label: v === "cards" ? "Gallery" : "Table",
                icon: v === "cards" ? ("grid" as const) : ("list" as const),
                active: view === v,
              }))}
            />
            <Link href="/clients/new" className={btn}>
              <Icon name="plus" /> Add client
            </Link>
          </>
        }
      />
      {view === "cards" ? (
        clients.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {clients.map((c) => {
              const h = healthBy.get(c.id);
              const setup = setupProgress(c, { billing: money });
              const pct = Math.round((setup.done / setup.total) * 100);
              return (
                <Link
                  key={c.id}
                  href={`/clients/${c.id}`}
                  className="group surface overflow-hidden rounded-2xl border border-line bg-panel transition duration-200 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 hover:border-brand/50 hover:shadow-[0_8px_40px_rgb(4_153_242/0.15)]"
                >
                  <div className="relative">
                    <ClientBanner name={c.name} className="h-32 border-b border-line" />
                    <span className="absolute top-3 right-3">
                      <Badge tone={STATUS_TONE[c.status]} dot className="backdrop-blur">
                        {c.status}
                      </Badge>
                    </span>
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-white group-hover:text-brand-light">{c.name}</div>
                        <div className="truncate text-xs text-muted">{[c.industry, c.contactName].filter(Boolean).join(" · ") || "No industry set"}</div>
                      </div>
                      {money && (
                        <div className="shrink-0 text-right">
                          <div className="num text-sm font-semibold text-white">{eur(c.retainerExVat)}</div>
                          <div className="text-[11px] text-muted">per month</div>
                        </div>
                      )}
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-soft">
                        <HealthDot status={h?.status} size="sm" />
                        {h ? `${h.status[0].toUpperCase()}${h.status.slice(1)} this week` : "No health check yet"}
                      </span>
                      <span className="num text-muted">{setup.complete ? "Set up" : `${setup.done}/${setup.total} set up`}</span>
                    </div>
                    <Progress value={pct} max={100} tone={setup.complete ? "green" : "brand"} label={`${c.name} set-up`} className="mt-2 !h-1" />
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <Card>
            <Empty icon="users" title={q ? `No clients match “${q}”` : "No clients yet"} action={q ? <Link href="/clients" className={btn}>Show all clients</Link> : <Link href="/clients/new" className={btn}><Icon name="plus" /> Add your first client</Link>}>
              {q ? "Try a business name, contact or email." : "Add a client to start billing, reporting and health checks."}
            </Empty>
          </Card>
        )
      ) : (
      <Card flush>
        {clients.length ? (
          <Table head={["Client", "Status", ...(money ? [{ label: "Retainer", align: "right" as const }, { label: "Billed / month", align: "right" as const }] : []), { label: "CPL target", align: "right" }, "This week", "Set up"]} minWidth={820}>
            {clients.map((c) => {
              const h = healthBy.get(c.id);
              const setup = setupProgress(c, { billing: money });
              return (
                <tr key={c.id}>
                  <td className="px-4 py-3 first:pl-5 last:pr-5">
                    <div className="flex items-center gap-3">
                      <ClientLogo name={c.name} size={36} />
                      <div className="min-w-0">
                        <Link href={`/clients/${c.id}`} className="font-medium text-white hover:text-brand-light">
                          {c.name}
                        </Link>
                        {c.industry && <div className="text-xs text-muted">{c.industry}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 first:pl-5 last:pr-5">
                    <Badge tone={STATUS_TONE[c.status]} dot>
                      {c.status}
                    </Badge>
                  </td>
                  {money && <td className={tdNum}>{eur(c.retainerExVat)}</td>}
                  {money && <td className={`${tdNum} text-soft`}>{eur(amountDue(c))}</td>}
                  <td className={tdNum}>{eur(c.cplTarget, c.reportCurrency)}</td>
                  <td className={td}>
                    <span className="flex items-center gap-2">
                      <HealthDot status={h?.status} size="sm" />
                      <span className={h ? "text-white" : "text-muted"}>{h ? healthLabel(h.status) : "Not checked"}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 first:pl-5 last:pr-5 text-xs">
                    {setup.complete ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300"><Icon name="check" className="size-3.5" /> Complete</span>
                    ) : (
                      <Link href={`/clients/${c.id}`} className="text-amber-300 hover:underline" title={`${setup.done} of ${setup.total} set up`}>
                        <span className="num text-muted">{setup.done}/{setup.total}</span> Missing {setup.missing.map((i) => i.short).join(", ")}
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty icon="users" title={q ? `No clients match “${q}”` : "No clients yet"} action={<Link href="/clients/new" className={btn}><Icon name="plus" /> Add client</Link>} />
        )}
      </Card>
      )}
    </>
  );
}

import Link from "next/link";
import { desc, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue } from "@/lib/billing";
import { can } from "@/lib/roles";
import { eur, weekStart } from "@/lib/dates";
import { setupProgress } from "@/lib/setup";
import { ClientBanner, ClientLogo } from "../_components/client-logo";
import { Badge, Card, Empty, PageHeader, Table, btn } from "../_components/ui";
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
            <div className="flex rounded-full border border-line bg-panel p-0.5 text-sm">
              {(["cards", "table"] as const).map((v) => (
                <Link
                  key={v}
                  href={`/clients?${new URLSearchParams({ ...(q ? { q } : {}), ...(v === "table" ? { view: v } : {}) })}`}
                  className={`rounded-full px-3 py-1 ${view === v ? "bg-ink/[0.08] font-medium" : "text-ink/55 hover:text-ink"}`}
                >
                  {v === "cards" ? "Gallery" : "Table"}
                </Link>
              ))}
            </div>
            <Link href="/clients/new" className={btn}>
              Add client
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
                  className="group overflow-hidden rounded-2xl border border-line bg-panel transition duration-200 hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_8px_40px_rgb(4_153_242/0.15)]"
                >
                  <div className="relative">
                    <ClientBanner name={c.name} className="h-32 border-b border-line" />
                    <span className="absolute top-3 right-3">
                      <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                    </span>
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold group-hover:text-brand-light">{c.name}</div>
                        <div className="truncate text-xs text-ink/45">{[c.industry, c.contactName].filter(Boolean).join(" · ") || "No industry set"}</div>
                      </div>
                      {money && (
                        <div className="shrink-0 text-right">
                          <div className="num text-sm font-semibold">{eur(c.retainerExVat)}</div>
                          <div className="text-[10px] text-ink/40">per month</div>
                        </div>
                      )}
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-ink/60">
                        <span className={`size-2 rounded-full ${h ? (h.status === "green" ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : h.status === "yellow" ? "bg-amber-400 shadow-[0_0_8px_#fbbf24]" : "bg-red-400 shadow-[0_0_8px_#f87171]") : "bg-ink/20"}`} />
                        {h ? `${h.status[0].toUpperCase()}${h.status.slice(1)} this week` : "No health check yet"}
                      </span>
                      <span className="num text-ink/45">{setup.complete ? "Set up" : `${setup.done}/${setup.total} set up`}</span>
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/[0.07]">
                      <div className={`h-full rounded-full ${setup.complete ? "bg-emerald-400" : "brand-gradient"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <Card>
            <Empty>
              No clients yet. <Link href="/clients/new" className="text-brand underline">Add your first client</Link>.
            </Empty>
          </Card>
        )
      ) : (
      <Card>
        {clients.length ? (
          <Table head={["Client", "Status", ...(money ? ["Retainer", "Billed / month"] : []), "CPL target", "This week", "Set up"]}>
            {clients.map((c) => {
              const h = healthBy.get(c.id);
              const setup = setupProgress(c, { billing: money });
              return (
                <tr key={c.id} className="hover:bg-ink/[0.02]">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <ClientLogo name={c.name} size={36} />
                      <div className="min-w-0">
                        <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        {c.industry && <div className="text-xs text-ink/50">{c.industry}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </td>
                  {money && <td className="num px-4 py-2.5">{eur(c.retainerExVat)}</td>}
                  {money && <td className="num px-4 py-2.5">{eur(amountDue(c))}</td>}
                  <td className="num px-4 py-2.5">{eur(c.cplTarget, c.reportCurrency)}</td>
                  <td className="px-4 py-2.5">{h ? <Badge tone={h.status}>{h.status}</Badge> : <span className="text-ink/30">–</span>}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {setup.complete ? (
                      <span className="text-emerald-400">Complete</span>
                    ) : (
                      <Link href={`/clients/${c.id}`} className="text-amber-400 hover:underline" title={`${setup.done} of ${setup.total} set up`}>
                        <span className="num text-ink/50">{setup.done}/{setup.total}</span> Missing {setup.missing.map((i) => i.short).join(", ")}
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>
            No clients yet. <Link href="/clients/new" className="text-brand underline">Add your first client</Link>.
          </Empty>
        )}
      </Card>
      )}
    </>
  );
}

import Link from "next/link";
import { desc, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue } from "@/lib/billing";
import { can } from "@/lib/roles";
import { eur, weekStart } from "@/lib/dates";
import { setupProgress } from "@/lib/setup";
import { Badge, Card, Empty, PageHeader, Table, btn } from "../_components/ui";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = { active: "green", onboarding: "blue", paused: "yellow", churned: "gray" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const q = (await searchParams).q?.trim();
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
          <Link href="/clients/new" className={btn}>
            Add client
          </Link>
        }
      />
      <Card>
        {clients.length ? (
          <Table head={["Client", "Status", ...(money ? ["Retainer", "Billed / month"] : []), "CPL target", "This week", "Set up"]}>
            {clients.map((c) => {
              const h = healthBy.get(c.id);
              const setup = setupProgress(c, { billing: money });
              return (
                <tr key={c.id} className="hover:bg-ink/[0.02]">
                  <td className="px-4 py-2.5">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    {c.industry && <div className="text-xs text-ink/50">{c.industry}</div>}
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
    </>
  );
}

import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { amountDue } from "@/lib/billing";
import { eur, weekStart } from "@/lib/dates";
import { Badge, Card, Empty, PageHeader, Table, btn } from "../_components/ui";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = { active: "green", onboarding: "blue", paused: "yellow", churned: "gray" };

export default async function ClientsPage() {
  const [clients, health] = await Promise.all([
    db.select().from(schema.clients).orderBy(schema.clients.name),
    db.select().from(schema.healthChecks).where(eq(schema.healthChecks.weekOf, weekStart())).orderBy(desc(schema.healthChecks.updatedAt)),
  ]);
  const healthBy = new Map(health.map((h) => [h.clientId, h]));

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={`${clients.filter((c) => c.status === "active").length} active`}
        actions={
          <Link href="/clients/new" className={btn}>
            Add client
          </Link>
        }
      />
      <Card>
        {clients.length ? (
          <Table head={["Client", "Status", "Retainer", "Billed / month", "CPL target", "This week", "Set up"]}>
            {clients.map((c) => {
              const h = healthBy.get(c.id);
              const missing = [!c.metaAdAccountIds && "Meta", !c.ghlLocationId && "GHL", c.billingMethod === "stripe" && !c.stripeCustomerId && "Stripe"].filter(Boolean);
              return (
                <tr key={c.id} className="hover:bg-black/[0.02]">
                  <td className="px-4 py-2.5">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    {c.industry && <div className="text-xs text-black/50">{c.industry}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </td>
                  <td className="num px-4 py-2.5">{eur(c.retainerExVat)}</td>
                  <td className="num px-4 py-2.5">{eur(amountDue(c))}</td>
                  <td className="num px-4 py-2.5">{eur(c.cplTarget, c.reportCurrency)}</td>
                  <td className="px-4 py-2.5">{h ? <Badge tone={h.status}>{h.status}</Badge> : <span className="text-black/30">–</span>}</td>
                  <td className="px-4 py-2.5 text-xs">{missing.length ? <span className="text-amber-700">Missing {missing.join(", ")}</span> : <span className="text-emerald-700">Complete</span>}</td>
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

import Link from "next/link";
import { and, desc, eq, gte, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { today } from "@/lib/dates";
import { createTask, setTaskStatus } from "../actions";
import { Badge, Card, Empty, PageHeader, btn, field, input } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

const COLUMNS = [
  { key: "todo", title: "To do" },
  { key: "in_progress", title: "In progress" },
  { key: "review", title: "Review" },
  { key: "done", title: "Done (last 7 days)" },
] as const;

const NEXT: Record<string, { to: "todo" | "in_progress" | "review" | "done"; label: string }[]> = {
  todo: [{ to: "in_progress", label: "Start" }, { to: "done", label: "Done" }],
  in_progress: [{ to: "review", label: "Review" }, { to: "done", label: "Done" }],
  review: [{ to: "done", label: "Done" }, { to: "in_progress", label: "Back" }],
  done: [{ to: "todo", label: "Reopen" }],
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const sp = await searchParams;
  const clientFilter = sp.client ? Number(sp.client) : undefined;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [rows, clients] = await Promise.all([
    db
      .select({ t: schema.tasks, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(or(ne(schema.tasks.status, "done"), gte(schema.tasks.completedAt, weekAgo)), clientFilter ? eq(schema.tasks.clientId, clientFilter) : undefined))
      .orderBy(schema.tasks.dueDate, desc(schema.tasks.createdAt)),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(schema.clients.name),
  ]);
  const t0 = today();

  return (
    <>
      <PageHeader
        title="Tasks"
        actions={
          <form className="flex gap-2">
            <select name="client" defaultValue={sp.client ?? ""} className={field} aria-label="Filter by client">
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={btn}>Filter</button>
          </form>
        }
      />

      <Card title="New task" className="mb-6">
        <form action={createTask} className="grid gap-3 sm:grid-cols-6">
          <input name="title" required placeholder="What needs doing" className={`${input} sm:col-span-2`} />
          <select name="clientId" defaultValue={sp.client ?? ""} className={input} aria-label="Client">
            <option value="">No client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue="medium" className={input} aria-label="Priority">
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <input name="dueDate" type="date" className={input} aria-label="Due date" />
          <SubmitButton className={btn}>Add task</SubmitButton>
        </form>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = rows.filter((r) => r.t.status === col.key);
          return (
            <Card key={col.key} title={`${col.title} · ${items.length}`}>
              {items.length ? (
                <ul className="space-y-2">
                  {items.map(({ t, client }) => (
                    <li key={t.id} className="rounded-lg border border-ink/10 p-3 text-sm">
                      <div className="font-medium">{t.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink/50">
                        {client && (
                          <Link href={`/clients/${t.clientId}`} className="hover:underline">
                            {client}
                          </Link>
                        )}
                        {t.dueDate && <span className={t.dueDate < t0 && t.status !== "done" ? "font-medium text-red-400" : ""}>due {t.dueDate}</span>}
                        {t.priority === "high" && <Badge tone="red">high</Badge>}
                        {t.source === "agent" && <Badge tone="brand">agent</Badge>}
                      </div>
                      {t.details && <details className="mt-1 text-xs text-ink/70"><summary className="cursor-pointer text-ink/50">Details</summary><p className="mt-1 whitespace-pre-line">{t.details}</p></details>}
                      <div className="mt-2 flex gap-1.5">
                        {NEXT[t.status].map((n) => (
                          <form key={n.to} action={setTaskStatus.bind(null, t.id, n.to)}>
                            <button className="rounded border border-ink/10 px-2 py-0.5 text-xs hover:bg-ink/5">{n.label}</button>
                          </form>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Empty</Empty>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

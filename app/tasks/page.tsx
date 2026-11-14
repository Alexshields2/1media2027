import Link from "next/link";
import { and, desc, eq, gte, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { today } from "@/lib/dates";
import { createTask, setTaskStatus } from "../actions";
import { Card, DueChip, PageHeader, btn, btnGhost, field, input, label } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Status = "todo" | "in_progress" | "review" | "done";

const COLUMNS: { key: Status; title: string; hint: string; accent: string }[] = [
  { key: "todo", title: "To do", hint: "Not started", accent: "bg-muted" },
  { key: "in_progress", title: "In progress", hint: "Being worked on", accent: "bg-brand-light shadow-[0_0_8px_#38c4fa]" },
  { key: "review", title: "Review", hint: "Waiting for a check", accent: "bg-amber-400 shadow-[0_0_8px_#fbbf24]" },
  { key: "done", title: "Done", hint: "Last 7 days", accent: "bg-emerald-400 shadow-[0_0_8px_#34d399]" },
];
const TITLE = Object.fromEntries(COLUMNS.map((c) => [c.key, c.title])) as Record<Status, string>;
const ORDER = COLUMNS.map((c) => c.key);
const PRIORITY: Record<string, { label: string; cls: string }> = {
  high: { label: "High", cls: "text-red-300" },
  medium: { label: "Medium", cls: "text-amber-300" },
  low: { label: "Low", cls: "text-muted" },
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await requireUser();
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
  const open = rows.filter((r) => r.t.status !== "done");
  const overdue = open.filter((r) => r.t.dueDate && r.t.dueDate < t0).length;
  const filtered = clients.find((c) => c.id === clientFilter);

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={
          <>
            {open.length} open{overdue ? <span className="text-red-300"> · {overdue} overdue</span> : null}
            {filtered && <> · {filtered.name}</>}
          </>
        }
        actions={
          <form className="flex items-center gap-2" role="search" aria-label="Filter tasks">
            <select name="client" defaultValue={sp.client ?? ""} className={`${field} max-w-52`} aria-label="Filter by client">
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={btnGhost}>Filter</button>
            {filtered && (
              <Link href="/tasks" className="text-xs text-muted hover:text-white">
                Clear
              </Link>
            )}
          </form>
        }
      />

      <Card className="mb-6">
        <form action={createTask} className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_8rem_10rem_auto] lg:items-end">
          <div className="col-span-2 lg:col-span-1">
            <label className={label} htmlFor="task-title">
              New task
            </label>
            <input id="task-title" name="title" required placeholder="What needs doing?" className={input} />
          </div>
          <div className="col-span-2 lg:col-span-1">
            <label className={label} htmlFor="task-client">
              Client
            </label>
            <select id="task-client" name="clientId" defaultValue={sp.client ?? ""} className={input}>
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="task-priority">
              Priority
            </label>
            <select id="task-priority" name="priority" defaultValue="medium" className={input}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="task-due">
              Due
            </label>
            <input id="task-due" name="dueDate" type="date" className={input} />
          </div>
          <SubmitButton className={`${btn} col-span-2 lg:col-span-1`} pendingText="Adding…">
            <Icon name="plus" /> Add task
          </SubmitButton>
        </form>
      </Card>

      {/* The board: four columns on wide screens; on phones the columns scroll sideways inside the board. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 md:mx-0 md:px-0 xl:overflow-visible">
        <div className="grid snap-x snap-mandatory auto-cols-[minmax(17rem,85%)] grid-flow-col gap-4 sm:auto-cols-[19rem] xl:grid-flow-row xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const items = rows.filter((r) => r.t.status === col.key);
            return (
              <section key={col.key} aria-labelledby={`col-${col.key}`} className="flex min-w-0 snap-start flex-col rounded-2xl border border-line bg-panel/50">
                <header className="flex items-center gap-2 px-4 pt-4 pb-3">
                  <span className={`size-2 rounded-full ${col.accent}`} aria-hidden />
                  <h2 id={`col-${col.key}`} className="text-sm font-semibold text-white">
                    {col.title}
                  </h2>
                  <span className="num rounded-full bg-ink/[0.07] px-2 py-0.5 text-[11px] font-semibold text-soft" aria-label={`${items.length} tasks`}>
                    {items.length}
                  </span>
                  <span className="ml-auto text-[11px] text-muted">{col.hint}</span>
                </header>
                <ul className="flex flex-1 flex-col gap-2.5 px-3 pb-3">
                  {items.length ? (
                    items.map(({ t, client }) => <TaskCard key={t.id} t={t} client={client} t0={t0} />)
                  ) : (
                    <li className="grid flex-1 place-items-center rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs text-muted">
                      {col.key === "done" ? "Nothing finished this week yet." : col.key === "todo" ? "Nothing to do. Add a task above." : "Nothing here right now."}
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TaskCard({ t, client, t0 }: { t: typeof schema.tasks.$inferSelect; client: string | null; t0: string }) {
  const i = ORDER.indexOf(t.status);
  const prev = i > 0 ? ORDER[i - 1] : null;
  const next = i < ORDER.length - 1 ? ORDER[i + 1] : null;
  const done = t.status === "done";
  const p = PRIORITY[t.priority];
  return (
    <li className={`group rounded-xl border border-line bg-canvas/70 p-3 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset] transition hover:border-line-strong hover:bg-panel-2 ${done ? "opacity-75" : ""}`}>
      {client && (
        <Link href={`/clients/${t.clientId}`} className="mb-2 flex items-center gap-2 text-xs text-soft hover:text-white">
          <ClientLogo name={client} size={22} className="rounded-md" />
          <span className="truncate">{client}</span>
        </Link>
      )}
      <div className={`text-sm leading-snug font-medium ${done ? "text-soft line-through decoration-ink/30" : "text-white"}`}>{t.title}</div>
      {t.details && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-muted hover:text-white">Details</summary>
          <p className="mt-1 whitespace-pre-line text-soft">{t.details}</p>
        </details>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <DueChip date={t.dueDate} today={t0} done={done} />
        {!done && (
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${p.cls}`}>
            <Icon name="flag" className="size-3" />
            {p.label}
          </span>
        )}
        {t.source === "agent" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-light">
            <Icon name="spark" className="size-3" /> Agent
          </span>
        )}
        {t.assignee && <span className="text-[11px] text-muted">· {t.assignee}</span>}
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 pt-2.5">
        {prev && (
          <form action={setTaskStatus.bind(null, t.id, prev)}>
            <button
              className="grid size-7 place-items-center rounded-full border border-line text-muted transition-colors hover:border-brand/50 hover:text-white"
              aria-label={`Move “${t.title}” back to ${TITLE[prev]}`}
              title={`Back to ${TITLE[prev]}`}
            >
              <Icon name="chevronLeft" className="size-3.5" />
            </button>
          </form>
        )}
        {next && (
          <form action={setTaskStatus.bind(null, t.id, next)}>
            <button
              className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-xs font-medium text-soft transition-colors hover:border-brand/50 hover:text-white"
              aria-label={`Move “${t.title}” to ${TITLE[next]}`}
            >
              {TITLE[next]}
              <Icon name="chevronRight" className="size-3.5" />
            </button>
          </form>
        )}
        {!done && next !== "done" && (
          <form action={setTaskStatus.bind(null, t.id, "done")} className="ml-auto">
            <button
              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10"
              aria-label={`Mark “${t.title}” done`}
            >
              <Icon name="check" className="size-3.5" /> Done
            </button>
          </form>
        )}
        {done && (
          <form action={setTaskStatus.bind(null, t.id, "todo")} className="ml-auto">
            <button className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted transition-colors hover:text-white" aria-label={`Reopen “${t.title}”`}>
              <Icon name="undo" className="size-3.5" /> Reopen
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

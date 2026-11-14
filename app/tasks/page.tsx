import Link from "next/link";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, ne, or, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Task, User } from "@/db/schema";
import { today, weekStart } from "@/lib/dates";
import { allUsers, isManager, requireUser } from "@/lib/session";
import { canAssign, downline } from "@/lib/team";
import { createTask, deleteTask, setTaskStatus, updateTask } from "../actions";
import { Badge, Card, Empty, PageHeader, btn, btnGhost, field, input, label } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

type Status = Task["status"];
const STATUS_LABEL: Record<Status, string> = { todo: "To do", in_progress: "In progress", review: "Review", done: "Done" };
const COLUMNS: Status[] = ["todo", "in_progress", "review", "done"];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

const NEXT: Record<Status, { to: Status; label: string }[]> = {
  todo: [{ to: "in_progress", label: "Start" }, { to: "done", label: "Done" }],
  in_progress: [{ to: "review", label: "Review" }, { to: "done", label: "Done" }],
  review: [{ to: "done", label: "Done" }, { to: "in_progress", label: "Back" }],
  done: [{ to: "todo", label: "Reopen" }],
};

type SP = {
  q?: string;
  view?: string;
  who?: string;
  assignee?: string;
  client?: string;
  priority?: string;
  status?: string;
  due?: string;
  source?: string;
  sort?: string;
  group?: string;
};

function addDays(d: string, n: number) {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const users = await allUsers();
  const t0 = today();
  const weekEnd = addDays(weekStart(), 6);
  const view = sp.view === "list" ? "list" : "board";
  const status = sp.status ?? "open";
  const myTeam = downline(users, me.id);

  // ---- filters ----
  const conds: (SQL | undefined)[] = [];
  if (sp.q) conds.push(or(ilike(schema.tasks.title, `%${sp.q}%`), ilike(schema.tasks.details, `%${sp.q}%`)));
  if (sp.who === "mine") conds.push(eq(schema.tasks.assigneeId, me.id));
  if (sp.who === "delegated") conds.push(and(eq(schema.tasks.createdById, me.id), ne(schema.tasks.assigneeId, me.id)));
  if (sp.who === "team") conds.push(myTeam.length ? inArray(schema.tasks.assigneeId, myTeam) : eq(schema.tasks.id, -1));
  if (sp.who === "unassigned") conds.push(isNull(schema.tasks.assigneeId));
  if (sp.assignee) conds.push(eq(schema.tasks.assigneeId, Number(sp.assignee)));
  if (sp.client) conds.push(sp.client === "none" ? isNull(schema.tasks.clientId) : eq(schema.tasks.clientId, Number(sp.client)));
  if (sp.priority) conds.push(eq(schema.tasks.priority, sp.priority as Task["priority"]));
  if (sp.source) conds.push(eq(schema.tasks.source, sp.source as Task["source"]));
  if (sp.due === "overdue") conds.push(and(lt(schema.tasks.dueDate, t0), ne(schema.tasks.status, "done")));
  if (sp.due === "today") conds.push(eq(schema.tasks.dueDate, t0));
  if (sp.due === "week") conds.push(and(gte(schema.tasks.dueDate, weekStart()), lte(schema.tasks.dueDate, weekEnd)));
  if (sp.due === "none") conds.push(isNull(schema.tasks.dueDate));
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  if (status === "open") conds.push(or(ne(schema.tasks.status, "done"), gte(schema.tasks.completedAt, weekAgo)));
  else if (status !== "all") conds.push(eq(schema.tasks.status, status as Status));

  const [rows, clients, counts] = await Promise.all([
    db
      .select({ t: schema.tasks, client: schema.clients.name })
      .from(schema.tasks)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
      .where(and(...conds))
      .orderBy(schema.tasks.dueDate, desc(schema.tasks.createdAt))
      .limit(500),
    db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).orderBy(schema.clients.name),
    db.select({ status: schema.tasks.status, due: schema.tasks.dueDate, assigneeId: schema.tasks.assigneeId, createdById: schema.tasks.createdById }).from(schema.tasks).where(ne(schema.tasks.status, "done")),
  ]);

  const sorted = [...rows].sort((a, b) => {
    switch (sp.sort) {
      case "priority":
        return PRIORITY_RANK[a.t.priority] - PRIORITY_RANK[b.t.priority] || (a.t.dueDate ?? "9").localeCompare(b.t.dueDate ?? "9");
      case "created":
        return b.t.createdAt.getTime() - a.t.createdAt.getTime();
      case "client":
        return (a.client ?? "~").localeCompare(b.client ?? "~");
      case "assignee":
        return nameOf(users, a.t.assigneeId).localeCompare(nameOf(users, b.t.assigneeId));
      default:
        return (a.t.dueDate ?? "9999").localeCompare(b.t.dueDate ?? "9999") || PRIORITY_RANK[a.t.priority] - PRIORITY_RANK[b.t.priority];
    }
  });

  const stats = {
    open: counts.length,
    overdue: counts.filter((c) => c.due && c.due < t0).length,
    week: counts.filter((c) => c.due && c.due >= weekStart() && c.due <= weekEnd).length,
    mine: counts.filter((c) => c.assigneeId === me.id).length,
    delegated: counts.filter((c) => c.createdById === me.id && c.assigneeId !== me.id && c.assigneeId !== null).length,
  };

  const assignable = users.filter((u) => u.active && canAssign(users, me.id, u.id));
  const href = (over: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) p.set(k, v);
    const s = p.toString();
    return `/tasks${s ? `?${s}` : ""}`;
  };
  const filtered = Object.entries(sp).some(([k, v]) => v && !["view", "sort", "group"].includes(k));

  const chips: { label: string; over: Partial<SP>; on: boolean; n?: number }[] = [
    { label: "My tasks", over: { who: sp.who === "mine" ? undefined : "mine" }, on: sp.who === "mine", n: stats.mine },
    { label: "Delegated by me", over: { who: sp.who === "delegated" ? undefined : "delegated" }, on: sp.who === "delegated", n: stats.delegated },
    ...(myTeam.length ? [{ label: "My team", over: { who: sp.who === "team" ? undefined : "team" }, on: sp.who === "team" }] : []),
    { label: "Overdue", over: { due: sp.due === "overdue" ? undefined : "overdue" }, on: sp.due === "overdue", n: stats.overdue },
    { label: "Due this week", over: { due: sp.due === "week" ? undefined : "week" }, on: sp.due === "week", n: stats.week },
    { label: "High priority", over: { priority: sp.priority === "high" ? undefined : "high" }, on: sp.priority === "high" },
    { label: "From agents", over: { source: sp.source === "agent" ? undefined : "agent" }, on: sp.source === "agent" },
    { label: "Unassigned", over: { who: sp.who === "unassigned" ? undefined : "unassigned" }, on: sp.who === "unassigned" },
  ];

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${stats.open} open · ${stats.overdue} overdue · ${stats.mine} on you · ${stats.delegated} you've delegated`}
        actions={
          <div className="flex overflow-hidden rounded-md border border-black/15 bg-white text-sm">
            <Link href={href({ view: "board" })} className={`px-3 py-1.5 ${view === "board" ? "bg-black text-white" : "hover:bg-black/5"}`}>
              Board
            </Link>
            <Link href={href({ view: "list" })} className={`px-3 py-1.5 ${view === "list" ? "bg-black text-white" : "hover:bg-black/5"}`}>
              List
            </Link>
          </div>
        }
      />

      <Card title="New task" className="mb-4">
        <form action={createTask} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <input name="title" required placeholder="What needs doing" className={`${input} lg:col-span-4`} aria-label="Title" />
          <select name="assigneeId" defaultValue={me.id} className={`${input} lg:col-span-2`} aria-label="Assign to">
            <option value="">Unassigned</option>
            {assignable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === me.id ? `Me (${u.name})` : u.name}
              </option>
            ))}
          </select>
          <select name="clientId" defaultValue={sp.client && sp.client !== "none" ? sp.client : ""} className={`${input} lg:col-span-2`} aria-label="Client">
            <option value="">No client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue="medium" className={`${input} lg:col-span-1`} aria-label="Priority">
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <input name="dueDate" type="date" className={`${input} lg:col-span-2`} aria-label="Due date" />
          <SubmitButton className={`${btn} lg:col-span-1`}>Add</SubmitButton>
          <textarea name="details" rows={1} placeholder="Details (optional)" className={`${input} sm:col-span-2 lg:col-span-12`} aria-label="Details" />
        </form>
      </Card>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <Link key={c.label} href={href(c.over)} className={`rounded-full border px-3 py-1 text-xs font-medium ${c.on ? "border-brand bg-brand-soft text-brand" : "border-black/10 bg-white text-black/70 hover:bg-black/5"}`}>
            {c.label}
            {c.n !== undefined && <span className="ml-1 text-black/40">{c.n}</span>}
          </Link>
        ))}
        {filtered && (
          <Link href={href({ q: undefined, who: undefined, assignee: undefined, client: undefined, priority: undefined, status: undefined, due: undefined, source: undefined })} className="px-2 py-1 text-xs text-black/50 underline">
            Clear filters
          </Link>
        )}
      </div>

      <form className="mb-6 grid gap-2 rounded-xl border border-black/10 bg-white p-3 sm:grid-cols-3 lg:grid-cols-8">
        {view === "list" && <input type="hidden" name="view" value="list" />}
        <input name="q" defaultValue={sp.q} placeholder="Search tasks" className={`${field} lg:col-span-2`} aria-label="Search" />
        <select name="assignee" defaultValue={sp.assignee ?? ""} className={field} aria-label="Person">
          <option value="">Anyone</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select name="client" defaultValue={sp.client ?? ""} className={field} aria-label="Client">
          <option value="">All clients</option>
          <option value="none">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} className={field} aria-label="Status">
          <option value="open">Open + done this week</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="review">Review</option>
          <option value="done">Done (all)</option>
          <option value="all">Everything</option>
        </select>
        <select name="due" defaultValue={sp.due ?? ""} className={field} aria-label="Due">
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due this week</option>
          <option value="none">No due date</option>
        </select>
        <select name="priority" defaultValue={sp.priority ?? ""} className={field} aria-label="Priority">
          <option value="">Any priority</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <div className="flex gap-2">
          <select name="source" defaultValue={sp.source ?? ""} className={`${field} min-w-0 flex-1`} aria-label="Created by">
            <option value="">People + agents</option>
            <option value="human">People</option>
            <option value="agent">Agents</option>
          </select>
          <button className={btn}>Filter</button>
        </div>
        {sp.who && <input type="hidden" name="who" value={sp.who} />}
        {view === "list" && (
          <>
            <select name="sort" defaultValue={sp.sort ?? "due"} className={field} aria-label="Sort">
              <option value="due">Sort: due date</option>
              <option value="priority">Sort: priority</option>
              <option value="created">Sort: newest</option>
              <option value="client">Sort: client</option>
              <option value="assignee">Sort: person</option>
            </select>
            <select name="group" defaultValue={sp.group ?? ""} className={field} aria-label="Group">
              <option value="">No grouping</option>
              <option value="assignee">Group: person</option>
              <option value="client">Group: client</option>
              <option value="status">Group: status</option>
            </select>
          </>
        )}
      </form>

      {view === "board" ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const items = sorted.filter((r) => r.t.status === col);
            return (
              <Card key={col} title={`${STATUS_LABEL[col]}${col === "done" && status === "open" ? " (last 7 days)" : ""} · ${items.length}`}>
                {items.length ? (
                  <ul className="space-y-2">
                    {items.map(({ t, client }) => (
                      <li key={t.id} className="rounded-lg border border-black/10 p-3 text-sm">
                        <TaskCard t={t} client={client} users={users} me={me} t0={t0} assignable={assignable} clients={clients} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing here</Empty>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <ListView rows={sorted} group={sp.group} users={users} me={me} t0={t0} assignable={assignable} clients={clients} />
      )}
    </>
  );
}

function nameOf(users: User[], id: number | null) {
  return users.find((u) => u.id === id)?.name ?? "Unassigned";
}

type Row = { t: Task; client: string | null };
type Common = { users: User[]; me: User; t0: string; assignable: User[]; clients: { id: number; name: string }[] };

function ListView({ rows, group, ...c }: { rows: Row[]; group?: string } & Common) {
  if (!rows.length) return <Card><Empty>No tasks match these filters.</Empty></Card>;
  const keyOf = (r: Row) => (group === "assignee" ? nameOf(c.users, r.t.assigneeId) : group === "client" ? (r.client ?? "No client") : group === "status" ? STATUS_LABEL[r.t.status] : "");
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([g, items]) => (
        <Card key={g || "all"} title={g ? `${g} · ${items.length}` : `${items.length} tasks`}>
          <ul className="-my-2 divide-y divide-black/5">
            {items.map(({ t, client }) => (
              <li key={t.id} className="py-2 text-sm">
                <TaskCard t={t} client={client} {...c} row />
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-black/80 text-[10px] font-semibold text-white">{name.slice(0, 1).toUpperCase()}</span>;
}

function TaskCard({ t, client, users, me, t0, assignable, clients, row }: { t: Task; client: string | null; row?: boolean } & Common) {
  const assignee = users.find((u) => u.id === t.assigneeId);
  const from = t.createdById && t.createdById !== t.assigneeId ? users.find((u) => u.id === t.createdById) : undefined;
  const overdue = t.dueDate && t.dueDate < t0 && t.status !== "done";
  const canDelete = isManager(me) || t.createdById === me.id;
  // Keep the current assignee selectable even if `me` couldn't assign to them.
  const options = assignee && !assignable.some((u) => u.id === assignee.id) ? [...assignable, assignee] : assignable;

  return (
    <div className={row ? "flex flex-wrap items-start justify-between gap-x-4 gap-y-2" : ""}>
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${t.status === "done" ? "text-black/40 line-through" : ""}`}>{t.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-black/50">
          {assignee ? (
            <span className="inline-flex items-center gap-1">
              <Avatar name={assignee.name} />
              {assignee.name}
            </span>
          ) : (
            <span className="italic">{t.assignee ?? "Unassigned"}</span>
          )}
          {from && <span>· from {from.name}</span>}
          {client && (
            <Link href={`/clients/${t.clientId}`} className="hover:underline">
              · {client}
            </Link>
          )}
          {t.dueDate && <span className={overdue ? "font-medium text-red-600" : ""}>· due {t.dueDate}</span>}
          {t.priority === "high" && <Badge tone="red">high</Badge>}
          {t.priority === "low" && <Badge tone="gray">low</Badge>}
          {t.source === "agent" && <Badge tone="brand">agent</Badge>}
          {row && <Badge tone={t.status === "done" ? "green" : t.status === "review" ? "yellow" : t.status === "in_progress" ? "blue" : "gray"}>{STATUS_LABEL[t.status]}</Badge>}
        </div>
        {t.details && !row && <p className="mt-1 line-clamp-3 text-xs whitespace-pre-line text-black/60">{t.details}</p>}
      </div>
      <div className={`flex flex-wrap items-center gap-1.5 ${row ? "" : "mt-2"}`}>
        {NEXT[t.status].map((n) => (
          <form key={n.to} action={setTaskStatus.bind(null, t.id, n.to)}>
            <button className="rounded border border-black/10 px-2 py-0.5 text-xs hover:bg-black/5">{n.label}</button>
          </form>
        ))}
        <details className="group w-full [&[open]]:mt-2">
          <summary className="inline cursor-pointer rounded border border-black/10 px-2 py-0.5 text-xs hover:bg-black/5">Edit / delegate</summary>
          <form action={updateTask.bind(null, t.id)} className="mt-2 grid gap-2 rounded-lg bg-black/[0.02] p-2">
            <input name="title" defaultValue={t.title} className={input} aria-label="Title" />
            <textarea name="details" defaultValue={t.details ?? ""} rows={2} placeholder="Details" className={input} aria-label="Details" />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className={label}>Assignee</span>
                <select name="assigneeId" defaultValue={t.assigneeId ?? ""} className={input}>
                  <option value="">Unassigned</option>
                  {options.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className={label}>Client</span>
                <select name="clientId" defaultValue={t.clientId ?? ""} className={input}>
                  <option value="">No client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className={label}>Priority</span>
                <select name="priority" defaultValue={t.priority} className={input}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div>
                <span className={label}>Due</span>
                <input name="dueDate" type="date" defaultValue={t.dueDate ?? ""} className={input} />
              </div>
              <div className="col-span-2">
                <span className={label}>Status</span>
                <select name="status" defaultValue={t.status} className={input}>
                  {COLUMNS.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <SubmitButton className={btn} pendingText="Saving…">
                Save
              </SubmitButton>
              {canDelete && (
                <button formAction={deleteTask.bind(null, t.id)} className={`${btnGhost} text-red-600`}>
                  Delete
                </button>
              )}
            </div>
          </form>
        </details>
      </div>
    </div>
  );
}

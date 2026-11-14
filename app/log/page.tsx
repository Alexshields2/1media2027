import Link from "next/link";
import { and, desc, eq, gte, ilike, inArray, isNull, like, lte, ne, or, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { canSee } from "@/lib/team";
import { Badge, Card, Empty, PageHeader, btn, field } from "../_components/ui";

export const dynamic = "force-dynamic";

const KINDS: [string, string][] = [
  ["task", "Tasks"],
  ["agent", "Agent runs"],
  ["approval", "Approvals"],
  ["payment", "Payments"],
  ["client", "Clients"],
  ["health", "Client health"],
  ["report", "Reports"],
  ["sop", "SOPs"],
  ["eod", "End of day"],
  ["voice", "Voice notes"],
  ["team", "Team"],
  ["auth", "Sign-ins"],
];

const ENTITY_LINK: Record<string, (id: number) => string> = {
  task: () => "/tasks",
  run: (id) => `/agents/runs/${id}`,
  approval: () => "/approvals",
  client: (id) => `/clients/${id}`,
  sop: (id) => `/sops/${id}`,
  eod: () => "/eod",
  voice: () => "/voice",
  report: () => "/reports",
  payment: () => "/payments",
};

const PAGE = 200;

export default async function LogPage({ searchParams }: { searchParams: Promise<{ actor?: string; kind?: string; q?: string; from?: string; to?: string; tools?: string; page?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const users = await allUsers();
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const agentNames = await db.selectDistinct({ a: schema.activity.actor }).from(schema.activity).where(eq(schema.activity.actorType, "agent"));

  const conds: (SQL | undefined)[] = [];
  // People see their own actions, their team's, and all agent/system activity. The owner sees everything.
  if (me.role !== "owner") {
    const visible = users.filter((u) => canSee(users, me.id, u.id)).map((u) => u.id);
    conds.push(or(isNull(schema.activity.userId), inArray(schema.activity.userId, visible)));
  }
  if (sp.actor) conds.push(eq(schema.activity.actor, sp.actor));
  if (sp.kind) conds.push(like(schema.activity.action, `${sp.kind}.%`));
  if (sp.q) conds.push(ilike(schema.activity.summary, `%${sp.q}%`));
  if (sp.from) conds.push(gte(schema.activity.at, new Date(`${sp.from}T00:00:00`)));
  if (sp.to) conds.push(lte(schema.activity.at, new Date(`${sp.to}T23:59:59`)));
  if (sp.tools !== "1") conds.push(ne(schema.activity.action, "agent.tool"));

  const rows = await db
    .select()
    .from(schema.activity)
    .where(and(...conds))
    .orderBy(desc(schema.activity.at))
    .limit(PAGE + 1)
    .offset(page * PAGE);
  const more = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);

  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) p.set(k, v);
    return `/log?${p.toString()}`;
  };

  // Group by day for readability.
  const days = new Map<string, typeof shown>();
  for (const r of shown) {
    const d = r.at.toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", weekday: "long", day: "numeric", month: "long" });
    days.set(d, [...(days.get(d) ?? []), r]);
  }

  return (
    <>
      <PageHeader title="Activity log" subtitle="Everything that happens in 1Media OS: who did what, and every agent run, tool call and approval." />

      <form className="mb-6 grid gap-2 rounded-xl border border-black/10 bg-white p-3 sm:grid-cols-3 lg:grid-cols-7">
        <input name="q" defaultValue={sp.q} placeholder="Search" className={`${field} lg:col-span-2`} aria-label="Search" />
        <select name="actor" defaultValue={sp.actor ?? ""} className={field} aria-label="Who">
          <option value="">Everyone</option>
          <optgroup label="People">
            {users.map((u) => (
              <option key={u.id} value={u.name}>
                {u.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Agents and system">
            {agentNames.map((a) => (
              <option key={a.a} value={a.a}>
                {a.a}
              </option>
            ))}
            <option value="scheduler">scheduler</option>
            <option value="billing">billing</option>
            <option value="stripe">stripe</option>
          </optgroup>
        </select>
        <select name="kind" defaultValue={sp.kind ?? ""} className={field} aria-label="Kind">
          <option value="">Everything</option>
          {KINDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <input type="date" name="from" defaultValue={sp.from} className={field} aria-label="From" />
        <input type="date" name="to" defaultValue={sp.to} className={field} aria-label="To" />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-black/60">
            <input type="checkbox" name="tools" value="1" defaultChecked={sp.tools === "1"} /> Tool calls
          </label>
          <button className={btn}>Filter</button>
        </div>
      </form>

      {shown.length ? (
        <div className="space-y-6">
          {[...days.entries()].map(([day, items]) => (
            <Card key={day} title={day}>
              <ul className="-my-2 divide-y divide-black/5">
                {items.map((r) => {
                  const link = r.entity && r.entityId ? ENTITY_LINK[r.entity]?.(r.entityId) : undefined;
                  return (
                    <li key={r.id} className="flex gap-3 py-2 text-sm">
                      <span className="num w-12 shrink-0 text-xs text-black/40">{r.at.toLocaleTimeString("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="w-24 shrink-0 truncate">
                        <Badge tone={r.actorType === "user" ? "blue" : r.actorType === "agent" ? "brand" : "gray"}>{r.actor}</Badge>
                      </span>
                      <span className={`min-w-0 flex-1 ${r.action === "agent.tool" ? "text-black/50" : ""} ${r.action.endsWith("failed") ? "text-red-700" : ""}`}>
                        {link ? (
                          <Link href={link} className="hover:underline">
                            {r.summary}
                          </Link>
                        ) : (
                          r.summary
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>Nothing logged for these filters.</Empty>
        </Card>
      )}

      <div className="mt-4 flex justify-between text-sm">
        {page > 0 ? <Link href={href({ page: String(page - 1) })} className="underline">← Newer</Link> : <span />}
        {more && <Link href={href({ page: String(page + 1) })} className="underline">Older →</Link>}
      </div>
    </>
  );
}

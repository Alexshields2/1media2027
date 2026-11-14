import { gte, ne, count } from "drizzle-orm";
import { db, schema } from "@/db";
import type { User } from "@/db/schema";
import { today } from "@/lib/dates";
import { allUsers, requireUser } from "@/lib/session";
import { downline } from "@/lib/team";
import { addTeamMember, setPassword, updateTeamMember } from "../actions";
import { Badge, Card, PageHeader, btn, btnGhost, input, label } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const me = await requireUser();
  const users = await allUsers();
  const isOwner = me.role === "owner";
  const t0 = today();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const [openTasks, eods] = await Promise.all([
    db.select({ id: schema.tasks.assigneeId, n: count() }).from(schema.tasks).where(ne(schema.tasks.status, "done")).groupBy(schema.tasks.assigneeId),
    db.select({ id: schema.eodReports.userId, date: schema.eodReports.date }).from(schema.eodReports).where(gte(schema.eodReports.date, weekAgo)),
  ]);
  const roots = users.filter((u) => u.managerId === null || !users.some((m) => m.id === u.managerId));

  function Node({ u, depth }: { u: User; depth: number }) {
    const kids = users.filter((k) => k.managerId === u.id);
    const open = openTasks.find((o) => o.id === u.id)?.n ?? 0;
    const sentToday = eods.some((e) => e.id === u.id && e.date === t0);
    const week = eods.filter((e) => e.id === u.id).length;
    return (
      <li>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2" style={{ marginLeft: depth * 28 }}>
          <span className="grid size-8 place-items-center rounded-full bg-black/80 text-sm font-semibold text-white">{u.name.slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {u.name} {u.id === me.id && <span className="text-xs text-black/40">(you)</span>}
            </div>
            <div className="text-xs text-black/50">
              {u.title ?? u.role}
              {u.managerId ? ` · reports to ${users.find((m) => m.id === u.managerId)?.name}` : ""}
              {kids.length ? ` · delegates to ${kids.map((k) => k.name).join(", ")}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="gray">{open} open tasks</Badge>
            {u.managerId !== null && <Badge tone={sentToday ? "green" : "yellow"}>EOD {sentToday ? "sent today" : "not sent today"} · {week}/7d</Badge>}
            {!u.passwordHash && <Badge tone="red">no password</Badge>}
            {!u.active && <Badge tone="gray">inactive</Badge>}
          </div>
        </div>
        {kids.length > 0 && (
          <ul className="mt-2 space-y-2">
            {kids.map((k) => (
              <Node key={k.id} u={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who reports to whom. You can delegate tasks to anyone below you, and you see their end-of-day reports, voice notes and activity."
      />

      <Card title="Reporting line" className="mb-6">
        <ul className="space-y-2">
          {roots.map((r) => (
            <Node key={r.id} u={r} depth={0} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-black/50">
          You ({me.name}) can delegate to: {[me, ...users.filter((u) => (isOwner ? u.id !== me.id : downline(users, me.id).includes(u.id)))].map((u) => u.name).join(", ")}.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Your password">
          <form action={setPassword.bind(null, me.id)} className="space-y-3">
            {me.passwordHash && !isOwner && (
              <div>
                <label className={label} htmlFor="current">Current password</label>
                <input id="current" name="current" type="password" required className={input} />
              </div>
            )}
            <div>
              <label className={label} htmlFor="newpw">New password (8+ characters)</label>
              <input id="newpw" name="password" type="password" minLength={8} required className={input} />
            </div>
            <SubmitButton className={btn}>Change password</SubmitButton>
          </form>
        </Card>

        {isOwner && (
          <Card title="Add someone">
            <form action={addTeamMember} className="grid gap-3 sm:grid-cols-2">
              <input name="name" required placeholder="Name" className={input} aria-label="Name" />
              <input name="title" placeholder="Title, e.g. Account manager" className={input} aria-label="Title" />
              <input name="email" type="email" placeholder="Email (optional)" className={input} aria-label="Email" />
              <input name="password" type="password" minLength={8} placeholder="Password (8+)" className={input} aria-label="Password" />
              <select name="role" defaultValue="member" className={input} aria-label="Role">
                <option value="member">Member</option>
                <option value="manager">Manager (can approve agent actions)</option>
                <option value="owner">Owner</option>
              </select>
              <select name="managerId" defaultValue={me.id} className={input} aria-label="Reports to">
                {users.filter((u) => u.active).map((u) => (
                  <option key={u.id} value={u.id}>
                    Reports to {u.name}
                  </option>
                ))}
              </select>
              <SubmitButton className={btn}>Add to team</SubmitButton>
            </form>
          </Card>
        )}
      </div>

      {isOwner && (
        <Card title="Edit the team" className="mt-6">
          <div className="space-y-4">
            {users.map((u) => (
              <div key={u.id} className="rounded-lg border border-black/10 p-3">
                <form action={updateTeamMember.bind(null, u.id)} className="grid items-end gap-2 sm:grid-cols-3 lg:grid-cols-7">
                  <div>
                    <span className={label}>Name</span>
                    <input name="name" defaultValue={u.name} className={input} />
                  </div>
                  <div>
                    <span className={label}>Title</span>
                    <input name="title" defaultValue={u.title ?? ""} className={input} />
                  </div>
                  <div>
                    <span className={label}>Email</span>
                    <input name="email" type="email" defaultValue={u.email ?? ""} className={input} />
                  </div>
                  <div>
                    <span className={label}>Role</span>
                    <select name="role" defaultValue={u.role} className={input}>
                      <option value="member">Member</option>
                      <option value="manager">Manager</option>
                      <option value="owner">Owner</option>
                    </select>
                  </div>
                  <div>
                    <span className={label}>Reports to</span>
                    <select name="managerId" defaultValue={u.managerId ?? ""} className={input}>
                      <option value="">Nobody (top)</option>
                      {users
                        .filter((m) => m.id !== u.id)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-1.5 pb-2 text-sm">
                    <input type="checkbox" name="active" defaultChecked={u.active} /> Active
                  </label>
                  <SubmitButton className={btnGhost}>Save</SubmitButton>
                </form>
                {u.id !== me.id && (
                  <form action={setPassword.bind(null, u.id)} className="mt-2 flex flex-wrap items-center gap-2">
                    <input name="password" type="password" minLength={8} required placeholder={u.passwordHash ? "Reset password" : "Set a password so they can sign in"} className={`${input} max-w-xs`} aria-label={`Password for ${u.name}`} />
                    <SubmitButton className={btnGhost}>{u.passwordHash ? "Reset" : "Set password"}</SubmitButton>
                  </form>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}


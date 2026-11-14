import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/roles";
import { integrationStatus } from "@/lib/integrations";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { Badge, Card, Empty, List, Notice, PageHeader, Table, btn, btnGhost, btnSm, field, input, label } from "../_components/ui";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { addUserAction, changeOwnPasswordAction, resetPasswordAction, updateUserAction } from "./actions";

export const dynamic = "force-dynamic";

const when = (d: Date | null) => (d ? d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const manage = can(me.role, "manage_users");
  const [people, log] = await Promise.all([
    manage ? db.select().from(schema.users).orderBy(schema.users.createdAt) : Promise.resolve([]),
    can(me.role, "view_audit")
      ? db
          .select({ a: schema.auditLog, who: schema.users.name })
          .from(schema.auditLog)
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.userId))
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(40)
      : Promise.resolve([]),
  ]);
  const integrations = integrationStatus();

  return (
    <>
      <PageHeader title="Settings" subtitle={`Signed in as ${me.name} (${me.email}) · ${me.role === "owner" ? "Owner" : "Team"}`} />
      {sp.ok && <Notice tone="success">{sp.ok}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}

      {manage && (
        <div className="mb-6">
            <Card flush title="Team" description="Owners see everything. Team can’t see payments or money, or approve finance actions.">
              <Table head={["Person", "Role", { label: "Active", align: "center" }, "Last sign-in", "", "Reset password"]} minWidth={760}>
                {people.map((u) => {
                  const f = `u${u.id}`;
                  return (
                    <tr key={u.id} className="align-top">
                      <td className="px-4 py-3 first:pl-5 last:pr-5">
                        <form id={f} action={updateUserAction.bind(null, u.id)} />
                        <input form={f} name="name" defaultValue={u.name} aria-label="Name" className={`${field} w-full min-w-32 py-1`} />
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {u.email}
                          {u.id === me.id && " · you"}
                        </div>
                      </td>
                      <td className="px-4 py-3 first:pl-5 last:pr-5">
                        <select form={f} name="role" defaultValue={u.role} aria-label="Role" className={`${field} py-1`}>
                          <option value="owner">Owner</option>
                          <option value="team">Team</option>
                        </select>
                      </td>
                      <td className="px-4 py-3 first:pl-5 last:pr-5 text-center">
                        <input form={f} type="checkbox" name="active" defaultChecked={u.active} aria-label="Active" className="mt-2 size-4" />
                      </td>
                      <td className="px-4 py-3 first:pl-5 last:pr-5 text-xs whitespace-nowrap text-muted">
                        <div className="mt-2">{when(u.lastSignInAt)}</div>
                      </td>
                      <td className="px-4 py-3 first:pl-5 last:pr-5">
                        <button form={f} className={`${btnGhost} ${btnSm}`}>
                          Save
                        </button>
                      </td>
                      <td className="px-4 py-3 first:pl-5 last:pr-5">
                        <form action={resetPasswordAction.bind(null, u.id)} className="flex gap-2">
                          <input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} required placeholder="New password" aria-label={`New password for ${u.name}`} className={`${field} w-36 py-1`} autoComplete="new-password" />
                          <SubmitButton className={`${btnGhost} ${btnSm}`}>Set</SubmitButton>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </Table>

              <form action={addUserAction} className="grid gap-3 border-t border-line p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_7rem_1fr_auto] lg:items-end">
                <div>
                  <label className={label} htmlFor="new-name">Name</label>
                  <input id="new-name" name="name" required className={input} placeholder="Jamie" />
                </div>
                <div>
                  <label className={label} htmlFor="new-email">Email</label>
                  <input id="new-email" name="email" type="email" required className={input} placeholder="jamie@1media.ie" />
                </div>
                <div>
                  <label className={label} htmlFor="new-role">Role</label>
                  <select id="new-role" name="role" defaultValue="team" className={input}>
                    <option value="team">Team</option>
                    <option value="owner">Owner</option>
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="new-password">Temporary password</label>
                  <input id="new-password" name="password" type="text" required minLength={MIN_PASSWORD_LENGTH} className={input} autoComplete="off" />
                </div>
                <SubmitButton className={btn}>
                  <Icon name="plus" /> Add person
                </SubmitButton>
              </form>
            </Card>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Your password">
            <form action={changeOwnPasswordAction} className="grid gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
              <div>
                <label className={label} htmlFor="current">Current password</label>
                <input id="current" name="current" type="password" required className={input} autoComplete="current-password" />
              </div>
              <div>
                <label className={label} htmlFor="password">New password</label>
                <input id="password" name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} className={input} autoComplete="new-password" />
              </div>
              <div>
                <label className={label} htmlFor="confirm">New password again</label>
                <input id="confirm" name="confirm" type="password" required minLength={MIN_PASSWORD_LENGTH} className={input} autoComplete="new-password" />
              </div>
              <SubmitButton className={btn}>Change</SubmitButton>
            </form>
            <p className="mt-2 text-xs text-muted">At least {MIN_PASSWORD_LENGTH} characters. Changing it signs you out on other devices.</p>
          </Card>

          {can(me.role, "view_audit") && (
            <Card title="Audit log" description="Sign-ins, approvals, payments and client edits · latest 40">
              {log.length ? (
                <List>
                  {log.map(({ a, who }) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-white">{who ?? (a.action === "payment.record" ? "Stripe" : "–")}</span>{" "}
                        <span className="text-soft">{a.action.replace(".", " · ").replaceAll("_", " ")}</span>{" "}
                        {a.target && <span className="text-muted">{a.target}</span>}
                      </span>
                      <span className="num shrink-0 text-xs text-muted">{when(a.createdAt)}</span>
                    </li>
                  ))}
                </List>
              ) : (
                <Empty icon="history" compact>
                  Nothing recorded yet.
                </Empty>
              )}
            </Card>
          )}
        </div>

        <Card title="Integrations" description={`${integrations.filter((i) => i.configured).length} of ${integrations.length} connected`}>
          <ul className="space-y-2.5 text-sm">
            {integrations.map((i) => (
              <li key={i.name} className="rounded-xl border border-line bg-canvas/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium text-white">
                    <Icon name="plug" className={`size-4 ${i.configured ? "text-emerald-300" : "text-muted"}`} />
                    {i.name}
                  </span>
                  <Badge tone={i.configured ? "green" : "gray"} dot>
                    {i.configured ? "Connected" : "Not set"}
                  </Badge>
                </div>
                <p className="text-xs text-muted">{i.detail}</p>
                {manage && i.needs.length > 0 && <p className="mt-0.5 text-xs text-amber-300">Needs {i.needs.join(", ")}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted">Keys live in Vercel → Settings → Environment Variables. Values are never shown here.</p>
        </Card>
      </div>
    </>
  );
}

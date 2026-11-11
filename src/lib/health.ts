import { and, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "../db";
import { weekStart } from "./dates";
import { RULES, scoreHealth, type HealthInputs, type HealthScore, type WeekHistory } from "./health-score";

/** Previous weeks' leads and CTR from saved health rows, newest first (fallback when the agent has no history). */
export async function storedHistory(clientId: number, beforeWeek: string): Promise<WeekHistory[]> {
  const rows = await db
    .select({ weekOf: schema.healthChecks.weekOf, leads: schema.healthChecks.leads, metrics: schema.healthChecks.metrics })
    .from(schema.healthChecks)
    .where(and(eq(schema.healthChecks.clientId, clientId), lt(schema.healthChecks.weekOf, beforeWeek)))
    .orderBy(desc(schema.healthChecks.weekOf))
    .limit(RULES.historyWeeks);
  return rows.map((r) => {
    const ctr = (r.metrics as { meta?: { ctr?: unknown } } | null)?.meta?.ctr;
    return { weekOf: r.weekOf, leads: r.leads, ctr: typeof ctr === "number" ? ctr : null };
  });
}

/** Scores a client from gathered numbers and saves this week's traffic light. */
export async function scoreAndSaveHealth(
  clientId: number,
  inputs: Omit<HealthInputs, "cplTarget" | "currency">,
  opts: { weekOf?: string; source?: string } = {},
): Promise<HealthScore & { clientId: number; weekOf: string; historySource: "agent" | "stored" }> {
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new Error(`Client ${clientId} not found`);
  const weekOf = opts.weekOf ?? weekStart();
  const historySource = inputs.history?.length ? "agent" : "stored";
  const history = inputs.history?.length ? inputs.history : await storedHistory(clientId, weekOf);
  const full: HealthInputs = { ...inputs, history, cplTarget: client.cplTarget, currency: client.reportCurrency };
  const score = scoreHealth(full);

  const meta = inputs.meta ? { ...inputs.meta, ctr: inputs.meta.ctr ?? (inputs.meta.impressions && inputs.meta.clicks != null ? (inputs.meta.clicks / inputs.meta.impressions) * 100 : null) } : null;
  const values = {
    clientId,
    weekOf,
    status: score.status,
    cpl: score.cpl,
    leads: score.leads,
    spend: score.spend,
    issue: score.issue,
    reason: score.reason,
    actionNeeded: score.action,
    signals: score.signals.map(({ key, label, status, detail }) => ({ key, label, status, detail })),
    metrics: { meta, ghl: inputs.ghl ?? null, history, historySource, cplTarget: client.cplTarget },
    source: opts.source ?? "agent",
    updatedAt: new Date(),
  };
  await db.insert(schema.healthChecks).values(values).onConflictDoUpdate({ target: [schema.healthChecks.clientId, schema.healthChecks.weekOf], set: values });
  return { ...score, clientId, weekOf, historySource };
}

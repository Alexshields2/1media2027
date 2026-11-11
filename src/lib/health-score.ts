// Client health scoring: turns numbers into this week's traffic light.
//
// Pure: no database, no network, no clock. The client-health agent gathers the numbers
// (Meta Ads insights, HighLevel contacts) and the OS_SCORE_HEALTH tool calls scoreHealth(),
// so the status comes from these rules and not from the model's judgement.
//
// Four signals, each green / yellow / red / unknown. The client's status is the worst known
// signal. A signal we couldn't check is shown as "unknown" with the reason, never guessed.

export type Light = "green" | "yellow" | "red";
export type SignalStatus = Light | "unknown";

export type HealthIssue =
  | "Everything Healthy"
  | "Campaign Learning"
  | "Client Concern"
  | "Budget Issue"
  | "Tracking Issue"
  | "Poor Lead Quality"
  | "Creative Fatigue"
  | "Lead Volume Down"
  | "CPL Rising"
  | "Leads Not Worked";

export type SignalKey = "cpl" | "volume" | "fatigue" | "untouched";

export interface HealthSignal {
  key: SignalKey;
  label: string;
  status: SignalStatus;
  /** One sentence with the numbers, e.g. "CPL €18.40 vs €15 target (+23%)." */
  detail: string;
  issue?: HealthIssue;
  action?: string;
}

/** One past week of Meta numbers, newest first or any order. */
export interface WeekHistory {
  weekOf?: string;
  leads: number | null;
  ctr?: number | null;
}

export interface HealthInputs {
  /** The client's CPL target in its report currency. null/undefined = not set. */
  cplTarget?: number | null;
  currency?: string;
  /** Meta Ads, last 7 days. null/undefined = not available (not connected, no account). */
  meta?: {
    spend: number;
    leads: number;
    impressions?: number | null;
    clicks?: number | null;
    /** Average frequency over the 7 days. */
    frequency?: number | null;
    /** Link CTR as a percentage (1.2 = 1.2%). Computed from clicks/impressions if absent. */
    ctr?: number | null;
  } | null;
  /** The previous weeks (up to 4 are used) to compare lead volume and CTR against. */
  history?: WeekHistory[];
  /** HighLevel: leads created in the last 7 days, and those older than 24h with no contact yet. */
  ghl?: {
    newLeads: number;
    untouchedOver24h: number;
    untouchedNames?: string[];
  } | null;
}

export interface HealthScore {
  status: Light;
  issue: HealthIssue;
  /** One-sentence summary built from the worst signals. */
  reason: string;
  action: string;
  cpl: number | null;
  leads: number | null;
  spend: number | null;
  signals: HealthSignal[];
}

/** The thresholds, in one place so they're easy to read and change. */
export const RULES = {
  /** CPL up to this much over target is yellow; above it is red. */
  cplYellowOver: 0.3,
  /** Lead volume vs the previous weeks' average: a drop of this much is yellow / red. */
  volumeYellowDrop: 0.25,
  volumeRedDrop: 0.5,
  /** Need at least this many previous weeks with data to judge the trend. */
  volumeMinWeeks: 2,
  /** Frequency at or above this is fatigue. */
  frequencyYellow: 3,
  frequencyRed: 4.5,
  /** Link CTR down this much vs the previous weeks' average is fatigue. */
  ctrDrop: 0.3,
  /** Untouched leads (> 24h, no contact): any is yellow; this share or more (with at least 3) is red. */
  untouchedRedShare: 0.5,
  untouchedRedMin: 3,
  historyWeeks: 4,
} as const;

const RANK: Record<SignalStatus, number> = { red: 3, yellow: 2, green: 1, unknown: 0 };

/** Which issue wins when two signals have the same colour. Earlier = more important. */
const ISSUE_PRIORITY: HealthIssue[] = ["Budget Issue", "Tracking Issue", "Leads Not Worked", "CPL Rising", "Lead Volume Down", "Creative Fatigue"];

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Ratios are rounded before comparing so 30% over is exactly 0.3, not 0.30000000000000004. */
const ratio = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function money(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

function average(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function ctrOf(meta: NonNullable<HealthInputs["meta"]>): number | null {
  if (typeof meta.ctr === "number") return meta.ctr;
  if (meta.impressions && meta.clicks !== null && meta.clicks !== undefined) return (meta.clicks / meta.impressions) * 100;
  return null;
}

export function scoreCpl(i: HealthInputs): HealthSignal {
  const base = { key: "cpl" as const, label: "CPL vs target" };
  const cur = i.currency ?? "EUR";
  const m = i.meta;
  if (!m) return { ...base, status: "unknown", detail: "Not checked: no Meta Ads data." };
  if (m.spend <= 0) {
    return { ...base, status: "red", detail: "No ad spend in the last 7 days.", issue: "Budget Issue", action: "Check the ad account for a payment failure, restriction or paused campaigns." };
  }
  if (m.leads <= 0) {
    return { ...base, status: "red", detail: `Spent ${money(m.spend, cur)} in 7 days with no leads.`, issue: "Tracking Issue", action: "Check the lead form and pixel are firing, then the GHL integration." };
  }
  const cpl = m.spend / m.leads;
  if (!i.cplTarget || i.cplTarget <= 0) {
    return { ...base, status: "unknown", detail: `CPL ${money(round2(cpl), cur)}; no CPL target set for this client.` };
  }
  const over = ratio(cpl / i.cplTarget - 1);
  const text = `CPL ${money(round2(cpl), cur)} vs ${money(i.cplTarget, cur)} target`;
  if (over <= 0) return { ...base, status: "green", detail: `${text}.` };
  if (over <= RULES.cplYellowOver) {
    return { ...base, status: "yellow", detail: `${text} (+${pct(over)}).`, issue: "CPL Rising", action: "Shift budget to the best ad sets and test new angles." };
  }
  return { ...base, status: "red", detail: `${text} (+${pct(over)}).`, issue: "CPL Rising", action: "Review targeting and creative today; pause nothing without checking with Alex." };
}

export function scoreVolume(i: HealthInputs): HealthSignal {
  const base = { key: "volume" as const, label: "Lead volume" };
  if (!i.meta) return { ...base, status: "unknown", detail: "Not checked: no Meta Ads data." };
  const prev = (i.history ?? [])
    .slice(0, RULES.historyWeeks)
    .map((w) => w.leads)
    .filter((n): n is number => typeof n === "number");
  if (prev.length < RULES.volumeMinWeeks) {
    return { ...base, status: "unknown", detail: `${i.meta.leads} leads this week; not enough history to compare (${prev.length} week${prev.length === 1 ? "" : "s"}).` };
  }
  const avg = average(prev)!;
  const text = `${i.meta.leads} leads vs ${round2(avg)} a week over the previous ${prev.length} weeks`;
  if (avg <= 0) return { ...base, status: "green", detail: `${text}.` };
  const drop = ratio(1 - i.meta.leads / avg);
  if (drop >= RULES.volumeRedDrop) {
    return { ...base, status: "red", detail: `${text} (down ${pct(drop)}).`, issue: "Lead Volume Down", action: "Find which campaigns dropped and fix delivery or budget." };
  }
  if (drop >= RULES.volumeYellowDrop) {
    return { ...base, status: "yellow", detail: `${text} (down ${pct(drop)}).`, issue: "Lead Volume Down", action: "Check delivery and budget on the main campaigns." };
  }
  return { ...base, status: "green", detail: drop > 0 ? `${text} (down ${pct(drop)}).` : `${text}.` };
}

export function scoreFatigue(i: HealthInputs): HealthSignal {
  const base = { key: "fatigue" as const, label: "Creative fatigue" };
  if (!i.meta) return { ...base, status: "unknown", detail: "Not checked: no Meta Ads data." };
  const freq = i.meta.frequency ?? null;
  const ctr = ctrOf(i.meta);
  const prevCtr = average(
    (i.history ?? [])
      .slice(0, RULES.historyWeeks)
      .map((w) => w.ctr)
      .filter((n): n is number => typeof n === "number" && n > 0),
  );
  if (freq === null && (ctr === null || prevCtr === null)) {
    return { ...base, status: "unknown", detail: "Not checked: no frequency or CTR history." };
  }
  const highFreq = freq !== null && freq >= RULES.frequencyYellow;
  const veryHighFreq = freq !== null && freq >= RULES.frequencyRed;
  const ctrDrop = ctr !== null && prevCtr !== null ? ratio(1 - ctr / prevCtr) : null;
  const ctrFalling = ctrDrop !== null && ctrDrop >= RULES.ctrDrop;

  const parts: string[] = [];
  if (freq !== null) parts.push(`frequency ${round2(freq)}`);
  if (ctr !== null && prevCtr !== null) parts.push(`CTR ${round2(ctr)}% vs ${round2(prevCtr)}%${ctrDrop! > 0 ? ` (down ${pct(ctrDrop!)})` : ""}`);
  else if (ctr !== null) parts.push(`CTR ${round2(ctr)}%`);
  const detail = parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".";

  const action = "Launch fresh creative this week.";
  if ((highFreq && ctrFalling) || veryHighFreq) return { ...base, status: "red", detail, issue: "Creative Fatigue", action };
  if (highFreq || ctrFalling) return { ...base, status: "yellow", detail, issue: "Creative Fatigue", action };
  return { ...base, status: "green", detail };
}

export function scoreUntouched(i: HealthInputs): HealthSignal {
  const base = { key: "untouched" as const, label: "Leads worked in GHL" };
  const g = i.ghl;
  if (!g) return { ...base, status: "unknown", detail: "Not checked: no HighLevel data." };
  if (g.newLeads <= 0) return { ...base, status: "green", detail: "No new leads in GHL this week to work." };
  const n = Math.min(g.untouchedOver24h, g.newLeads);
  const names = g.untouchedNames?.length ? `: ${g.untouchedNames.slice(0, 5).join(", ")}${g.untouchedNames.length > 5 ? "…" : ""}` : "";
  if (n === 0) return { ...base, status: "green", detail: `All ${g.newLeads} new leads contacted within 24h.` };
  const detail = `${n} of ${g.newLeads} new leads untouched for over 24h${names}.`;
  const action = "Call the client today and go through each untouched lead by name.";
  if (n / g.newLeads >= RULES.untouchedRedShare && n >= RULES.untouchedRedMin) {
    return { ...base, status: "red", detail, issue: "Leads Not Worked", action };
  }
  return { ...base, status: "yellow", detail, issue: "Leads Not Worked", action };
}

export function scoreHealth(i: HealthInputs): HealthScore {
  const signals = [scoreCpl(i), scoreVolume(i), scoreFatigue(i), scoreUntouched(i)];
  const known = signals.filter((s) => s.status !== "unknown");
  const m = i.meta;
  const numbers = {
    cpl: m && m.leads > 0 ? round2(m.spend / m.leads) : null,
    leads: m ? m.leads : null,
    spend: m ? round2(m.spend) : null,
  };

  if (!known.length) {
    return {
      ...numbers,
      status: "yellow",
      issue: "Tracking Issue",
      reason: "No signal could be checked: connect Meta Ads and HighLevel, and set the client's ad account, GHL location and CPL target.",
      action: "Fill in the client's set-up so the health check can run.",
      signals,
    };
  }

  const worst = Math.max(...known.map((s) => RANK[s.status]));
  const status: Light = worst === 3 ? "red" : worst === 2 ? "yellow" : "green";

  if (status === "green") {
    return { ...numbers, status, issue: "Everything Healthy", reason: known.map((s) => s.detail).join(" "), action: "Keep going.", signals };
  }

  const bad = known
    .filter((s) => RANK[s.status] === worst)
    .sort((a, b) => ISSUE_PRIORITY.indexOf(a.issue!) - ISSUE_PRIORITY.indexOf(b.issue!));
  const others = known.filter((s) => s.status !== "green" && RANK[s.status] < worst);
  return {
    ...numbers,
    status,
    issue: bad[0].issue!,
    reason: [...bad, ...others].map((s) => s.detail).join(" "),
    action: bad[0].action!,
    signals,
  };
}

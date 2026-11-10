// Decides whether an agent may run a tool call, based on the agent's autonomy level.
//
// Autonomy ladder (from BLUEPRINT.md):
//   L0  read-only: any write is blocked
//   L1  drafts: writes are proposed for human approval, not executed
//   L2  internal: writes to our own systems (1Media OS database, GHL, Drive) run; anything that
//       reaches a client or moves money is proposed
//   L3  external: everything runs, except the hard blocks below

export type Autonomy = "L0" | "L1" | "L2" | "L3";

export type Decision =
  | { action: "run" }
  | { action: "propose"; reason: string }
  | { action: "block"; reason: string };

const READ_VERBS = [
  "GET", "LIST", "FETCH", "SEARCH", "QUERY", "RETRIEVE", "FIND", "READ", "DOWNLOAD", "COUNT", "CHECK",
];

/** Never allowed, whatever the autonomy level. */
const HARD_BLOCKS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|_)(DELETE|TRASH|ARCHIVE|REMOVE)(_|$)/, reason: "Deleting data is never automatic." },
  {
    pattern: /^(METAADS|FACEBOOK)_(.*_)?(CREATE|UPDATE|PAUSE|PUBLISH|EDIT|SET|DUPLICATE|COPY)(_|$)/,
    reason: "Ads Manager is read-only for agents (weekly report SOP).",
  },
  { pattern: /^STRIPE_(.*_)?(REFUND|REFUNDS|PAYOUT|PAYOUTS|TRANSFER|TRANSFERS)(_|$)/, reason: "Refunds and payouts are human-only." },
];

/** Toolkits that are our own back office. Writes here are "internal". */
const INTERNAL_TOOLKITS = ["OS", "GOOGLEDRIVE", "GOOGLESHEETS", "GOOGLEDOCS", "HIGHLEVEL"];

/** Write actions that only prepare something, never send it. Safe at L1. */
const DRAFT_ONLY = [/^GMAIL_CREATE_EMAIL_DRAFT/, /^GMAIL_.*DRAFT/, /^GMAIL_ADD_LABEL/, /^GMAIL_.*LABEL/];

export function isRead(slug: string): boolean {
  const parts = slug.toUpperCase().split("_").slice(1); // drop toolkit prefix
  return parts.some((p) => READ_VERBS.includes(p));
}

export function decide(slug: string, autonomy: Autonomy, extraAllow: string[] = []): Decision {
  const s = slug.toUpperCase();

  for (const b of HARD_BLOCKS) {
    if (b.pattern.test(s)) return { action: "block", reason: b.reason };
  }
  if (isRead(s) || extraAllow.includes(s)) return { action: "run" };
  if (autonomy === "L0") return { action: "block", reason: "Agent is read-only (L0)." };
  if (DRAFT_ONLY.some((p) => p.test(s))) return { action: "run" };
  if (autonomy === "L1") return { action: "propose", reason: "L1 agent: all writes need approval." };

  const toolkit = s.split("_")[0];
  const internal = INTERNAL_TOOLKITS.includes(toolkit);
  if (autonomy === "L2" && !internal) {
    return { action: "propose", reason: "L2 agent: external action (client-facing or money) needs approval." };
  }
  return { action: "run" };
}

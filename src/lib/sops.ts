import type { Sop } from "../db/schema";

// Pure SOP helpers: schedules, video embeds and templates. No database access.

export type Schedule = Sop["schedule"];

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** ISO weekday, 1 = Monday ... 7 = Sunday, for a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type ScheduleFields = Pick<Sop, "agentEnabled" | "archived" | "schedule" | "weekday" | "monthDay" | "lastRunDate">;

/** Should the agent run this SOP on `date` (Dublin, YYYY-MM-DD)? */
export function isDue(sop: ScheduleFields, date: string): boolean {
  if (!sop.agentEnabled || sop.archived || sop.schedule === "manual") return false;
  if (sop.lastRunDate === date) return false;
  const wd = isoWeekday(date);
  switch (sop.schedule) {
    case "daily":
      return true;
    case "weekdays":
      return wd <= 5;
    case "weekly":
      return wd === (sop.weekday ?? 1);
    case "monthly": {
      const day = Number(date.slice(8, 10));
      const target = Math.min(sop.monthDay ?? 1, daysInMonth(date));
      return day === target;
    }
    default:
      return false;
  }
}

export function describeSchedule(sop: Pick<Sop, "agentEnabled" | "schedule" | "weekday" | "monthDay" | "perClient">): string {
  if (!sop.agentEnabled || sop.schedule === "manual") return sop.agentEnabled ? "Agent: on demand" : "Manual (people only)";
  const each = sop.perClient ? ", for each active client" : "";
  switch (sop.schedule) {
    case "daily":
      return `Agent: every day${each}`;
    case "weekdays":
      return `Agent: weekdays${each}`;
    case "weekly":
      return `Agent: every ${WEEKDAYS[(sop.weekday ?? 1) - 1]}${each}`;
    case "monthly":
      return `Agent: monthly on the ${ordinal(sop.monthDay ?? 1)}${each}`;
  }
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Turns a Loom, YouTube or Vimeo share link into an embeddable URL. Null for anything else. */
export function videoEmbedUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host.endsWith("loom.com")) {
    const m = u.pathname.match(/\/(?:share|embed)\/([a-zA-Z0-9]+)/);
    return m ? `https://www.loom.com/embed/${m[1]}` : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = u.searchParams.get("v") ?? u.pathname.match(/\/(?:embed|shorts)\/([\w-]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === "vimeo.com") {
    const id = u.pathname.match(/^\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}

/** Splits a checklist textarea (one step per line, bullets or numbers allowed) into steps. */
export function parseSteps(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s*)?(?:\[[ x]\]\s*)?/i, "").trim())
    .filter(Boolean);
}

export interface SopTemplate {
  key: string;
  title: string;
  category: string;
  summary: string;
  body: string;
  steps: string[];
  schedule: Schedule;
  weekday?: number;
  monthDay?: number;
  perClient: boolean;
  autonomy: Sop["autonomy"];
  toolkits: string[];
}

/** Starting points on the "New SOP" page. Edit freely after picking one. */
export const SOP_TEMPLATES: SopTemplate[] = [
  {
    key: "monday-touchpoint",
    title: "Monday client touchpoint",
    category: "Client success",
    summary: "A short Monday check-in to every active client: last week's numbers, this week's plan, one question.",
    body: [
      "Every Monday morning, each active client gets a short touchpoint message from us.",
      "1. Read the client record (greeting, report rules, CPL target).",
      "2. Pull last week's leads, spend and CPL from Meta Ads, and lead stages from HighLevel.",
      "3. Check open and completed tasks for the client in 1Media OS.",
      "4. Draft a 4-6 line message: greeting, last week in one line with numbers, what we are doing this week, one question for them.",
      "5. Save it as a draft for the account manager. Never send it to the client directly.",
      "6. If CPL is more than 30% over target, or there were zero leads, also create a high-priority task for the account manager.",
    ].join("\n"),
    steps: ["Read client record", "Pull last week's numbers", "Check open tasks", "Draft the message", "Flag problems as tasks"],
    schedule: "weekly",
    weekday: 1,
    perClient: true,
    autonomy: "L1",
    toolkits: ["metaads", "highlevel"],
  },
  {
    key: "monthly-report",
    title: "Monthly client report",
    category: "Reporting",
    summary: "On the 1st, a month-end report for each client from the month's weekly reports and ad data.",
    body: [
      "On the 1st of each month, write each active client's month-end report.",
      "1. Read the client record and the month's weekly reports in 1Media OS.",
      "2. Pull the full month's spend, leads and CPL from Meta Ads.",
      "3. Compare against the CPL target and the previous month.",
      "4. Write the report: headline result, numbers table, what worked, what we change next month, next steps.",
      "5. Save it as a monthly report draft for review.",
    ].join("\n"),
    steps: ["Read weekly reports", "Pull month's ad data", "Compare to target and last month", "Write the report", "Save draft for review"],
    schedule: "monthly",
    monthDay: 1,
    perClient: true,
    autonomy: "L1",
    toolkits: ["metaads"],
  },
  {
    key: "lead-follow-up-audit",
    title: "Lead follow-up audit",
    category: "Client success",
    summary: "Checks every client's HighLevel pipeline for leads that haven't been contacted in 48 hours.",
    body: [
      "Every weekday, check that clients are working their leads.",
      "1. For each active client with a GHL location, list leads from the last 7 days and their stage.",
      "2. Any lead still in the first stage after 48 hours is 'not worked'.",
      "3. If a client has 3 or more unworked leads, create a high-priority task for the account manager with the lead names.",
      "4. Summarise the totals per client.",
    ].join("\n"),
    steps: ["List last 7 days' leads", "Find leads untouched for 48h", "Create tasks where 3+ are untouched", "Summarise per client"],
    schedule: "weekdays",
    perClient: false,
    autonomy: "L2",
    toolkits: ["highlevel"],
  },
];

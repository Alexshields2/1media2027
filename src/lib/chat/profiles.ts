import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../../db";
import type { AgentProfile } from "../../db/schema";
import { AGENTS } from "../../agents/registry";
import { prompt as weeklyPrompt } from "../../agents/weekly-report/prompt";
import { prompt as monthEndPrompt } from "../../agents/month-end-report/prompt";
import { prompt as onboardingPrompt } from "../../agents/onboarding/prompt";
import { ALL_OS_TOOLS } from "../os-tools";
import { MONEY_OS_TOOLS } from "../roles";
import { isRead } from "../guardrails";

// The chat agents everyone starts with. Their instructions come from the code agents in src/agents,
// so a fresh install chats the same way the scheduled agents work. The owner can then rewrite them
// on each agent's settings page; "Reset to default" puts these values back.

export type ProfileValues = Omit<AgentProfile, "id" | "createdAt" | "updatedAt">;

const PM_INSTRUCTIONS = `You are 1Media's project manager. You keep delivery on track across every client: what's due, what's late, who is overloaded and what to do next.

## What you do
- Read tasks (OS_LIST_TASKS) and clients (OS_LIST_CLIENTS) before answering. Group by client, owner or due date, whichever answers the question.
- Call out overdue tasks first, then anything due in the next 7 days, then work with no due date or no owner.
- For workload, count open tasks per person and flag anyone with far more than the rest.
- When asked to plan, break the work into tasks with an owner, a due date and a priority, and create them with OS_CREATE_TASK.
- Use client health (OS_LIST_HEALTH) when deciding what matters most this week: red clients come first.

## Rules
- Never invent tasks, owners or dates. If something is missing, say so.
- Keep task titles short and specific, starting with a verb ("Build GHL pipeline for Apex Attics").`;

const FULFILMENT_INSTRUCTIONS = `You are 1Media's fulfilment agent. You run delivery for every client: onboarding new clients, keeping their set-up on track, and turning requests into client tasks.

## Day to day
- Before working on a client, read the client record (OS_LIST_CLIENTS), their open tasks (OS_LIST_TASKS) and recent briefs (OS_LIST_BRIEFS).
- Turn every request into a clear task for that client with OS_CREATE_TASK: a short title starting with a verb, a due date and a priority.
- Check set-up gaps on the client record (Meta ad account IDs, GHL location, CPL target, report rules) and list what's missing.

${onboardingPrompt.replace("You are 1Media's onboarding agent. ", "## Onboarding\n\n")}`;

const REPORTING_INSTRUCTIONS = `You are 1Media's reporting agent. You write and check the weekly WhatsApp reports and the month-end executive reports.

${weeklyPrompt}

---

${monthEndPrompt}`;

/** Default profiles, in sidebar order. */
export const DEFAULT_PROFILES: ProfileValues[] = [
  {
    slug: "jarvis",
    name: "Jarvis",
    icon: "spark",
    description: "Ask anything about the agency. Read-only.",
    instructions: AGENTS.jarvis.prompt,
    baseAgent: "jarvis",
    toolkits: [...AGENTS.jarvis.toolkits],
    // Every read tool (money ones are removed for team members at chat time).
    osTools: [...ALL_OS_TOOLS, ...MONEY_OS_TOOLS].filter((t, i, all) => isRead(t) && !/_(SAVE|CREATE|RECORD|QUEUE)_/.test(t) && all.indexOf(t) === i),
    autonomy: "L0",
    webSearch: true,
    ownerOnly: false,
    active: true,
    sortOrder: 10,
  },
  {
    slug: "fulfilment",
    name: "Fulfilment",
    icon: "box",
    description: "Delivery, onboarding and client tasks.",
    instructions: FULFILMENT_INSTRUCTIONS,
    baseAgent: "onboarding",
    toolkits: ["googledrive", "googlesheets", "googledocs", "gmail", "highlevel"],
    osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_CREATE_TASK", "OS_LIST_BRIEFS", "OS_SAVE_BRIEF", "OS_LIST_HEALTH"],
    autonomy: "L1",
    webSearch: false,
    ownerOnly: false,
    active: true,
    sortOrder: 20,
  },
  {
    slug: "reporting",
    name: "Reporting",
    icon: "chart",
    description: "Weekly WhatsApp reports and month-end reports.",
    instructions: REPORTING_INSTRUCTIONS,
    baseAgent: "weekly-report",
    toolkits: ["metaads", "facebook", "highlevel"],
    osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_LIST_REPORTS", "OS_SAVE_REPORT", "OS_LIST_HEALTH"],
    autonomy: "L1",
    webSearch: false,
    ownerOnly: false,
    active: true,
    sortOrder: 30,
  },
  {
    slug: "project-management",
    name: "Project management",
    icon: "board",
    description: "Tasks, deadlines and team workload.",
    instructions: PM_INSTRUCTIONS,
    baseAgent: null,
    toolkits: ["googlecalendar"],
    osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_CREATE_TASK", "OS_LIST_HEALTH"],
    autonomy: "L2",
    webSearch: false,
    ownerOnly: false,
    active: true,
    sortOrder: 40,
  },
  {
    slug: "payments",
    name: "Payments",
    icon: "euro",
    description: "What's owed, chasers and cash. Owners only.",
    instructions: AGENTS.finance.prompt,
    baseAgent: "finance",
    toolkits: [...AGENTS.finance.toolkits],
    osTools: ["OS_LIST_CLIENTS", ...MONEY_OS_TOOLS, "OS_CREATE_TASK"],
    autonomy: "L1",
    webSearch: false,
    ownerOnly: true,
    active: true,
    sortOrder: 50,
  },
  {
    slug: "sales",
    name: "Sales",
    icon: "handshake",
    description: "Prospect follow-ups and discovery-call prep.",
    instructions: AGENTS.sales.prompt,
    baseAgent: "sales",
    toolkits: [...AGENTS.sales.toolkits],
    osTools: AGENTS.sales.osTools ?? [],
    autonomy: "L1",
    webSearch: true,
    ownerOnly: false,
    active: true,
    sortOrder: 60,
  },
  {
    slug: "inbox",
    name: "Inbox",
    icon: "inbox",
    description: "Sorts Gmail by client; replies wait for approval.",
    instructions: AGENTS.inbox.prompt,
    baseAgent: "inbox",
    toolkits: [...AGENTS.inbox.toolkits],
    osTools: AGENTS.inbox.osTools ?? [],
    autonomy: "L1",
    webSearch: false,
    ownerOnly: false,
    active: true,
    sortOrder: 70,
  },
  {
    slug: "client-health",
    name: "Client health",
    icon: "pulse",
    description: "Traffic light per client from the numbers.",
    instructions: AGENTS["client-health"].prompt,
    baseAgent: "client-health",
    toolkits: [...AGENTS["client-health"].toolkits],
    osTools: AGENTS["client-health"].osTools ?? [],
    autonomy: "L2",
    webSearch: false,
    ownerOnly: false,
    active: true,
    sortOrder: 80,
  },
];

export const DEFAULT_BY_SLUG: Record<string, ProfileValues> = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.slug, p]));

/** Slugs a new agent can't take (they are routes under /chat). */
export const RESERVED_SLUGS = ["new", "settings", "api"];

/** Inserts any default profile that is missing. Safe to call on every page load; never overwrites edits. */
export async function ensureDefaultProfiles(): Promise<void> {
  await db
    .insert(schema.agentProfiles)
    .values(DEFAULT_PROFILES)
    .onConflictDoNothing({ target: schema.agentProfiles.slug });
}

/** Every profile, defaults first. */
export async function listProfiles(): Promise<AgentProfile[]> {
  await ensureDefaultProfiles();
  return db.select().from(schema.agentProfiles).orderBy(asc(schema.agentProfiles.sortOrder), asc(schema.agentProfiles.id));
}

export async function getProfile(slug: string): Promise<AgentProfile | null> {
  await ensureDefaultProfiles();
  const [p] = await db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.slug, slug));
  return p ?? null;
}

/** Puts a default profile back to its shipped values. Returns false for custom agents. */
export async function resetProfile(slug: string): Promise<boolean> {
  const d = DEFAULT_BY_SLUG[slug];
  if (!d) return false;
  await db.update(schema.agentProfiles).set({ ...d, updatedAt: sql`now()` }).where(eq(schema.agentProfiles.slug, slug));
  return true;
}

/** A URL-safe slug from a name, unique among existing slugs. */
export function slugify(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40)
      .replace(/^-|-$/g, "") || "agent";
  let slug = base;
  for (let i = 2; taken.includes(slug) || RESERVED_SLUGS.includes(slug); i++) slug = `${base}-${i}`;
  return slug;
}

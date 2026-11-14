"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requirePermission, requireSignedIn } from "@/lib/session";
import { audit } from "@/lib/audit";
import { canDecide, ForbiddenError } from "@/lib/roles";
import { executeApproval, rejectApproval } from "@/lib/approvals";
import { getProfile, resetProfile, slugify, listProfiles } from "@/lib/chat/profiles";
import { AGENTS } from "@/agents/registry";
import { TOOLKITS } from "@/lib/composio";
import { osToolDefs } from "@/lib/os-tools";

// ---------- conversations ----------

async function ownConversation(id: number) {
  const user = await requireSignedIn();
  const [c] = await db.select().from(schema.conversations).where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, user.id)));
  if (!c) throw new ForbiddenError("open that conversation");
  return { user, c };
}

export async function renameConversation(id: number, title: string) {
  await ownConversation(id);
  const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!t) return;
  await db.update(schema.conversations).set({ title: t }).where(eq(schema.conversations.id, id));
  revalidatePath("/chat", "layout");
}

export async function deleteConversation(id: number) {
  const { user, c } = await ownConversation(id);
  await db.delete(schema.conversations).where(eq(schema.conversations.id, id));
  await audit("chat.delete", { userId: user.id, target: `conversation:${id}`, detail: { title: c.title } });
  revalidatePath("/chat", "layout");
}

// ---------- approvals from a chat ----------

/** Approve or reject a proposed action from its card in a chat. Same checks and audit trail as the Approvals page. */
export async function decideChatApproval(id: number, decision: "approve" | "reject"): Promise<{ status: string; result: string | null; error?: string }> {
  const user = await requireSignedIn();
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id));
  if (!a) return { status: "missing", result: null, error: "That approval no longer exists." };
  if (!canDecide(user.role, a.agent, a.tool)) return { status: a.status, result: a.result, error: "Only an owner can decide finance or Stripe actions." };
  if (a.status !== "pending") return { status: a.status, result: a.result, error: `Already ${a.status}.` };
  if (decision === "approve") {
    const r = await executeApproval(id, user.id);
    await audit("approval.approve", { userId: user.id, target: `approval:${id}`, detail: { agent: a.agent, tool: a.tool, ok: r.ok, via: "chat" } });
  } else {
    await rejectApproval(id, user.id);
    await audit("approval.reject", { userId: user.id, target: `approval:${id}`, detail: { agent: a.agent, tool: a.tool, via: "chat" } });
  }
  const [after] = await db.select({ status: schema.approvals.status, result: schema.approvals.result }).from(schema.approvals).where(eq(schema.approvals.id, id));
  revalidatePath("/approvals");
  return { status: after.status, result: after.result };
}

// ---------- agent profiles (owners) ----------

const ALL_TOOLKITS = Object.values(TOOLKITS) as string[];
const ALL_OS = osToolDefs().map((t) => t.name);

const profileInput = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(60),
  icon: z.string().trim().min(1).max(30),
  description: z.string().trim().max(200),
  instructions: z.string().max(60_000),
  baseAgent: z.string().refine((v) => v === "" || v in AGENTS, "Unknown base agent."),
  toolkits: z.array(z.string()).transform((xs) => xs.filter((x) => ALL_TOOLKITS.includes(x))),
  osTools: z.array(z.string()).transform((xs) => xs.filter((x) => ALL_OS.includes(x))),
  autonomy: z.enum(["L0", "L1", "L2"]),
  webSearch: z.boolean(),
  ownerOnly: z.boolean(),
  active: z.boolean(),
});

function readProfileForm(form: FormData) {
  const s = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  return profileInput.safeParse({
    name: s("name"),
    icon: s("icon") || "spark",
    description: s("description"),
    instructions: s("instructions").replace(/\r\n/g, "\n"),
    baseAgent: s("baseAgent"),
    toolkits: form.getAll("toolkits").map(String),
    osTools: form.getAll("osTools").map(String),
    autonomy: s("autonomy") || "L0",
    webSearch: form.get("webSearch") === "on",
    ownerOnly: form.get("ownerOnly") === "on",
    active: form.get("active") === "on",
  });
}

export type ProfileFormState = { error?: string; saved?: boolean };

export async function saveProfile(slug: string, _: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await requirePermission("manage_agents", "edit agents");
  const profile = await getProfile(slug);
  if (!profile) return { error: "That agent doesn't exist." };
  const parsed = readProfileForm(form);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const v = parsed.data;
  // Payments always stays owners-only.
  const ownerOnly = slug === "payments" ? true : v.ownerOnly;
  await db
    .update(schema.agentProfiles)
    .set({ ...v, ownerOnly, baseAgent: v.baseAgent || null, updatedAt: sql`now()` })
    .where(eq(schema.agentProfiles.id, profile.id));
  const changed = Object.keys(v).filter((k) => JSON.stringify((v as Record<string, unknown>)[k]) !== JSON.stringify((profile as Record<string, unknown>)[k]));
  await audit("agent.update", { userId: user.id, target: `agent:${slug}`, detail: { changed } });
  revalidatePath("/chat", "layout");
  return { saved: true };
}

export async function createProfile(_: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await requirePermission("manage_agents", "create agents");
  const parsed = readProfileForm(form);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const v = parsed.data;
  const taken = (await listProfiles()).map((p) => p.slug);
  const slug = slugify(v.name, taken);
  await db.insert(schema.agentProfiles).values({ ...v, slug, baseAgent: v.baseAgent || null, sortOrder: 1000 });
  await audit("agent.create", { userId: user.id, target: `agent:${slug}`, detail: { name: v.name } });
  revalidatePath("/chat", "layout");
  redirect(`/chat/${slug}`);
}

export async function resetProfileAction(slug: string) {
  const user = await requirePermission("manage_agents", "edit agents");
  if (await resetProfile(slug)) await audit("agent.reset", { userId: user.id, target: `agent:${slug}` });
  revalidatePath("/chat", "layout");
  redirect(`/chat/${slug}/settings?reset=1`);
}

"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AGENTS } from "@/agents/registry";
import { runAgent } from "@/lib/runner";
import { requireSignedIn } from "@/lib/session";

/** "Prep for call" on the client page: runs the call-prep agent for this client in the background. */
export async function prepForCall(clientId: number) {
  await requireSignedIn();
  const [client] = await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) throw new Error("Client not found");
  // The client page finds this client's runs by the "(client_id N)" in the instruction.
  const instruction = `Prep for the next call with ${client.name} (client_id ${client.id}) only.`;
  after(() => runAgent(AGENTS.meetings, { instruction, trigger: "manual" }).catch((e) => console.error(e)));
  redirect(`/clients/${clientId}?prep=started`);
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { audit } from "@/lib/audit";
import { APPS, ComposioError, disconnect, loginLink } from "@/lib/composio-connect";

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "1media2027.vercel.app";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

/** Sends the owner to the app's login page; Composio brings them back to /integrations. */
export async function connectApp(slug: string) {
  const user = await requirePermission("manage_integrations", "connect apps");
  if (!APPS.some((a) => a.slug === slug)) throw new Error("Unknown app.");
  let url: string;
  try {
    url = await loginLink(slug, `${await origin()}/integrations?connected=${encodeURIComponent(slug)}`);
  } catch (e) {
    const msg = e instanceof ComposioError ? e.message : "Couldn't reach Composio. Try again in a minute.";
    redirect(`/integrations?error=${encodeURIComponent(msg)}`);
  }
  await audit("integration.connect", { userId: user.id, target: `app:${slug}` });
  redirect(url);
}

export async function disconnectApp(slug: string, accountId: string) {
  const user = await requirePermission("manage_integrations", "disconnect apps");
  try {
    await disconnect(accountId);
  } catch (e) {
    const msg = e instanceof ComposioError ? e.message : "Couldn't reach Composio. Try again in a minute.";
    redirect(`/integrations?error=${encodeURIComponent(msg)}`);
  }
  await audit("integration.disconnect", { userId: user.id, target: `app:${slug}` });
  revalidatePath("/integrations");
}

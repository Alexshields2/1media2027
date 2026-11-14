import { after, NextResponse, type NextRequest } from "next/server";
import { runRevolutSync } from "@/lib/revolut/run";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { completeAuthorisation } from "@/lib/revolut/connection";

// Revolut sends the owner back here after the consent page: ?code=…&state=…
// Owner session required (the login gate sends anyone else to /login). The code is swapped for
// tokens server-side and stored encrypted; nothing secret is put in the redirect or the logs.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const back = (q: Record<string, string>) => NextResponse.redirect(new URL(`/integrations?${new URLSearchParams(q)}#revolut`, req.nextUrl.origin));
  const user = await getCurrentUser();
  if (!user || !can(user.role, "manage_integrations")) return back({ error: "Only an owner can connect Revolut." });
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code");
  if (!code) return back({ error: sp.get("error_description") || sp.get("error") ? `Revolut said: ${(sp.get("error_description") || sp.get("error"))!.slice(0, 120)}` : "Revolut didn't send an authorisation code. Try Authorise again." });
  try {
    await completeAuthorisation(code, sp.get("state"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't finish connecting Revolut.";
    console.error("revolut callback failed:", msg);
    return back({ error: msg.slice(0, 200) });
  }
  await audit("revolut.connect", { userId: user.id, target: "integration:revolut" });
  // First sync in the background, so the owner lands back on Integrations straight away.
  after(() => runRevolutSync("manual").then(() => undefined));
  return back({ revolut: "connected" });
}

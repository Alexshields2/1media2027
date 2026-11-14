import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { authorized, runSopTarget } from "../../shared";

// Started by the daily "sops" cron: one call per SOP (per client). Answers at once and
// runs the agent in the background, so each run has its own time budget.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const sopId = Number(id);
  const client = req.nextUrl.searchParams.get("client");
  const clientId = client && /^\d+$/.test(client) ? Number(client) : null;
  if (!Number.isInteger(sopId) || sopId <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  after(() => runSopTarget(sopId, clientId).catch((e) => console.error(e)));
  return NextResponse.json({ started: sopId, client: clientId });
}

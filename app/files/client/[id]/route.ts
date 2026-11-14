import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { ensureClientFolder } from "@/lib/files";

// "Open client folder": finds (or makes) Files / Clients / <client name>, then opens it.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const folderId = await ensureClientFolder(id, user.id);
    return NextResponse.redirect(new URL(`/files?folder=${folderId}`, req.url));
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : "Couldn't open the client folder.", { status: 404 });
  }
}

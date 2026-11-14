import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/session";
import { previewable } from "@/lib/files";
import { createDownloadUrl } from "@/lib/storage";

// Opens or downloads a stored file: checks the session, then redirects to a 5-minute signed
// Supabase link. ?inline=1 shows it in the browser (images, PDFs, video, audio only).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getCurrentUser())) return NextResponse.redirect(new URL("/login", req.url));
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new NextResponse("Not found", { status: 404 });
  const [f] = await db.select().from(schema.files).where(eq(schema.files.id, id));
  if (!f) return new NextResponse("That file no longer exists.", { status: 404 });
  const inline = req.nextUrl.searchParams.get("inline") === "1" && previewable(f.name, f.mimeType);
  try {
    const url = await createDownloadUrl(f.storagePath, inline ? {} : { downloadAs: f.name });
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(e);
    return new NextResponse(e instanceof Error ? e.message : "Couldn't open the file.", { status: 502 });
  }
}

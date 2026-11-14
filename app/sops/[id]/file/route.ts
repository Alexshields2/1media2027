import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentUser } from "@/lib/session";

// Download the file attached to an SOP. Login is enforced by proxy.ts and checked again here.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Sign in first", { status: 401 });
  const { id } = await params;
  const [s] = await db
    .select({ name: schema.sops.fileName, type: schema.sops.fileType, data: schema.sops.fileData })
    .from(schema.sops)
    .where(eq(schema.sops.id, Number(id)));
  if (!s?.data) return new NextResponse("No file", { status: 404 });
  const safeName = (s.name ?? "sop").replace(/[^\w.\- ]/g, "_");
  return new NextResponse(Buffer.from(s.data, "base64"), {
    headers: {
      "content-type": s.type === "application/pdf" ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${safeName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

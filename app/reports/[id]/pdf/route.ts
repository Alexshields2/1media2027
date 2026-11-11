import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { monthlyReportPdf, pdfFileName } from "@/lib/report-pdf";
import { weeklyReportsForMonth } from "@/lib/report-jobs";
import { getCurrentUser } from "@/lib/session";

// Download a report as PDF (behind the dashboard login; see proxy.ts). Built on request, so
// it always reflects the latest edits.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getCurrentUser())) return new Response("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const [row] = await db
    .select({ r: schema.reports, c: schema.clients })
    .from(schema.reports)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.reports.clientId))
    .where(eq(schema.reports.id, id));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const weeks = row.r.kind === "monthly" ? await weeklyReportsForMonth(row.c.id, row.r.period) : [];
  const bytes = await monthlyReportPdf({ client: row.c, report: row.r, weeks });
  const name = pdfFileName(row.c.name, row.r.kind, row.r.period);
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
      "cache-control": "private, no-store",
    },
  });
}

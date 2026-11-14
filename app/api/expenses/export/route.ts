import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/roles";
import { exportExpensesCsv } from "@/lib/expenses";

// CSV for the accountant: ?month=YYYY-MM (or ?from=YYYY-MM-DD&to=YYYY-MM-DD, or ?year=YYYY). Owners only.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "payments")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const month = /^\d{4}-\d{2}$/.test(sp.get("month") ?? "") ? sp.get("month")! : undefined;
  const year = /^\d{4}$/.test(sp.get("year") ?? "") ? sp.get("year")! : undefined;
  const from = year ? `${year}-01-01` : iso(sp.get("from"));
  const to = year ? `${Number(year) + 1}-01-01` : iso(sp.get("to"));
  const csv = await exportExpensesCsv({ month: month ?? (from || to ? undefined : new Date().toISOString().slice(0, 7)), from, to, category: sp.get("category") ?? undefined });
  const name = `1media-expenses-${month ?? year ?? `${from ?? "start"}_${to ?? "now"}`}.csv`;
  return new NextResponse("﻿" + csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}

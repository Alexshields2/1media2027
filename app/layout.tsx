import type { Metadata } from "next";
import { count, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/session";
import { Nav } from "./_components/nav";
import { TopBar } from "./_components/topbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "1Media OS",
  description: "The operating system for 1Media: clients, cash, delivery and AI agents.",
};

async function pendingApprovals() {
  try {
    const [r] = await db.select({ n: count() }).from(schema.approvals).where(eq(schema.approvals.status, "pending"));
    return r?.n ?? 0;
  } catch {
    return 0; // never let the badge take the whole app down
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const pending = user ? await pendingApprovals() : 0;
  const date = new Date().toLocaleDateString("en-IE", { timeZone: "Europe/Dublin", weekday: "short", day: "numeric", month: "short" });
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {user ? (
          <div className="flex min-h-screen flex-col md:flex-row">
            <a href="#main" className="sr-only z-50 rounded-full bg-white px-4 py-2 text-sm font-medium text-[#020617] focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
              Skip to content
            </a>
            <Nav user={{ name: user.name, role: user.role }} pending={pending} />
            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar pending={pending} date={date} />
              <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">
                <div className="mx-auto max-w-7xl">{children}</div>
              </main>
            </div>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}

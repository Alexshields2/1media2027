import type { Metadata } from "next";
import { count, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentUser } from "@/lib/session";
import { Nav } from "./_components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "1Media OS",
  description: "The operating system for 1Media: clients, cash, delivery and AI agents.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  const pending = user
    ? await db
        .select({ n: count() })
        .from(schema.approvals)
        .where(eq(schema.approvals.status, "pending"))
        .then((r) => r[0]?.n ?? 0)
        .catch(() => 0)
    : 0;
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {user ? (
          <div className="flex min-h-screen flex-col md:flex-row">
            <Nav user={{ name: user.name, role: user.role, title: user.title }} pending={pending} />
            <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-10">
              <div className="mx-auto max-w-6xl">{children}</div>
            </main>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}

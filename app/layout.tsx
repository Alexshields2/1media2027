import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isValidSession } from "@/lib/auth";
import { Nav } from "./_components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "1Media OS",
  description: "The operating system for 1Media: clients, cash, delivery and AI agents.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await isValidSession((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {signedIn ? (
          <div className="flex min-h-screen flex-col md:flex-row">
            <Nav />
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

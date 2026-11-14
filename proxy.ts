import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfigured, verifySession } from "./src/lib/auth";

// Every page needs a login cookie, except the login page itself and the
// machine endpoints (cron and webhooks), which check their own secrets.
export async function proxy(req: NextRequest) {
  if (!authConfigured()) {
    return new NextResponse("1Media OS needs a database (DATABASE_URL) or AUTH_SECRET. Add them in Vercel -> Settings -> Environment Variables / Storage, then redeploy.", { status: 503 });
  }
  if ((await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) !== null) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/cron|api/webhooks|_next|favicon.ico).*)"],
};

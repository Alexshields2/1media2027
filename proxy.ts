import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authSecret, verifySigned } from "./src/lib/session-token";

// Every page needs a signed session cookie, except the login and first-run setup pages and the
// machine endpoints (cron and webhooks), which check their own secrets. This is only the cheap
// first check (signature, no database): every page and server action also checks the session
// row and the person's role on the server (src/lib/session.ts), so revoked sessions stop at once.
export async function proxy(req: NextRequest) {
  if (!authSecret()) {
    return new NextResponse("1Media OS needs AUTH_SECRET and a database. Add them in Vercel -> Settings -> Environment Variables / Storage, then redeploy.", { status: 503 });
  }
  if (await verifySigned(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|setup|api/cron|api/webhooks|_next|favicon.ico|icon|1media-logo.png).*)"],
};

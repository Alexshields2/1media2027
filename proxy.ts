import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession, sessionToken } from "./src/lib/auth";

// Every page needs the login cookie, except the login page itself and the
// machine endpoints (cron and webhooks), which check their own secrets, and the public /api/health check.
export async function proxy(req: NextRequest) {
  if (!(await sessionToken())) {
    return new NextResponse("1Media OS needs ADMIN_PASSWORD and a database. Add them in Vercel -> Settings -> Environment Variables / Storage, then redeploy.", { status: 503 });
  }
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/cron|api/webhooks|api/health|_next|favicon.ico|icon|1media-logo.png).*)"],
};

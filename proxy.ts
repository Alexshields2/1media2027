import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession, sessionToken } from "./src/lib/auth";

// Every page needs the login cookie, except the login page itself and the
// machine endpoints (cron and webhooks), which check their own secrets.
export async function proxy(req: NextRequest) {
  if (!(await sessionToken())) {
    return new NextResponse("Set ADMIN_PASSWORD and AUTH_SECRET to use 1Media OS.", { status: 503 });
  }
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/cron|api/webhooks|_next|favicon.ico).*)"],
};

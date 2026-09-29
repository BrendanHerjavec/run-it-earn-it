import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Paths reachable without the app password. Each one authenticates itself:
 * the Strava webhook with its verify token + athlete check, the COROS poll
 * with a session or CRON_SECRET, and the reward
 * approve/skip links with a signed single-use token.
 */
const PUBLIC = [
  /^\/login$/,
  /^\/api\/auth\//,
  /^\/api\/strava\/webhook$/,
  /^\/api\/coros\/poll$/,
  /^\/api\/rewards\/\d+\/(approve|skip)$/,
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL("/login", req.url);
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};

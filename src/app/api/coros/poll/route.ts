import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { syncCoros } from "@/lib/coros-sync";
import { logEvent } from "@/lib/events";
import { pipelineDeps } from "@/lib/pipeline-deps";

// New rewards run the agent in after(); give it room on Vercel.
export const maxDuration = 300;

function cronAuthorized(req: NextRequest): boolean {
  const secret = config().CRON_SECRET;
  if (!secret) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.nextUrl.searchParams.get("key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Check COROS for new runs. Called every 1–2 minutes by an external cron
 * (Authorization: Bearer CRON_SECRET), or by the dashboard when logged in.
 */
async function handle(req: NextRequest) {
  const loggedIn = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!loggedIn && !cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  try {
    const result = await syncCoros(db, pipelineDeps());
    return NextResponse.json(result);
  } catch (err) {
    await logEvent(db, { kind: "coros.sync_failed", message: String(err) });
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export { handle as GET, handle as POST };

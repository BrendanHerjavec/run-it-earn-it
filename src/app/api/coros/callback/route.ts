import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { completeAuthorization, COROS_STATE_COOKIE } from "@/lib/coros";
import { logEvent } from "@/lib/events";
import { getUser } from "@/lib/settings";

export async function GET(req: NextRequest) {
  const done = (result: string) => {
    const res = NextResponse.redirect(new URL(`/settings?coros=${result}`, req.url));
    res.cookies.delete({ name: COROS_STATE_COOKIE, path: "/api/coros" });
    return res;
  };
  const db = await getDb();
  const p = req.nextUrl.searchParams;
  let saved: { state?: string; verifier?: string } = {};
  try {
    saved = JSON.parse(req.cookies.get(COROS_STATE_COOKIE)?.value ?? "{}");
  } catch {}
  if (p.get("error")) {
    await logEvent(db, { kind: "coros.connect_failed", message: `COROS returned ${p.get("error")}: ${p.get("error_description") ?? ""}` });
    return done("error");
  }
  const code = p.get("code");
  if (!code || !saved.state || p.get("state") !== saved.state || !saved.verifier) return done("error");

  try {
    await completeAuthorization(db, await getUser(db), code, saved.verifier);
    await logEvent(db, { kind: "coros.connected", message: "COROS account connected" });
    return done("connected");
  } catch (err) {
    await logEvent(db, { kind: "coros.connect_failed", message: String(err) });
    return done("error");
  }
}

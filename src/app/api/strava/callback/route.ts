import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { logEvent } from "@/lib/events";
import { getUser } from "@/lib/settings";
import { exchangeCode, saveTokens, STATE_COOKIE } from "@/lib/strava";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const done = (result: string) => {
    const res = NextResponse.redirect(new URL(`/settings?strava=${result}`, req.url));
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/strava" });
    return res;
  };

  const state = url.searchParams.get("state");
  if (!state || state !== req.cookies.get(STATE_COOKIE)?.value) return done("error");
  if (url.searchParams.get("error")) return done("error");

  // Strava returns the scopes the athlete actually granted; without activity:read_all
  // we can't see private runs, and without activity:read we can't see any.
  const scope = url.searchParams.get("scope") ?? "";
  if (!scope.includes("activity:read")) return done("error");

  const code = url.searchParams.get("code");
  if (!code) return done("error");

  const db = await getDb();
  try {
    const { athleteId, tokens, athleteName } = await exchangeCode(code);
    const user = await getUser(db);
    await saveTokens(db, user.id, athleteId, tokens);
    await logEvent(db, { kind: "strava.connected", message: `Connected athlete ${athleteId} (${athleteName ?? "?"}), scope ${scope}` });
    return done("connected");
  } catch (err) {
    await logEvent(db, { kind: "strava.connect_failed", message: String(err) });
    return done("error");
  }
}

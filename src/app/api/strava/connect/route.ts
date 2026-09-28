import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { authorizeUrl, STATE_COOKIE } from "@/lib/strava";

export async function GET() {
  if (!config().STRAVA_CLIENT_ID) {
    return NextResponse.json({ error: "STRAVA_CLIENT_ID is not set" }, { status: 500 });
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/strava",
    maxAge: 600,
  });
  return res;
}

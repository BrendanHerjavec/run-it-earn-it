import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { users, type User } from "@/db/schema";
import { config } from "./config";
import { decryptJson, encryptJson } from "./crypto";

/**
 * Strava API v3. Docs checked 2026-09-27:
 *  - OAuth: https://developers.strava.com/docs/authentication/ (access tokens last 6h;
 *    every refresh returns a NEW refresh token that must replace the old one)
 *  - Webhooks: https://developers.strava.com/docs/webhooks/ (ack within 2s)
 *  - `type` is deprecated in favour of `sport_type`.
 */
export const STRAVA_API = "https://www.strava.com/api/v3";
export const STRAVA_SCOPE = "read,activity:read_all";
export const STATE_COOKIE = "rie_strava_state";

export type StravaTokens = { accessToken: string; refreshToken: string; expiresAt: number };

/** The subset of DetailedActivity we use. */
export type StravaActivity = {
  id: number;
  name: string;
  sport_type: string;
  type?: string;
  distance: number; // metres
  moving_time: number; // seconds
  elapsed_time: number;
  average_speed: number; // m/s
  start_date: string; // ISO UTC
  map?: { polyline?: string | null; summary_polyline?: string | null };
  athlete?: { id: number };
};

export type StravaWebhookEvent = {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  updates?: Record<string, string>;
  owner_id: number;
  subscription_id: number;
  event_time: number;
};

export function authorizeUrl(state: string): string {
  const c = config();
  const u = new URL("https://www.strava.com/oauth/authorize");
  u.searchParams.set("client_id", c.STRAVA_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${c.APP_BASE_URL}/api/strava/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("approval_prompt", "auto");
  u.searchParams.set("scope", STRAVA_SCOPE);
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number; firstname?: string; lastname?: string };
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const c = config();
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.STRAVA_CLIENT_ID, client_secret: c.STRAVA_CLIENT_SECRET, ...body }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Strava token request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(code: string): Promise<{ athleteId: number; tokens: StravaTokens; athleteName?: string }> {
  const r = await tokenRequest({ code, grant_type: "authorization_code" });
  if (!r.athlete?.id) throw new Error("Strava token response had no athlete");
  return {
    athleteId: r.athlete.id,
    athleteName: [r.athlete.firstname, r.athlete.lastname].filter(Boolean).join(" ") || undefined,
    tokens: { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at },
  };
}

export async function saveTokens(db: DB, userId: number, athleteId: number, tokens: StravaTokens) {
  await db.update(users).set({ stravaAthleteId: athleteId, stravaTokensEnc: encryptJson(tokens) }).where(eq(users.id, userId));
}

/** Returns a valid access token, refreshing (and persisting the rotated refresh token) if needed. */
export async function getAccessToken(db: DB, user: User): Promise<string> {
  if (!user.stravaTokensEnc || !user.stravaAthleteId) throw new Error("Strava is not connected");
  const tokens = decryptJson<StravaTokens>(user.stravaTokensEnc);
  if (tokens.expiresAt - 120 > Date.now() / 1000) return tokens.accessToken;
  const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  const next = { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at };
  await saveTokens(db, user.id, user.stravaAthleteId, next);
  return next.accessToken;
}

export async function fetchActivity(accessToken: string, id: number): Promise<StravaActivity> {
  const res = await fetch(`${STRAVA_API}/activities/${id}?include_all_efforts=false`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Strava GET /activities/${id} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { settings, users, type User } from "@/db/schema";
import { config } from "./config";
import { decryptJson, encryptJson } from "./crypto";
import { getSettingsRow } from "./settings";

/**
 * COROS official MCP server (https://github.com/coroslab/COROS-MCP), checked 2026-09-29:
 *  - OAuth 2.0 + PKCE (S256), public client, dynamic client registration (RFC 7591).
 *    No developer application or approval needed; data is scoped to the signed-in user.
 *  - Discovery: GET {MCP_URL origin}/.well-known/oauth-protected-resource/mcp
 *    → authorization server → /.well-known/oauth-authorization-server
 *  - No webhooks: we poll for new activities.
 *  - FIT file downloads (with GPS) are limited to 50 per calendar day.
 */
export const COROS_MCP_URL = "https://mcp.coros.com/mcp";
export const COROS_SCOPE = "openid mcp.tools offline_access";
export const COROS_STATE_COOKIE = "rie_coros_oauth";

type AuthServerMeta = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

export type CorosTokens = { accessToken: string; refreshToken?: string; expiresAt: number; resource: string; tokenEndpoint: string };

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

export async function discover(): Promise<{ resource: string; as: AuthServerMeta }> {
  const origin = new URL(COROS_MCP_URL).origin;
  const pr = await getJson<{ resource: string; authorization_servers: string[] }>(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const asUrl = pr.authorization_servers[0];
  const as = await getJson<AuthServerMeta>(`${asUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  return { resource: pr.resource, as };
}

export function corosRedirectUri() {
  return `${config().APP_BASE_URL.replace(/\/$/, "")}/api/coros/callback`;
}

/** Register (once per redirect URI) a public OAuth client with COROS and remember its ID. */
async function ensureClient(db: DB, as: AuthServerMeta): Promise<string> {
  const row = await getSettingsRow(db);
  const redirectUri = corosRedirectUri();
  if (row.corosClientId && row.corosRedirectUri === redirectUri) return row.corosClientId;
  const reg = await getJson<{ client_id: string }>(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Run It, Earn It",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: COROS_SCOPE,
    }),
  });
  await db.update(settings).set({ corosClientId: reg.client_id, corosRedirectUri: redirectUri }).where(eq(settings.id, 1));
  return reg.client_id;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Build the COROS login URL. Returns the PKCE verifier + state to keep in a cookie. */
export async function beginAuthorization(db: DB) {
  const { resource, as } = await discover();
  const clientId = await ensureClient(db, as);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", corosRedirectUri());
  u.searchParams.set("scope", COROS_SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", resource);
  return { url: u.toString(), cookie: JSON.stringify({ state, verifier }) };
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

async function tokenRequest(tokenEndpoint: string, params: Record<string, string>): Promise<TokenResponse> {
  return getJson<TokenResponse>(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
}

function toTokens(r: TokenResponse, resource: string, tokenEndpoint: string, prevRefresh?: string): CorosTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? prevRefresh,
    expiresAt: Math.floor(Date.now() / 1000) + (r.expires_in ?? 3600),
    resource,
    tokenEndpoint,
  };
}

export async function completeAuthorization(db: DB, user: User, code: string, verifier: string) {
  const { resource, as } = await discover();
  const row = await getSettingsRow(db);
  if (!row.corosClientId) throw new Error("No COROS client registered");
  const r = await tokenRequest(as.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: corosRedirectUri(),
    client_id: row.corosClientId,
    code_verifier: verifier,
    resource,
  });
  const tokens = toTokens(r, resource, as.token_endpoint);
  await db
    .update(users)
    .set({ corosTokensEnc: encryptJson(tokens), corosConnectedAt: new Date() })
    .where(eq(users.id, user.id));
  return tokens;
}

/** A valid access token, refreshing (and saving) it when it's about to expire. */
export async function getCorosAccessToken(db: DB, user: User): Promise<string> {
  if (!user.corosTokensEnc) throw new Error("COROS is not connected");
  const t = decryptJson<CorosTokens>(user.corosTokensEnc);
  if (t.expiresAt - 120 > Date.now() / 1000) return t.accessToken;
  if (!t.refreshToken) throw new Error("COROS session expired; reconnect in Settings");
  const row = await getSettingsRow(db);
  const r = await tokenRequest(t.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: t.refreshToken,
    client_id: row.corosClientId ?? "",
    resource: t.resource,
  });
  const next = toTokens(r, t.resource, t.tokenEndpoint, t.refreshToken);
  await db.update(users).set({ corosTokensEnc: encryptJson(next) }).where(eq(users.id, user.id));
  return next.accessToken;
}

/** Open an MCP session with the user's token, run `fn`, and always close it. */
export async function withCoros<T>(db: DB, user: User, fn: (client: Client) => Promise<T>): Promise<T> {
  const token = await getCorosAccessToken(db, user);
  const transport = new StreamableHTTPClientTransport(new URL(COROS_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "run-it-earn-it", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

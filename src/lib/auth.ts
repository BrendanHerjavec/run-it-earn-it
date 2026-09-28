/**
 * Single-password auth. The session cookie is `<expiresAtMs>.<hmac>` where the
 * HMAC key is derived from APP_PASSWORD + APPROVAL_SIGNING_SECRET, so changing
 * either one logs every session out. Uses Web Crypto so it works in proxy.ts.
 */
export const SESSION_COOKIE = "rie_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64url");
}

async function key(): Promise<CryptoKey> {
  const secret = `${process.env.APP_PASSWORD ?? ""}|${process.env.APPROVAL_SIGNING_SECRET ?? ""}|session`;
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(payload: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await key(), enc.encode(payload)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(now = Date.now()): Promise<{ token: string; expires: Date }> {
  const exp = now + SESSION_TTL_MS;
  return { token: `${exp}.${await sign(String(exp))}`, expires: new Date(exp) };
}

export async function verifySessionToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token || !process.env.APP_PASSWORD) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now || !sig) return false;
  return safeEqual(sig, await sign(expStr));
}

export async function checkPassword(candidate: string): Promise<boolean> {
  const real = process.env.APP_PASSWORD ?? "";
  if (!real) return false;
  // Compare HMACs so the comparison time doesn't leak the password length.
  return safeEqual(await sign(`pw:${candidate}`), await sign(`pw:${real}`));
}

/** For Server Actions and route handlers, which proxy.ts can't be relied on to guard alone. */
export async function requireAuth(): Promise<void> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  if (!(await verifySessionToken(jar.get(SESSION_COOKIE)?.value))) {
    throw new Error("Unauthorized");
  }
}

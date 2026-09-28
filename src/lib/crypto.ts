import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config";

/**
 * AES-256-GCM for secrets at rest (Strava tokens). TOKEN_ENCRYPTION_KEY can be
 * any string; it is hashed to 32 bytes. Output: base64(iv | tag | ciphertext).
 */
function key(): Buffer {
  const raw = config().TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  return createHash("sha256").update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptJson<T>(blob: string): T {
  const buf = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

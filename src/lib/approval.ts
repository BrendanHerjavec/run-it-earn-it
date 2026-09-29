import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { rewardEvents } from "@/db/schema";
import { config } from "./config";
import { sha256 } from "./crypto";

export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Approval links look like /api/rewards/12/approve?token=<nonce>.<sig>
 *  - sig = HMAC(APPROVAL_SIGNING_SECRET, "reward:12:<nonce>") binds the token to this reward
 *  - only sha256(token) is stored, with an expiry, and it's cleared on first use
 * One token serves both Approve and Skip; whichever is tapped first consumes it.
 */
function sign(rewardId: number, nonce: string): string {
  const secret = config().APPROVAL_SIGNING_SECRET;
  if (!secret) throw new Error("APPROVAL_SIGNING_SECRET is not set");
  return createHmac("sha256", secret).update(`reward:${rewardId}:${nonce}`).digest("base64url");
}

export async function issueApprovalToken(db: DB, rewardId: number, now = new Date()): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const token = `${nonce}.${sign(rewardId, nonce)}`;
  await db
    .update(rewardEvents)
    .set({ approvalTokenHash: sha256(token), approvalTokenExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS), approvalTokenUsedAt: null })
    .where(eq(rewardEvents.id, rewardId));
  return token;
}

export function signatureValid(rewardId: number, token: string): boolean {
  const [nonce, sig] = token.split(".");
  if (!nonce || !sig) return false;
  const expected = Buffer.from(sign(rewardId, nonce));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type ConsumeResult = "ok" | "invalid" | "expired_or_used";

/** Atomically consume the token. Exactly one concurrent caller can get "ok". */
export async function consumeApprovalToken(db: DB, rewardId: number, token: string, now = new Date()): Promise<ConsumeResult> {
  if (!signatureValid(rewardId, token)) return "invalid";
  const rows = await db
    .update(rewardEvents)
    .set({ approvalTokenUsedAt: now })
    .where(
      and(
        eq(rewardEvents.id, rewardId),
        eq(rewardEvents.approvalTokenHash, sha256(token)),
        isNull(rewardEvents.approvalTokenUsedAt),
        gt(rewardEvents.approvalTokenExpiresAt, now),
      ),
    )
    .returning({ id: rewardEvents.id });
  return rows.length === 1 ? "ok" : "expired_or_used";
}

/** Dashboard approvals don't need the token, but they must still burn it. */
export async function burnApprovalToken(db: DB, rewardId: number, now = new Date()) {
  await db
    .update(rewardEvents)
    .set({ approvalTokenUsedAt: now })
    .where(and(eq(rewardEvents.id, rewardId), isNull(rewardEvents.approvalTokenUsedAt)));
}

export function approvalUrls(rewardId: number, token: string) {
  const base = config().APP_BASE_URL.replace(/\/$/, "");
  const q = `token=${encodeURIComponent(token)}`;
  return {
    approve: `${base}/api/rewards/${rewardId}/approve?${q}`,
    skip: `${base}/api/rewards/${rewardId}/skip?${q}`,
    page: `${base}/rewards/${rewardId}`,
  };
}

export function rewardPageUrl(rewardId: number) {
  return `${config().APP_BASE_URL.replace(/\/$/, "")}/rewards/${rewardId}`;
}

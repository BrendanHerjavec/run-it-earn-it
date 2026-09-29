import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { rewardEvents } from "@/db/schema";
import { APPROVAL_TTL_MS, consumeApprovalToken, issueApprovalToken } from "@/lib/approval";
import { getProvider, MockProvider } from "@/lib/providers";
import { storeActivity } from "@/lib/pipeline";
import { freshDb, stravaRun } from "./helpers";

let db: DB;
let id: number;
let other: number;

beforeEach(async () => {
  db = await freshDb();
  const a1 = (await storeActivity(db, stravaRun(), "strava")).activity;
  const a2 = (await storeActivity(db, stravaRun(), "strava")).activity;
  [{ id }] = await db.insert(rewardEvents).values({ activityId: a1.id, status: "awaiting_approval" }).returning();
  [{ id: other }] = await db.insert(rewardEvents).values({ activityId: a2.id, status: "awaiting_approval" }).returning();
});

describe("approval links", () => {
  it("are single-use", async () => {
    const token = await issueApprovalToken(db, id);
    expect(await consumeApprovalToken(db, id, token)).toBe("ok");
    expect(await consumeApprovalToken(db, id, token)).toBe("expired_or_used");
  });

  it("only one of many concurrent taps wins", async () => {
    const token = await issueApprovalToken(db, id);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => consumeApprovalToken(db, id, token)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("expire after 2 hours", async () => {
    const issued = new Date("2026-09-27T12:00:00Z");
    const token = await issueApprovalToken(db, id, issued);
    expect(await consumeApprovalToken(db, id, token, new Date(issued.getTime() + APPROVAL_TTL_MS + 1000))).toBe("expired_or_used");
  });

  it("are bound to their reward and can't be forged", async () => {
    const token = await issueApprovalToken(db, id);
    expect(await consumeApprovalToken(db, other, token)).toBe("invalid");
    const [nonce] = token.split(".");
    expect(await consumeApprovalToken(db, id, `${nonce}.forged`)).toBe("invalid");
    expect(await consumeApprovalToken(db, id, "garbage")).toBe("invalid");
  });

  it("re-issuing invalidates the previous link", async () => {
    const first = await issueApprovalToken(db, id);
    await issueApprovalToken(db, id);
    expect(await consumeApprovalToken(db, id, first)).toBe("expired_or_used");
  });
});

describe("kill switch", () => {
  it("returns the mock provider whenever PURCHASES_ENABLED is false, whatever is selected", () => {
    expect(getProvider({ provider: "crossmint", purchasesEnabled: false })).toBeInstanceOf(MockProvider);
    expect(getProvider({ provider: "rye", purchasesEnabled: false })).toBeInstanceOf(MockProvider);
    expect(getProvider({ provider: "crossmint", purchasesEnabled: true }).name).toBe("crossmint");
  });
});

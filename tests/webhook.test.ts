import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { activities, rewardEvents, users } from "@/db/schema";
import { encodePolyline, offsetPoint, type LatLng } from "@/lib/geo";
import { handleWebhookEvent } from "@/lib/pipeline";
import type { StravaWebhookEvent } from "@/lib/strava";
import { addGoal, ATHLETE_ID, freshDb, seedWishlist, stravaRun } from "./helpers";

let db: DB;

beforeEach(async () => {
  db = await freshDb();
  await seedWishlist(db);
});

function createEvent(objectId: number, over: Partial<StravaWebhookEvent> = {}): StravaWebhookEvent {
  return {
    object_type: "activity",
    object_id: objectId,
    aspect_type: "create",
    owner_id: ATHLETE_ID,
    subscription_id: 1,
    event_time: 1_790_000_000,
    ...over,
  };
}

describe("webhook idempotency", () => {
  it("duplicate deliveries of the same event create one activity and one reward", async () => {
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    const run = stravaRun({ distance: 5200 });
    const fetchActivity = vi.fn(async () => run);
    const onRewardCreated = vi.fn(async () => {});
    const deps = { fetchActivity, onRewardCreated };

    const first = await handleWebhookEvent(db, createEvent(run.id), deps);
    const second = await handleWebhookEvent(db, createEvent(run.id), deps);
    const third = await handleWebhookEvent(db, createEvent(run.id), deps);

    expect(first.status).toBe("reward_created");
    expect(second.status).toBe("duplicate");
    expect(third.status).toBe("duplicate");
    expect(fetchActivity).toHaveBeenCalledTimes(1); // retries don't re-fetch from Strava
    expect(onRewardCreated).toHaveBeenCalledTimes(1); // the agent starts exactly once
    expect(await db.select().from(activities)).toHaveLength(1);
    expect(await db.select().from(rewardEvents)).toHaveLength(1);
  });

  it("concurrent deliveries still produce a single reward", async () => {
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    const run = stravaRun({ distance: 6000 });
    const deps = { fetchActivity: async () => run };
    const results = await Promise.all([1, 2, 3, 4].map(() => handleWebhookEvent(db, createEvent(run.id), deps)));
    expect(results.filter((r) => r.status === "reward_created")).toHaveLength(1);
    expect(await db.select().from(rewardEvents)).toHaveLength(1);
  });

  it("ignores events for other athletes, updates and deletes", async () => {
    const fetchActivity = vi.fn(async () => stravaRun());
    expect((await handleWebhookEvent(db, createEvent(1, { owner_id: 999 }), { fetchActivity })).status).toBe("ignored");
    expect((await handleWebhookEvent(db, createEvent(1, { aspect_type: "update" }), { fetchActivity })).status).toBe("ignored");
    expect((await handleWebhookEvent(db, createEvent(1, { aspect_type: "delete" }), { fetchActivity })).status).toBe("ignored");
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("clears stored tokens when the athlete deauthorizes the app", async () => {
    await db.update(users).set({ stravaTokensEnc: "x" });
    await handleWebhookEvent(db, createEvent(ATHLETE_ID, { object_type: "athlete", aspect_type: "update", updates: { authorized: "false" } }));
    const [u] = await db.select().from(users);
    expect(u.stravaAthleteId).toBeNull();
    expect(u.stravaTokensEnc).toBeNull();
  });
});

describe("quests through the full pipeline", () => {
  it("a run through the quest earns it once; a second run through doesn't", async () => {
    const pin: LatLng = [43.6534, -79.3841];
    await addGoal(db, { type: "quest", name: "City Hall", lat: pin[0], lng: pin[1], radiusM: 75 });
    const through = encodePolyline([offsetPoint(pin, 270, 1200), offsetPoint(pin, 90, 1200)]);
    const run1 = stravaRun({ distance: 2400, map: { summary_polyline: through } });
    const run2 = stravaRun({ distance: 2400, map: { summary_polyline: through }, start_date: "2026-09-24T11:00:00Z" });

    expect((await handleWebhookEvent(db, createEvent(run1.id), { fetchActivity: async () => run1 })).status).toBe("reward_created");
    expect((await handleWebhookEvent(db, createEvent(run2.id), { fetchActivity: async () => run2 })).status).toBe("no_goal");
  });
});

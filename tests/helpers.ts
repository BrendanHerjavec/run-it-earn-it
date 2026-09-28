import { getDb, setDbForTests, type DB } from "@/db";
import { goals, users, wishlistItems } from "@/db/schema";
import { resetConfigCache } from "@/lib/config";
import type { StravaActivity } from "@/lib/strava";

export const ATHLETE_ID = 424242;

/** Fresh, migrated, empty in-memory database with one connected user. */
export async function freshDb(): Promise<DB> {
  resetConfigCache();
  setDbForTests(undefined);
  const db = await getDb();
  await db.insert(users).values({ name: "Test Runner", timezone: "America/Toronto", stravaAthleteId: ATHLETE_ID });
  return db;
}

export async function seedWishlist(db: DB) {
  return db
    .insert(wishlistItems)
    .values([
      { title: "Gels", productUrl: "https://example.com/gels", expectedPriceCents: 12_00, tier: "small" },
      { title: "Protein bars", productUrl: "https://example.com/bars", expectedPriceCents: 24_99, tier: "medium" },
      { title: "Vest", productUrl: "https://example.com/vest", expectedPriceCents: 35_00, tier: "large" },
    ])
    .returning();
}

export async function addGoal(db: DB, g: Partial<typeof goals.$inferInsert> & Pick<typeof goals.$inferInsert, "type">) {
  const [row] = await db.insert(goals).values({ name: g.name ?? g.type, rewardTier: "medium", ...g }).returning();
  return row;
}

let nextId = 1000;
export function stravaRun(over: Partial<StravaActivity> = {}): StravaActivity {
  const distance = over.distance ?? 5200;
  const moving = over.moving_time ?? 1700;
  return {
    id: nextId++,
    name: "Morning Run",
    sport_type: "Run",
    distance,
    moving_time: moving,
    elapsed_time: moving + 30,
    average_speed: distance / moving,
    start_date: "2026-09-23T11:00:00Z", // Wednesday
    map: { summary_polyline: null },
    ...over,
  };
}

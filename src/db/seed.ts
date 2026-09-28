import type { DB } from "./index";
import { goals, settings, users, wishlistItems } from "./schema";

/**
 * Sample data so the app is usable immediately. The product URLs are
 * placeholders: replace them on /wishlist with real product pages before
 * using a real checkout provider.
 */
export async function seedIfEmpty(db: DB) {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return false;

  await db.insert(users).values({
    name: "Runner",
    email: "",
    province: "ON",
    country: "CA",
    timezone: "America/Toronto",
  });

  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();

  await db.insert(goals).values({
    name: "Run 5 km",
    type: "single_run_distance",
    targetKm: 5,
    rewardTier: "medium",
  });

  await db.insert(wishlistItems).values([
    {
      title: "Chocolate protein bars (12 pack)",
      productUrl: "https://example.com/replace-me/protein-bars",
      expectedPriceCents: 24_99,
      tier: "medium",
      notes: "Flavour: chocolate. Any reputable brand, 12 bars.",
    },
    {
      title: "Running socks (3 pair)",
      productUrl: "https://example.com/replace-me/running-socks",
      expectedPriceCents: 19_99,
      tier: "medium",
      notes: "Size: men's 9-11 (large). Low-cut, cushioned.",
    },
    {
      title: "Electrolyte drink tabs",
      productUrl: "https://example.com/replace-me/electrolyte-tabs",
      expectedPriceCents: 12_99,
      tier: "small",
      notes: "Flavour: lemon-lime. One tube.",
    },
    {
      title: "Energy gels (8 pack)",
      productUrl: "https://example.com/replace-me/energy-gels",
      expectedPriceCents: 14_49,
      tier: "small",
      notes: "Any flavour except coffee.",
    },
    {
      title: "Reflective running vest",
      productUrl: "https://example.com/replace-me/reflective-vest",
      expectedPriceCents: 34_99,
      tier: "large",
      notes: "Size: M/L. For night runs.",
    },
  ]);

  return true;
}

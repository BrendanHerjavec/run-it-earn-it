export const TIERS = ["small", "medium", "large"] as const;
export type Tier = (typeof TIERS)[number];

/** Upper bound of each reward tier's price band, in cents. */
export const TIER_MAX_CENTS: Record<Tier, number> = {
  small: 15_00,
  medium: 30_00,
  large: 60_00,
};

/** A goal of a given tier can reward any item at or below that tier. */
export function tierAllows(goalTier: Tier, itemTier: Tier): boolean {
  return TIERS.indexOf(itemTier) <= TIERS.indexOf(goalTier);
}

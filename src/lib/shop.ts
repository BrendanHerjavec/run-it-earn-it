import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { wishlistItems, type WishlistItem } from "@/db/schema";
import type { Tier } from "./tiers";

/**
 * Shop challenges: Claude picks straight from a store's live Shopify
 * collection (e.g. Eight Ounce Coffee's "Funky" filter coffees) instead of
 * the wishlist. Read from the store's public /collections/{handle}/products.json
 * (the same JSON its own storefront uses), so no scraper or API key is needed.
 */

export type ShopProduct = {
  handle: string;
  url: string;
  title: string;
  vendor: string;
  priceCents: number;
  /** "Tasting: Strawberry, Raspberry · Anaerobic · Colombia · 227g" for Claude. */
  notes: string;
};

type ShopifyJson = {
  products: {
    handle: string;
    title: string;
    vendor: string;
    body_html: string | null;
    tags: string[];
    variants: { id: number; price: string; available: boolean }[];
  }[];
};

type Fetch = typeof fetch;

const TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __runnyShopCache?: Map<string, { at: number; items: ShopProduct[] }> };
const cache = (g.__runnyShopCache ??= new Map());

/** "https://store/collections/funky?sort_by=…" → origin + collection handle. */
export function parseCollectionUrl(url: string): { origin: string; handle: string } | null {
  try {
    const u = new URL(url);
    const handle = u.pathname.match(/\/collections\/([^/?#]+)/)?.[1];
    return handle ? { origin: u.origin, handle } : null;
  } catch {
    return null;
  }
}

const tagValue = (tags: string[], prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

function describe(p: ShopifyJson["products"][number]): string {
  const tasting = (p.body_html ?? "")
    .replace(/<[^>]+>/g, "\n")
    .match(/Tasting Notes?:\s*([^\n]+)/i)?.[1]
    ?.trim()
    .replace(/\.$/, "");
  const caf = tagValue(p.tags, "caf_");
  return [
    tasting && `Tasting: ${tasting}`,
    tagValue(p.tags, "proc_"),
    tagValue(p.tags, "var_"),
    tagValue(p.tags, "cty_"),
    tagValue(p.tags, "roast_") && `${tagValue(p.tags, "roast_")} roast`,
    caf && caf !== "Full Caffeine" ? caf : null,
    tagValue(p.tags, "size_"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * In-stock products of a collection, filtered by tags: comma-separated,
 * case-insensitive substrings that must all match, e.g. "meth_Filter, whole bean"
 * keeps "meth_Filter or Espresso" beans but drops sachets and instant.
 * Cached for 10 minutes so one Sync's several picks share one fetch.
 */
export async function shopCatalog(collectionUrl: string, tags = "", fetchImpl: Fetch = fetch): Promise<ShopProduct[]> {
  const parsed = parseCollectionUrl(collectionUrl);
  if (!parsed) throw new Error(`Not a store collection link: ${collectionUrl}`);
  const key = `${parsed.origin}/${parsed.handle}|${tags}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && fetchImpl === fetch) return hit.items;

  const wants = tags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const items: ShopProduct[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`${parsed.origin}/collections/${parsed.handle}/products.json?limit=250&page=${page}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Store returned ${res.status} for ${parsed.handle}`);
    const { products } = (await res.json()) as ShopifyJson;
    if (!products?.length) break;
    for (const p of products) {
      if (!wants.every((w) => p.tags.some((t) => t.toLowerCase().includes(w)))) continue;
      const v = p.variants.find((x) => x.available);
      if (!v) continue;
      items.push({
        handle: p.handle,
        url: `${parsed.origin}/products/${p.handle}${p.variants.length > 1 ? `?variant=${v.id}` : ""}`,
        title: p.vendor && !p.title.toLowerCase().includes(p.vendor.toLowerCase().split(" ")[0]) ? `${p.vendor} - ${p.title}` : p.title,
        vendor: p.vendor,
        priceCents: Math.round(Number(v.price) * 100),
        notes: describe(p),
      });
    }
    if (products.length < 250) break;
  }
  cache.set(key, { at: Date.now(), items });
  return items;
}

const tierFor = (cents: number): Tier => (cents <= 30_00 ? "small" : cents <= 60_00 ? "medium" : "large");

/** The wishlist row for a shop pick (created on first pick, refreshed after), so rewards and orders can point at it. */
export async function upsertShopItem(db: DB, p: ShopProduct): Promise<WishlistItem> {
  const values = { title: p.title, productUrl: p.url, expectedPriceCents: p.priceCents, tier: tierFor(p.priceCents), notes: p.notes, source: "shop" as const };
  const [existing] = await db
    .select()
    .from(wishlistItems)
    .where(and(eq(wishlistItems.productUrl, p.url), eq(wishlistItems.source, "shop")));
  if (existing) {
    const [row] = await db.update(wishlistItems).set(values).where(eq(wishlistItems.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(wishlistItems).values(values).returning();
  return row;
}

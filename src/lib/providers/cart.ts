import { spawn } from "node:child_process";
import type { WishlistItem } from "@/db/schema";
import type { Buyer, CheckoutProvider, CheckoutStatus, Quote } from "./types";

/**
 * Terms-safe checkout: nothing automates the store. The app builds the store's
 * own official cart link and opens it in your normal browser; you click Pay.
 *
 *  - Shopify stores: cart permalink https://STORE/cart/VARIANT:1 with
 *    checkout[email] and checkout[shipping_address][…] prefilled. Documented at
 *    https://help.shopify.com/en/manual/products/details/cart-permalink
 *    Variant + live price + stock come from the public /products/{handle}.js.
 *  - Amazon: the official add-to-cart URL /gp/aws/cart/add.html?ASIN.1=…&Quantity.1=1
 *  - Anything else: the product page itself.
 */

const HST = 0.13;

type ShopifyVariant = { id: number; title: string; available: boolean; price: number; options?: string[]; public_title?: string | null };
type ShopifyProduct = { title: string; handle: string; variants: ShopifyVariant[] };

export type CartLink = {
  kind: "shopify_checkout" | "amazon_cart" | "product_page";
  url: string;
  /** Shown to the runner, e.g. "Size L, prefilled with your address". */
  note: string;
  /** Live item price when the store tells us (Shopify), in cents. */
  itemCents?: number;
  available?: boolean;
};

export function amazonAsin(url: string): string | null {
  const u = new URL(url);
  if (!/(^|\.)amazon\.(ca|com)$/i.test(u.hostname)) return null;
  return u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() ?? null;
}

function shopifyHandle(url: string): string | null {
  return new URL(url).pathname.match(/\/products\/([^/?#]+)/)?.[1] ?? null;
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean));

/**
 * Pick the variant: ?variant= in the wishlist URL wins; one variant is easy;
 * otherwise score variant titles against the item notes ("Size L, black").
 * Returns null when it's genuinely ambiguous.
 */
export function pickVariant(product: ShopifyProduct, productUrl: string, notes: string): ShopifyVariant | null {
  const fromUrl = Number(new URL(productUrl).searchParams.get("variant"));
  if (fromUrl) return product.variants.find((v) => v.id === fromUrl) ?? null;
  if (product.variants.length === 1) return product.variants[0];
  const want = tokens(notes.replace(/\b(size|colou?r|flavou?r)\s*:?/gi, " "));
  const scored = product.variants
    .map((v) => {
      const have = tokens([v.title, ...(v.options ?? [])].join(" "));
      return { v, score: [...have].filter((t) => want.has(t)).length };
    })
    .sort((a, b) => b.score - a.score || Number(b.v.available) - Number(a.v.available));
  if (!scored[0] || scored[0].score === 0) return null;
  if (scored[1] && scored[1].score === scored[0].score && scored[1].v.available === scored[0].v.available) return null;
  return scored[0].v;
}

const COUNTRY_NAMES: Record<string, string> = { CA: "Canada", US: "United States" };

export function shopifyPermalink(origin: string, variantId: number, buyer: Buyer): string {
  const [first, ...rest] = buyer.name.trim().split(/\s+/);
  const q = new URLSearchParams();
  if (buyer.email) q.set("checkout[email]", buyer.email);
  const addr: Record<string, string> = {
    first_name: first ?? "",
    last_name: rest.join(" "),
    address1: buyer.addressLine1,
    address2: buyer.addressLine2,
    city: buyer.city,
    province: buyer.province,
    country: COUNTRY_NAMES[buyer.country] ?? buyer.country,
    zip: buyer.postalCode,
  };
  for (const [k, v] of Object.entries(addr)) if (v) q.set(`checkout[shipping_address][${k}]`, v);
  const qs = q.toString();
  return `${origin}/cart/${variantId}:1${qs ? `?${qs}` : ""}`;
}

type Fetch = typeof fetch;

export async function buildCartLink(item: WishlistItem, buyer: Buyer, fetchImpl: Fetch = fetch): Promise<CartLink> {
  const asin = amazonAsin(item.productUrl);
  if (asin) {
    const host = new URL(item.productUrl).hostname.replace(/^(?!www\.)/, "www.");
    return {
      kind: "amazon_cart",
      url: `https://${host}/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1`,
      note: "Amazon's add-to-cart page: confirm the cart, then check out",
    };
  }

  const handle = shopifyHandle(item.productUrl);
  if (handle) {
    const origin = new URL(item.productUrl).origin;
    try {
      const res = await fetchImpl(`${origin}/products/${handle}.js`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.ok) {
        const product = (await res.json()) as ShopifyProduct;
        if (Array.isArray(product?.variants)) {
          const v = pickVariant(product, item.productUrl, item.notes);
          if (v) {
            return {
              kind: "shopify_checkout",
              url: shopifyPermalink(origin, v.id, buyer),
              note: `${v.title === "Default Title" ? product.title : `${product.title}: ${v.title}`}, address prefilled`,
              itemCents: v.price,
              available: v.available,
            };
          }
          return { kind: "product_page", url: item.productUrl, note: `Pick the option (${item.notes || "see notes"}), add to cart and check out` };
        }
      }
    } catch {
      // Not a Shopify store after all (or offline): fall through to the product page.
    }
  }
  return { kind: "product_page", url: item.productUrl, note: `Add to cart${item.notes ? ` (${item.notes})` : ""} and check out` };
}

/** Open a URL in the user's default browser (this app runs on their own machine). */
export function openInDefaultBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
}

type Run = { link: CartLink; status: CheckoutStatus };
const g = globalThis as unknown as { __runnyCartRuns?: Map<string, Run> };
const runs: Map<string, Run> = (g.__runnyCartRuns ??= new Map());

export type PurchaseConfirmation = { placed: boolean; totalCents?: number; orderNumber?: string };

export class CartLinkProvider implements CheckoutProvider {
  readonly name = "cart" as const;
  constructor(private readonly opts: { fetch?: Fetch; open?: (url: string) => void } = {}) {}

  async quote(item: WishlistItem, buyer: Buyer): Promise<Quote> {
    const link = await buildCartLink(item, buyer, this.opts.fetch);
    const itemCents = link.itemCents ?? item.expectedPriceCents;
    const taxCents = Math.round(itemCents * HST);
    return {
      itemCents,
      taxCents,
      shippingCents: 0,
      totalCents: itemCents + taxCents,
      currency: "CAD",
      exact: false,
      note: link.itemCents != null ? "Live store price + 13% HST estimate; shipping shown at checkout" : "Expected price + 13% HST estimate",
    };
  }

  async start(item: WishlistItem, buyer: Buyer, maxSpendCents: number) {
    const link = await buildCartLink(item, buyer, this.opts.fetch);
    if (link.available === false) throw new Error(`${item.title} is out of stock in that option`);
    const runId = `cart_${Date.now()}`;
    const steps = [
      { label: link.kind === "shopify_checkout" ? "Built the store's checkout link" : link.kind === "amazon_cart" ? "Built Amazon's add-to-cart link" : "Found the product page", at: new Date().toISOString() },
      { label: "Opened it in your browser", at: new Date().toISOString() },
    ];
    runs.set(runId, {
      link,
      status: {
        state: "awaiting_input",
        step: "Waiting for you to pay",
        steps,
        handoffUrl: link.url,
        needsInput: {
          requestId: runId,
          question: `Finish checking out in your browser (${link.note}). Keep the total under ${(maxSpendCents / 100).toFixed(2)} CAD.`,
        },
      },
    });
    (this.opts.open ?? openInDefaultBrowser)(link.url);
    return { runId };
  }

  async status(runId: string): Promise<CheckoutStatus> {
    return (
      runs.get(runId)?.status ?? {
        state: "awaiting_input",
        step: "Waiting for you to pay",
        needsInput: { requestId: runId, question: "The app restarted. If you placed the order, confirm it below." },
      }
    );
  }

  async respond(runId: string, input: unknown) {
    const c = input as PurchaseConfirmation;
    const run = runs.get(runId);
    const steps = [...(run?.status.steps ?? [])];
    const at = new Date().toISOString();
    if (!c?.placed) {
      runs.set(runId, { link: run?.link as CartLink, status: { state: "cancelled", step: "You didn't buy it", steps: [...steps, { label: "You didn't buy it", at }], failureReason: "Not purchased" } });
      return;
    }
    runs.set(runId, {
      link: run?.link as CartLink,
      status: {
        state: "completed",
        step: "Order placed",
        steps: [...steps, { label: "You placed the order", at }],
        totalCents: c.totalCents,
        currency: "CAD",
        merchantOrderId: c.orderNumber || undefined,
        receipt: {
          via: run?.link.kind ?? "cart",
          checkoutUrl: run?.link.url ?? null,
          orderId: c.orderNumber || null,
          totalCents: c.totalCents ?? null,
          currency: "CAD",
          confirmedBy: "you",
        },
      },
    });
  }

  async cancel(runId: string) {
    await this.respond(runId, { placed: false });
  }
}

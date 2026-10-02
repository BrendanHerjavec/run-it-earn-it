import { spawn } from "node:child_process";
import type { WishlistItem } from "@/db/schema";
import { linesLabel, linesTotalCents, type Buyer, type CheckoutLine, type CheckoutProvider, type CheckoutStatus, type Quote } from "./types";

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

/** Cart permalink for one or more variants: /cart/ID:QTY[,ID:QTY…] */
export function shopifyPermalink(origin: string, variants: number | { id: number; qty: number }[], buyer: Buyer): string {
  const list = typeof variants === "number" ? [{ id: variants, qty: 1 }] : variants;
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
  return `${origin}/cart/${list.map((v) => `${v.id}:${v.qty}`).join(",")}${qs ? `?${qs}` : ""}`;
}

type Fetch = typeof fetch;

type Resolved = { origin: string; variant: ShopifyVariant; product: ShopifyProduct } | { problem: string };

async function resolveShopify(item: WishlistItem, fetchImpl: Fetch): Promise<Resolved | null> {
  const handle = shopifyHandle(item.productUrl);
  if (!handle) return null;
  const origin = new URL(item.productUrl).origin;
  try {
    const res = await fetchImpl(`${origin}/products/${handle}.js`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    const product = (await res.json()) as ShopifyProduct;
    if (!Array.isArray(product?.variants)) return null;
    const variant = pickVariant(product, item.productUrl, item.notes);
    return variant ? { origin, variant, product } : { problem: `Pick the option for ${item.title} (${item.notes || "see notes"})` };
  } catch {
    // Not a Shopify store after all (or offline).
    return null;
  }
}

/**
 * The store's own cart link for an order of one or more lines. Several lines
 * become one cart (one Shopify permalink, or one Amazon add-to-cart page) when
 * they're all from the same store.
 */
export async function buildCartLink(lines: CheckoutLine[] | WishlistItem, buyer: Buyer, fetchImpl: Fetch = fetch): Promise<CartLink> {
  const list: CheckoutLine[] = Array.isArray(lines) ? lines : [{ item: lines, qty: 1 }];
  const first = list[0].item;
  const manual = (note: string): CartLink => ({ kind: "product_page", url: first.productUrl, note });

  const asins = list.map((l) => amazonAsin(l.item.productUrl));
  if (asins.every(Boolean)) {
    const host = new URL(first.productUrl).hostname.replace(/^(?!www.)/, "www.");
    const q = list.map((l, i) => `ASIN.${i + 1}=${asins[i]}&Quantity.${i + 1}=${l.qty}`).join("&");
    return { kind: "amazon_cart", url: `https://${host}/gp/aws/cart/add.html?${q}`, note: "Amazon's add-to-cart page: confirm the cart, then check out" };
  }

  const origins = new Set(list.map((l) => new URL(l.item.productUrl).origin));
  const resolved = origins.size === 1 ? await Promise.all(list.map((l) => resolveShopify(l.item, fetchImpl))) : [];
  if (resolved.length && resolved.every((r) => r && "variant" in r)) {
    const ok = resolved as Extract<Resolved, { variant: ShopifyVariant }>[];
    const names = ok.map(({ product, variant }, i) => {
      const name = variant.title === "Default Title" ? product.title : `${product.title}: ${variant.title}`;
      return list[i].qty > 1 ? `${list[i].qty} × ${name}` : name;
    });
    return {
      kind: "shopify_checkout",
      url: shopifyPermalink(ok[0].origin, ok.map((r, i) => ({ id: r.variant.id, qty: list[i].qty })), buyer),
      note: `${names.join(" + ")}, address prefilled`,
      itemCents: ok.reduce((sum, r, i) => sum + r.variant.price * list[i].qty, 0),
      available: ok.every((r) => r.variant.available),
    };
  }
  const problem = resolved.find((r): r is { problem: string } => !!r && "problem" in r);
  if (problem) return manual(`${problem.problem}, add to cart and check out`);
  if (list.length > 1) return manual(`Add these to one cart and check out: ${list.map((l) => l.item.title).join(", ")}`);
  return manual(`Add to cart${first.notes ? ` (${first.notes})` : ""} and check out`);
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

  async quote(lines: CheckoutLine[], buyer: Buyer): Promise<Quote> {
    const link = await buildCartLink(lines, buyer, this.opts.fetch);
    const itemCents = link.itemCents ?? linesTotalCents(lines);
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

  async start(lines: CheckoutLine[], buyer: Buyer, maxSpendCents: number) {
    const link = await buildCartLink(lines, buyer, this.opts.fetch);
    if (link.available === false) throw new Error(`Out of stock in that option: ${linesLabel(lines)}`);
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

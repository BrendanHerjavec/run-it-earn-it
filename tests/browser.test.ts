import { describe, expect, it, vi } from "vitest";
import type { WishlistItem } from "@/db/schema";
import { parseMoneyToCents, runBrowserCheckout } from "@/lib/browser/checkout-agent";
import { looksLikeCardNumber, onSameStore, pageShowsAmount, pageShowsPostalCode, PLACE_ORDER_RE, storeDomain } from "@/lib/browser/guards";
import type { BrowserMcp } from "@/lib/browser/session";
import type { Buyer, CheckoutStatus } from "@/lib/providers";
import { scriptedClaude, text, toolUse } from "./fake-claude";

describe("browser guardrails", () => {
  it("keeps the agent on the item's store", () => {
    expect(storeDomain("https://www.shop.example.ca/p/1")).toBe("example.ca");
    expect(storeDomain("https://store.example.co.uk/x")).toBe("example.co.uk");
    const item = "https://www.runners.ca/products/socks";
    expect(onSameStore("https://runners.ca/cart", item)).toBe(true);
    expect(onSameStore("https://checkout.runners.ca/pay", item)).toBe(true);
    expect(onSameStore("https://evil-runners.ca/", item)).toBe(false);
    expect(onSameStore("https://runners.ca.evil.com/", item)).toBe(false);
    expect(onSameStore("javascript:alert(1)", item)).toBe(false);
  });

  it("spots card numbers but not phone or order numbers", () => {
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("5555-5555-5555-4444")).toBe(true);
    expect(looksLikeCardNumber("416-555-0199")).toBe(false);
    expect(looksLikeCardNumber("M5V 2T6")).toBe(false);
  });

  it("matches money-committing buttons", () => {
    for (const b of ["Place order", "Place your order", "Buy now", "Pay now", "Complete purchase", "Submit order", "Pay $28.24"]) {
      expect(PLACE_ORDER_RE.test(b)).toBe(true);
    }
    for (const b of ["Add to cart", "Continue to shipping", "Checkout", "Apply"]) expect(PLACE_ORDER_RE.test(b)).toBe(false);
  });

  it("finds amounts and postal codes on the page", () => {
    expect(pageShowsAmount("Order total: $28.24 CAD", 28_24)).toBe(true);
    expect(pageShowsAmount("Total 28,24 $", 28_24)).toBe(true);
    expect(pageShowsAmount("Total $128.24", 28_24)).toBe(false);
    expect(pageShowsAmount("Total $1,028.24", 1028_24)).toBe(true);
    expect(pageShowsPostalCode("Ship to 123 King St, Toronto ON m5v2t6", "M5V 2T6")).toBe(true);
    expect(pageShowsPostalCode("Ship to Vancouver V6B 1A1", "M5V 2T6")).toBe(false);
    expect(parseMoneyToCents("CA$1,028.24")).toBe(1028_24);
    expect(parseMoneyToCents("28,24 $")).toBe(28_24);
  });
});

// ── The agent loop, against a fake browser ────────────────────────────────

const item = {
  id: 1,
  title: "Running socks",
  productUrl: "https://www.runners.ca/products/socks",
  expectedPriceCents: 24_99,
  tier: "medium",
  notes: "Size L",
  active: true,
} as WishlistItem;
const buyer: Buyer = { name: "Test Runner", email: "", phone: "", addressLine1: "1 King St", addressLine2: "", city: "Toronto", province: "ON", postalCode: "M5V 2T6", country: "CA" };

function fakeBrowser(pages: { review: string; confirmation?: string }) {
  let url = "about:blank";
  let placed = false;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp: BrowserMcp = {
    listTools: (async () => ({
      tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_run_code_unsafe"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" as const, properties: {} },
      })),
    })) as BrowserMcp["listTools"],
    callTool: (async ({ name, arguments: args = {} }: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push({ name, args });
      if (name === "browser_navigate") url = String(args.url);
      if (name === "browser_click" && /checkout/i.test(String(args.element))) url = "https://www.runners.ca/checkout/review";
      if (name === "browser_click" && /place order/i.test(String(args.element))) placed = true;
      const page = placed ? (pages.confirmation ?? "") : url.includes("review") ? pages.review : "Product page";
      return { content: [{ type: "text", text: `### Page\n- Page URL: ${url}\n### Snapshot\n${page}` }] };
    }) as BrowserMcp["callTool"],
  };
  return { mcp, calls, placed: () => placed };
}

const REVIEW = "Review your order\nShip to Test Runner, 1 King St, Toronto ON M5V 2T6\nSubtotal $24.99\nHST $3.25\nTotal $28.24 CAD\n[button] Place order";

function run(opts: { turns: ReturnType<typeof toolUse>[][]; dryRun: boolean; maxSpendCents?: number; review?: string; confirmation?: string }) {
  const browser = fakeBrowser({ review: opts.review ?? REVIEW, confirmation: opts.confirmation });
  const updates: CheckoutStatus[] = [];
  const result = runBrowserCheckout({
    mcp: browser.mcp,
    createMessage: scriptedClaude(opts.turns).createMessage,
    model: "test",
    lines: [{ item, qty: 1 }],
    buyer,
    maxSpendCents: opts.maxSpendCents ?? 35_00,
    dryRun: opts.dryRun,
    onUpdate: (st) => updates.push(st),
    waitForUser: vi.fn(async () => "done"),
    isCancelled: () => false,
  });
  return { browser, updates, result };
}

const toReview = [
  [toolUse("progress", { step: "Opening the product" }), toolUse("browser_navigate", { url: item.productUrl })],
  [toolUse("browser_click", { element: "Add to cart button", target: "e12" })],
  [toolUse("browser_click", { element: "Checkout button", target: "e20" })],
];

describe("browser checkout agent", () => {
  it("dry run: reaches the review page, verifies the total, and can never place the order", async () => {
    const { browser, result, updates } = run({
      dryRun: true,
      turns: [
        ...toReview,
        [toolUse("browser_click", { element: "Place order button", target: "e40" })],
        [toolUse("ready_to_place_order", { total: "$28.24", currency: "CAD", summary: "1 × socks, standard shipping" })],
      ],
    });
    const st = await result;
    expect(st).toMatchObject({ state: "completed", dryRun: true, totalCents: 28_24 });
    expect(browser.placed()).toBe(false);
    expect(browser.calls.some((c) => c.name === "browser_click" && /place order/i.test(String(c.args.element)))).toBe(false);
    expect(updates.map((u) => u.step)).toContain("Opening the product");
  });

  it("live: blocks place-order until the total is verified, allows exactly one click, then confirms", async () => {
    const { browser, result } = run({
      dryRun: false,
      confirmation: "Thank you! Your order #RN-1042 is confirmed.",
      turns: [
        ...toReview,
        [toolUse("browser_click", { element: "Place order button", target: "e40" })], // blocked: not verified
        [toolUse("ready_to_place_order", { total: "$28.24", currency: "CAD", summary: "socks" })],
        [toolUse("browser_click", { element: "Place order button", target: "e40" })], // allowed
        [toolUse("browser_click", { element: "Place order button", target: "e40" })], // blocked: already clicked
        [toolUse("order_placed", { order_number: "RN-1042" })],
      ],
    });
    const st = await result;
    expect(st).toMatchObject({ state: "completed", totalCents: 28_24, merchantOrderId: "RN-1042" });
    expect(st.dryRun).toBeUndefined();
    const placeClicks = browser.calls.filter((c) => c.name === "browser_click" && /place order/i.test(String(c.args.element)));
    expect(placeClicks).toHaveLength(1);
  });

  it("stops when the real total is over the hard cap", async () => {
    const { browser, result } = run({
      dryRun: false,
      maxSpendCents: 25_00,
      turns: [...toReview, [toolUse("ready_to_place_order", { total: "$28.24", currency: "CAD", summary: "socks" })]],
    });
    const st = await result;
    expect(st.state).toBe("failed");
    expect(st.failureReason).toMatch(/over the hard limit/);
    expect(browser.placed()).toBe(false);
  });

  it("rejects a total that isn't on the page, and a review page shipping somewhere else", async () => {
    const { result } = run({
      dryRun: false,
      review: REVIEW.replace("M5V 2T6", "V6B 1A1"),
      turns: [
        ...toReview,
        [toolUse("ready_to_place_order", { total: "$19.99", currency: "CAD", summary: "socks" })],
        [text("I can't verify, giving up.")],
      ],
    });
    const st = await result;
    expect(st.state).toBe("failed");
    // It was told why: wrong amount and wrong postal code.
    expect(st.failureReason).toMatch(/without finishing/);
  });

  it("blocks leaving the store, typing card numbers, and unlisted tools", async () => {
    const { browser, result } = run({
      dryRun: true,
      turns: [
        [toolUse("browser_navigate", { url: "https://evil.example.com/steal" })],
        [toolUse("browser_type", { element: "Card number", target: "e5", text: "4242 4242 4242 4242" })],
        [toolUse("browser_type", { element: "Notes field", target: "e6", text: "4242424242424242" })],
        [toolUse("browser_run_code_unsafe", { code: "async (page) => page.click('text=Place order')" })],
        [toolUse("stop", { reason: "done testing", needs_user: false })],
      ],
    });
    const st = await result;
    expect(st.state).toBe("failed");
    expect(browser.calls.filter((c) => c.name !== "browser_snapshot")).toEqual([]);
  });
});

describe("browser provider start", () => {
  const SHOPIFY = { title: "Sock", handle: "run-sock", variants: [{ id: 222, title: "L", available: true, price: 800 }] };
  const shopItem = { ...item, productUrl: "https://www.runners.ca/products/run-sock" } as WishlistItem;

  it("starts the agent on the store's checkout link (item in cart, address prefilled)", async () => {
    const { BrowserProvider } = await import("@/lib/providers/browser");
    const b = fakeBrowser({ review: REVIEW });
    const p = new BrowserProvider({
      dryRun: true,
      connect: async () => b.mcp,
      fetch: (async () => new Response(JSON.stringify(SHOPIFY))) as typeof fetch,
      createMessage: scriptedClaude([
        [toolUse("browser_navigate", { url: "https://www.runners.ca/cart/222:1" })],
        [toolUse("stop", { reason: "test", needs_user: false })],
      ]).createMessage,
    });
    const { runId } = await p.start([{ item: shopItem, qty: 1 }], buyer, 20_00);
    for (let i = 0; i < 50 && (await p.status(runId)).state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.calls[0]).toMatchObject({ name: "browser_navigate" });
    expect(String(b.calls[0].args.url)).toMatch(/^https:\/\/www\.runners\.ca\/cart\/222:1/);
  });

  it("refuses to drive Amazon", async () => {
    const { BrowserProvider } = await import("@/lib/providers/browser");
    const p = new BrowserProvider({ dryRun: true, connect: async () => fakeBrowser({ review: REVIEW }).mcp });
    await expect(p.start([{ item: { ...item, productUrl: "https://www.amazon.ca/dp/B0ABCDEF12" } as WishlistItem, qty: 1 }], buyer, 20_00)).rejects.toThrow(/Amazon/);
  });
});

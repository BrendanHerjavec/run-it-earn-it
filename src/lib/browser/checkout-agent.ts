import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { CreateMessage } from "../agent";
import { formatCad } from "../format";
import type { Buyer, CheckoutLine, CheckoutStatus, CheckoutStep } from "../providers/types";
import {
  CONFIRMATION_RE,
  looksLikeCardNumber,
  onSameStore,
  pageShowsAmount,
  pageShowsPostalCode,
  PLACE_ORDER_RE,
  SECRET_FIELD_RE,
  storeDomain,
} from "./guards";
import { pageUrlFrom, resultText, type BrowserMcp } from "./session";

/** Playwright MCP tools Claude may use. No code execution, uploads, or tab juggling. */
const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_handle_dialog",
]);

const CONTROL_TOOLS: Anthropic.Tool[] = [
  {
    name: "progress",
    description: "Tell the viewer what you're doing now, in a few words (e.g. 'Adding to cart'). Call at each new phase.",
    input_schema: { type: "object", properties: { step: { type: "string" } }, required: ["step"], additionalProperties: false },
  },
  {
    name: "ready_to_place_order",
    description:
      "Call on the final review page, BEFORE clicking the button that places the order. Report the order total exactly as the page shows it. The app verifies the page itself and replies whether you may place the order.",
    input_schema: {
      type: "object",
      properties: {
        total: { type: "string", description: "Order total including tax and shipping, as shown, e.g. '$28.24'" },
        currency: { type: "string", description: "Currency code, e.g. CAD" },
        summary: { type: "string", description: "One line: item, quantity, shipping method" },
      },
      required: ["total", "currency", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "order_placed",
    description: "Call once the order confirmation page is showing.",
    input_schema: {
      type: "object",
      properties: { order_number: { type: "string", description: "Order/confirmation number if shown, else empty" } },
      required: ["order_number"],
      additionalProperties: false,
    },
  },
  {
    name: "stop",
    description:
      "Stop the checkout. Set needs_user=true if a person must act in the browser window (sign in, verification code, captcha, entering a card); the runner can fix it and you'll continue.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" }, needs_user: { type: "boolean" } },
      required: ["reason", "needs_user"],
      additionalProperties: false,
    },
  },
];

function systemPrompt(lines: CheckoutLine[], buyer: Buyer, maxSpendCents: number, dryRun: boolean, startUrl: string) {
  const item = lines[0].item;
  const atCheckout = startUrl !== item.productUrl;
  const order = lines
    .map((l) => `- ${l.qty} × ${l.item.title} (${l.item.productUrl})${l.item.notes ? `, notes: ${l.item.notes}` : ""}`)
    .join("\n");
  return `You are a careful checkout agent operating the runner's own Chrome window, which is already signed in to the store with their address and card saved. Buy exactly this order, nothing more:

${order}
Product page: ${item.productUrl}${atCheckout ? `
You start on the store's own checkout link (${startUrl}): everything above is already in the cart and the shipping address is prefilled. Don't go back to the product page unless the checkout is broken.` : ""}
Check the cart matches the order list exactly (items and quantities).
Ship to: ${buyer.name}, ${buyer.city}, ${buyer.province} ${buyer.postalCode}, ${buyer.country} (use the saved address that matches)
Hard spending limit: ${formatCad(maxSpendCents)} total including tax and shipping.
${dryRun ? "\nThis is a DRY RUN: go all the way to the final review page and call ready_to_place_order, but you will not be allowed to place the order.\n" : ""}
How to work:
- Use browser_snapshot to read the page; click and type using the element refs it gives you. Take a fresh snapshot after anything that changes the page.
- Call progress at each phase (opening the product, choosing options, adding to cart, checkout, shipping, review).
- Stay on this store's website.
- Exactly the quantities listed. Pick the cheapest standard shipping (or free shipping if offered). Decline warranties, subscriptions, donations, tips and upsells. Don't apply random coupons.
- Use the saved address and saved payment method. Never type a password, card number, security code or verification code. If the store asks you to sign in, verify, solve a captcha or enter card details, call stop with needs_user=true.
- If the item is unavailable, the option in the notes doesn't exist, or the total would exceed the limit, call stop with needs_user=false and say why.
- On the final review page, call ready_to_place_order with the exact total. Only click the place-order button after it says you may, click it once, wait for the confirmation page, then call order_placed.`;
}

export type CheckoutRunOptions = {
  /** Where to begin: the store's cart/checkout link when we have one, else the product page. */
  startUrl?: string;
  mcp: BrowserMcp;
  createMessage: CreateMessage;
  model: string;
  lines: CheckoutLine[];
  buyer: Buyer;
  maxSpendCents: number;
  dryRun: boolean;
  onUpdate: (st: CheckoutStatus) => void;
  /** Resolves with the runner's note once they've handled a needs_user stop in the browser. */
  waitForUser: (question: string) => Promise<string>;
  isCancelled: () => boolean;
  maxTurns?: number;
};

const readySchema = z.object({ total: z.string(), currency: z.string(), summary: z.string() });

/** Parse "$1,028.24" / "28,24 $" / "CA$28.24" into cents. */
export function parseMoneyToCents(s: string): number | null {
  const m = s.replace(/ /g, " ").match(/(\d{1,3}(?:[ ,]\d{3})*|\d+)(?:[.,](\d{2}))?/);
  if (!m) return null;
  const whole = Number(m[1].replace(/[ ,]/g, ""));
  return whole * 100 + Number(m[2] ?? 0);
}

const MAX_RESULT_CHARS = 60_000;

/**
 * Drop the bodies of old, large tool results (page snapshots) so the context
 * doesn't grow with every page. The latest two stay intact.
 */
function trimOldResults(messages: Anthropic.MessageParam[]) {
  const userTurns = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "user" && Array.isArray(m.content));
  for (const { m } of userTurns.slice(0, -2)) {
    for (const b of m.content as Anthropic.ContentBlockParam[]) {
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 2000) {
        b.content = `${b.content.slice(0, 300)}\n…[older page snapshot omitted]`;
      }
    }
  }
}

export async function runBrowserCheckout(o: CheckoutRunOptions): Promise<CheckoutStatus> {
  const steps: CheckoutStep[] = [];
  let step = "Opening the browser";
  const push = (label: string) => {
    step = label;
    steps.push({ label, at: new Date().toISOString() });
    o.onUpdate({ state: "running", step, steps: [...steps] });
  };
  const finish = (st: CheckoutStatus): CheckoutStatus => {
    const final = { ...st, steps: [...steps, ...(st.step ? [{ label: st.step, at: new Date().toISOString() }] : [])] };
    o.onUpdate(final);
    return final;
  };
  push("Opening the browser");

  const { tools: mcpTools } = await o.mcp.listTools();
  const tools: Anthropic.Tool[] = [
    ...mcpTools
      .filter((t) => BROWSER_TOOLS.has(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
    ...CONTROL_TOOLS,
  ];

  let currentUrl: string | null = null;
  let verifiedCents: number | null = null; // set by a successful ready_to_place_order (live runs only)
  let placeOrderClicked = false;

  const snapshotText = async () => {
    const t = resultText(await o.mcp.callTool({ name: "browser_snapshot", arguments: {} }));
    currentUrl = pageUrlFrom(t) ?? currentUrl;
    return t;
  };

  /** Returns [content, isError, finalStatus?]. */
  async function handle(name: string, input: Record<string, unknown>): Promise<[string, boolean, CheckoutStatus?]> {
    switch (name) {
      case "progress":
        push(String(input.step ?? "").slice(0, 80) || step);
        return ["ok", false];

      case "stop": {
        const reason = String(input.reason ?? "stopped");
        if (input.needs_user) {
          o.onUpdate({ state: "awaiting_input", step: "Waiting for you in the browser", steps: [...steps], needsInput: { requestId: String(Date.now()), question: reason } });
          const note = await o.waitForUser(reason);
          push("Continuing after your help");
          return [`The runner says: "${note || "done"}". Take a fresh snapshot and continue.`, false];
        }
        return ["stopped", false, finish({ state: "failed", step: "Stopped", failureReason: reason })];
      }

      case "ready_to_place_order": {
        const r = readySchema.safeParse(input);
        if (!r.success) return ["Invalid input", true];
        const cents = parseMoneyToCents(r.data.total);
        const page = await snapshotText();
        const problems: string[] = [];
        if (cents == null) problems.push(`couldn't read an amount from "${r.data.total}"`);
        else {
          if (!pageShowsAmount(page, cents)) problems.push(`the page doesn't show ${r.data.total}; report the total exactly as displayed`);
          if (cents > o.maxSpendCents) problems.push(`total ${formatCad(cents)} is over the hard limit of ${formatCad(o.maxSpendCents)}`);
        }
        if (!/^CAD$/i.test(r.data.currency.trim())) problems.push(`currency must be CAD, got ${r.data.currency}`);
        if (!pageShowsPostalCode(page, o.buyer.postalCode)) problems.push(`the page doesn't show the shipping postal code ${o.buyer.postalCode}; make sure the saved home address is selected`);
        if (currentUrl && !onSameStore(currentUrl, o.lines[0].item.productUrl)) problems.push("the review page isn't on the store's website");
        if (problems.length) {
          if (cents != null && cents > o.maxSpendCents) {
            return [problems.join("; "), true, finish({ state: "failed", step: "Stopped: total over the limit", failureReason: problems.join("; ") })];
          }
          return [`Not verified: ${problems.join("; ")}.`, true];
        }
        push(`Order total verified: ${formatCad(cents!)}`);
        if (o.dryRun) {
          return [
            "Dry run complete; do not place the order.",
            false,
            finish({
              state: "completed",
              dryRun: true,
              step: "Dry run: stopped before placing the order",
              totalCents: cents!,
              currency: "CAD",
              receipt: { dryRun: true, merchant: storeDomain(o.lines[0].item.productUrl), totalCents: cents, currency: "CAD", summary: r.data.summary },
            }),
          ];
        }
        verifiedCents = cents!;
        return [`Verified ${formatCad(cents!)}. You may now click the place-order button once, then wait for confirmation and call order_placed.`, false];
      }

      case "order_placed": {
        if (!placeOrderClicked) return ["You haven't clicked the place-order button yet.", true];
        const page = await snapshotText();
        const orderNo = String(input.order_number ?? "").trim();
        if (!CONFIRMATION_RE.test(page) && !(orderNo && page.includes(orderNo))) {
          return ["This doesn't look like a confirmation page yet. Wait, take a snapshot, and try again.", true];
        }
        return [
          "Done.",
          false,
          finish({
            state: "completed",
            step: "Order confirmed",
            totalCents: verifiedCents ?? undefined,
            currency: "CAD",
            merchantOrderId: orderNo || undefined,
            receipt: { merchant: storeDomain(o.lines[0].item.productUrl), orderId: orderNo || null, totalCents: verifiedCents, currency: "CAD" },
          }),
        ];
      }
    }

    if (!BROWSER_TOOLS.has(name)) return [`Tool ${name} is not available`, true];

    // ── Guards on browser actions ──
    const element = String(input.element ?? "");
    const isPlaceOrder = PLACE_ORDER_RE.test(element);
    if (name === "browser_navigate") {
      const url = String(input.url ?? "");
      if (!onSameStore(url, o.lines[0].item.productUrl)) return [`Blocked: ${url} is not on ${storeDomain(o.lines[0].item.productUrl)}. Stay on the store.`, true];
    }
    if (name === "browser_type" || name === "browser_select_option") {
      const text = String(input.text ?? input.values ?? "");
      if (SECRET_FIELD_RE.test(element) || looksLikeCardNumber(text)) {
        return ["Blocked: never type passwords, card details or codes. Call stop with needs_user=true instead.", true];
      }
    }
    if (name === "browser_click" && isPlaceOrder) {
      if (o.dryRun) return ["Blocked: dry run. Call ready_to_place_order on the review page instead.", true];
      if (verifiedCents == null) return ["Blocked: call ready_to_place_order first so the total can be verified.", true];
      if (placeOrderClicked) return ["Blocked: the place-order button was already clicked once. Wait for confirmation.", true];
      placeOrderClicked = true;
    }
    if (name === "browser_press_key" && /enter/i.test(String(input.key ?? "")) && verifiedCents == null && currentUrl && /checkout|payment|review/i.test(currentUrl)) {
      return ["Blocked: don't press Enter on checkout pages; click the specific button instead.", true];
    }
    // Anything that could change the order after verification invalidates it.
    const readOnly = name === "browser_snapshot" || name === "browser_find" || name === "browser_wait_for";
    if (!readOnly && !placeOrderClicked) verifiedCents = null;

    const res = await o.mcp.callTool({ name, arguments: input });
    const text = resultText(res).slice(0, MAX_RESULT_CHARS);
    currentUrl = pageUrlFrom(text) ?? currentUrl;
    if (name === "browser_navigate" && currentUrl) push(`Opened ${new URL(currentUrl).hostname}`);
    return [text || "ok", !!(res as { isError?: boolean }).isError];
  }

  const startUrl = o.startUrl ?? o.lines[0].item.productUrl;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Start by opening ${startUrl}` }];
  const maxTurns = o.maxTurns ?? 60;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (o.isCancelled()) return finish({ state: "cancelled", step: "Cancelled", failureReason: "Cancelled by you" });
      trimOldResults(messages);
      const res = await o.createMessage({
        model: o.model,
        max_tokens: 8000,
        system: systemPrompt(o.lines, o.buyer, o.maxSpendCents, o.dryRun, startUrl),
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "refusal") return finish({ state: "failed", step: "Stopped", failureReason: "The model declined to continue" });
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        const said = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
        return finish({ state: "failed", step: "Stopped", failureReason: `Agent stopped without finishing${said ? `: ${said.slice(0, 300)}` : ""}` });
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      let final: CheckoutStatus | undefined;
      for (const u of uses) {
        if (final) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: "Skipped: checkout already finished.", is_error: true });
          continue;
        }
        const [content, isError, done] = await handle(u.name, (u.input ?? {}) as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: u.id, content, ...(isError ? { is_error: true } : {}) });
        final = done;
      }
      messages.push({ role: "user", content: results });
      if (final) return final;
    }
    return finish({ state: "failed", step: "Stopped", failureReason: `Gave up after ${maxTurns} steps` });
  } catch (err) {
    const reason = err instanceof Anthropic.APIError ? `Claude API error ${err.status}: ${err.message}` : String(err);
    return finish({ state: "failed", step: "Stopped", failureReason: reason });
  }
}

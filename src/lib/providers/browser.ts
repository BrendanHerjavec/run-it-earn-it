import Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "../agent";
import { runBrowserCheckout } from "../browser/checkout-agent";
import { getBrowser, type BrowserMcp } from "../browser/session";
import { amazonAsin, buildCartLink } from "./cart";
import { anthropicClient } from "../anthropic";
import { config } from "../config";
import { linesLabel, linesTotalCents, type Buyer, type CheckoutLine, type CheckoutProvider, type CheckoutStatus, type Quote } from "./types";

type Run = {
  status: CheckoutStatus;
  cancelled: boolean;
  resume?: (note: string) => void;
};

// Runs live in this Node process: this provider is for the app running on your own machine.
const g = globalThis as unknown as { __runnyBrowserRuns?: Map<string, Run> };
const runs: Map<string, Run> = (g.__runnyBrowserRuns ??= new Map());

const HST = 0.13;

export type BrowserProviderOptions = {
  dryRun: boolean;
  connect?: () => Promise<BrowserMcp>;
  fetch?: typeof fetch;
  createMessage?: CreateMessage;
};

/**
 * Checkout by a Claude agent driving a real, visible Chrome window on this
 * machine (Playwright MCP), signed in to the store with the card saved there.
 * In dry-run mode it stops at the review page and can never place the order.
 */
export class BrowserProvider implements CheckoutProvider {
  readonly name = "browser" as const;
  constructor(private readonly opts: BrowserProviderOptions) {}

  /** A browser can't know tax and shipping until checkout; estimate with 13% HST. */
  async quote(lines: CheckoutLine[]): Promise<Quote> {
    const itemCents = linesTotalCents(lines);
    const taxCents = Math.round(itemCents * HST);
    return {
      itemCents,
      taxCents,
      shippingCents: 0,
      totalCents: itemCents + taxCents,
      currency: "CAD",
      exact: false,
      note: "Estimate: expected price + 13% HST; the agent reads the real total at checkout",
    };
  }

  async start(lines: CheckoutLine[], buyer: Buyer, maxSpendCents: number) {
    const item = lines[0].item;
    for (const r of runs.values()) {
      if (r.status.state === "running" || r.status.state === "awaiting_input") throw new Error("Another browser checkout is already running");
    }
    // Amazon's terms forbid shopping agents; never drive it (cart links still work).
    if (lines.some((l) => amazonAsin(l.item.productUrl))) throw new Error("Amazon doesn't allow shopping agents. Use the cart-link checkout for Amazon items.");
    // Start from the store's own checkout link when it has one (Shopify): the agent
    // then only walks the checkout instead of navigating product pages.
    const link = await buildCartLink(lines, buyer, this.opts.fetch);
    if (link.available === false) throw new Error(`Out of stock in that option: ${linesLabel(lines)}`);
    const startUrl = link.kind === "shopify_checkout" ? link.url : item.productUrl;
    const runId = `browser_${Date.now()}`;
    const run: Run = { status: { state: "running", step: "Starting", steps: [] }, cancelled: false };
    runs.set(runId, run);

    const createMessage =
      this.opts.createMessage ??
      (() => {
        const client = anthropicClient();
        return (p: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(p);
      })();

    // Fire and forget: progress is read back through status().
    void (async () => {
      try {
        const mcp = await (this.opts.connect ?? getBrowser)();
        run.status = await runBrowserCheckout({
          mcp,
          createMessage,
          model: config().BROWSER_AGENT_MODEL,
          lines,
          startUrl,
          buyer,
          maxSpendCents,
          dryRun: this.opts.dryRun,
          onUpdate: (st) => {
            run.status = st;
          },
          waitForUser: () => new Promise<string>((resolve) => (run.resume = resolve)),
          isCancelled: () => run.cancelled,
        });
      } catch (err) {
        run.status = { ...run.status, state: "failed", step: "Stopped", failureReason: `Browser checkout crashed: ${String(err)}` };
      }
    })();

    return { runId };
  }

  async status(runId: string): Promise<CheckoutStatus> {
    return (
      runs.get(runId)?.status ?? {
        state: "failed",
        step: "Lost",
        failureReason: "The app restarted during this checkout. Check the browser and your email for an order confirmation.",
      }
    );
  }

  async respond(runId: string, input: unknown) {
    const run = runs.get(runId);
    if (!run?.resume) throw new Error("This checkout isn't waiting for you");
    const resume = run.resume;
    run.resume = undefined;
    run.status = { ...run.status, state: "running", needsInput: undefined };
    resume(typeof input === "string" ? input : "done");
  }

  async cancel(runId: string) {
    const run = runs.get(runId);
    if (!run) return;
    run.cancelled = true;
    run.resume?.("The runner cancelled the checkout. Call stop.");
  }
}

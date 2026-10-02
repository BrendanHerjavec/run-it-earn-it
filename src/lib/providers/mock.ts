import { linesTotalCents, type Buyer, type CheckoutLine, type CheckoutProvider, type CheckoutStatus, type Quote } from "./types";

/** Ontario HST. The mock quotes like a Canadian store with free shipping. */
const HST = 0.13;

const STEPS = [
  "Opening the product page",
  "Checking price and availability",
  "Adding to cart",
  "Entering shipping address",
  "Choosing the cheapest shipping",
  "Reviewing order total against the cap",
  "Authorizing payment",
  "Placing the order",
];

/**
 * Simulates a 20–40 s checkout with no network and no money. It is stateless:
 * everything is encoded in the run ID and derived from the clock, so it
 * survives serverless restarts and works from any instance.
 *
 * runId = mock_<startMs>_<durationMs>_<itemCents>_<capCents>
 */
export class MockProvider implements CheckoutProvider {
  readonly name = "mock" as const;
  constructor(private readonly now: () => number = Date.now) {}

  async quote(lines: CheckoutLine[]): Promise<Quote> {
    const itemCents = linesTotalCents(lines);
    const taxCents = Math.round(itemCents * HST);
    return {
      itemCents,
      taxCents,
      shippingCents: 0,
      totalCents: itemCents + taxCents,
      currency: "CAD",
      exact: true,
      note: "Mock quote: 13% HST, free shipping",
    };
  }

  async start(lines: CheckoutLine[], _buyer: Buyer, maxSpendCents: number) {
    const start = this.now();
    const duration = 20_000 + Math.floor(Math.random() * 20_000);
    return { runId: `mock_${start}_${duration}_${linesTotalCents(lines)}_${maxSpendCents}` };
  }

  async status(runId: string): Promise<CheckoutStatus> {
    const [, startS, durS, itemS, capS] = runId.split("_");
    const start = Number(startS);
    const duration = Number(durS);
    const itemCents = Number(itemS);
    const cap = Number(capS);
    const elapsed = this.now() - start;
    const stepMs = duration / STEPS.length;
    const reached = Math.min(STEPS.length, Math.floor(elapsed / stepMs) + 1);
    const steps = STEPS.slice(0, reached).map((label, i) => ({ label, at: new Date(start + i * stepMs).toISOString() }));

    const totalCents = itemCents + Math.round(itemCents * HST);
    if (totalCents > cap && reached >= 6) {
      return {
        state: "failed",
        steps: steps.slice(0, 6),
        step: "Stopped: total over the cap",
        failureReason: `Order total ${(totalCents / 100).toFixed(2)} CAD exceeds the ${(cap / 100).toFixed(2)} CAD cap`,
      };
    }
    if (elapsed < duration) return { state: "running", steps, step: STEPS[reached - 1] };

    const orderId = `MOCK-${start.toString(36).toUpperCase()}`;
    return {
      state: "completed",
      steps: [...steps, { label: "Order confirmed", at: new Date(start + duration).toISOString() }],
      step: "Order confirmed",
      totalCents,
      currency: "CAD",
      merchantOrderId: orderId,
      receipt: {
        merchant: "Mock Running Co. (simulated)",
        orderId,
        subtotalCents: itemCents,
        taxCents: totalCents - itemCents,
        shippingCents: 0,
        totalCents,
        currency: "CAD",
        simulated: true,
      },
    };
  }

  /** Nothing to stop: the caller marks the reward cancelled and stops polling. */
  async cancel(): Promise<void> {}
}

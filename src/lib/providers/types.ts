import type { WishlistItem } from "@/db/schema";

export type ProviderName = "mock" | "crossmint" | "rye";

export type Buyer = {
  name: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  /** ISO 3166-2 subdivision without the country prefix, e.g. "ON". */
  province: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "CA". */
  country: string;
};

export type Quote = {
  itemCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  /** False when the provider can only estimate (e.g. a browser agent that prices at checkout). */
  exact: boolean;
  note?: string;
};

export type CheckoutStep = { label: string; at: string };

export type CheckoutStatus = {
  state: "running" | "awaiting_input" | "completed" | "failed" | "cancelled";
  /** Human-readable current step for the live timeline. */
  step?: string;
  steps?: CheckoutStep[];
  /** Present while state === "awaiting_input". */
  needsInput?: { requestId: string; question: string; schema?: unknown };
  totalCents?: number;
  currency?: string;
  merchantOrderId?: string;
  receipt?: unknown;
  failureReason?: string;
  liveViewUrl?: string;
};

export const TERMINAL: CheckoutStatus["state"][] = ["completed", "failed", "cancelled"];

export interface CheckoutProvider {
  name: ProviderName;
  /** Price including tax and shipping when the provider can know it. */
  quote(item: WishlistItem, buyer: Buyer): Promise<Quote>;
  /** Begin a checkout that must never charge more than maxSpendCents. */
  start(item: WishlistItem, buyer: Buyer, maxSpendCents: number): Promise<{ runId: string; liveViewUrl?: string }>;
  status(runId: string): Promise<CheckoutStatus>;
  /** Answer a provider question (size, verification code, payment authorization). */
  respond?(runId: string, input: unknown): Promise<void>;
  cancel(runId: string): Promise<void>;
}

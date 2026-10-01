import type { User } from "@/db/schema";
import type { EffectiveSettings } from "../settings";
import { BrowserProvider } from "./browser";
import { CartLinkProvider } from "./cart";
import { MockProvider } from "./mock";
import type { Buyer, CheckoutProvider, ProviderName } from "./types";

export * from "./types";
export { BrowserProvider, CartLinkProvider, MockProvider };

class NotYetImplemented implements CheckoutProvider {
  constructor(readonly name: ProviderName) {}
  private fail(): never {
    throw new Error(`${this.name} provider is not implemented yet (Phase 4)`);
  }
  quote() {
    return this.fail();
  }
  start() {
    return this.fail();
  }
  status() {
    return this.fail();
  }
  cancel() {
    return this.fail();
  }
}

/*
 * Food delivery (Uber Eats, DoorDash) is deliberately absent: neither offers a
 * consumer ordering API, so there is nothing to integrate against. A possible
 * v2 is a Crossmint browser profile signed in to your own delivery account,
 * driven by Agent Checkouts. Decide that later.
 */

let mockSingleton: MockProvider | null = null;

/**
 * "cart" never spends money by itself (you click Pay in your own browser), so
 * it's allowed whatever the kill switch says. Otherwise, unless PURCHASES_ENABLED is true:
 *  - "browser" runs as a DRY RUN: the agent goes to the review page and is
 *    blocked (in code) from clicking place-order;
 *  - every other provider is replaced by the mock.
 */
export function getProvider(settings: Pick<EffectiveSettings, "provider" | "purchasesEnabled">): CheckoutProvider {
  if (settings.provider === "cart") return new CartLinkProvider();
  if (settings.provider === "browser") return new BrowserProvider({ dryRun: !settings.purchasesEnabled });
  if (!settings.purchasesEnabled || settings.provider === "mock") return (mockSingleton ??= new MockProvider());
  return new NotYetImplemented(settings.provider);
}

/** Resolve a provider by the name stored on a reward (so an in-flight checkout keeps its provider). */
export function providerByName(name: string, settings: Pick<EffectiveSettings, "purchasesEnabled">): CheckoutProvider {
  if (name === "mock") return (mockSingleton ??= new MockProvider());
  if (name === "cart") return new CartLinkProvider();
  if (name === "browser") return new BrowserProvider({ dryRun: !settings.purchasesEnabled });
  if (!settings.purchasesEnabled) throw new Error(`Refusing to call ${name}: PURCHASES_ENABLED is false`);
  return new NotYetImplemented(name as ProviderName);
}

export function buyerFromUser(u: User): Buyer {
  return {
    name: u.name,
    email: u.email,
    phone: u.phone,
    addressLine1: u.addressLine1,
    addressLine2: u.addressLine2,
    city: u.city,
    province: u.province,
    postalCode: u.postalCode,
    country: u.country,
  };
}

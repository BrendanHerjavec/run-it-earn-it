import type { User } from "@/db/schema";
import type { EffectiveSettings } from "../settings";
import { MockProvider } from "./mock";
import type { Buyer, CheckoutProvider, ProviderName } from "./types";

export * from "./types";
export { MockProvider };

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
 * The kill switch lives here: unless PURCHASES_ENABLED is true, every caller
 * gets the mock provider, whatever the settings say.
 */
export function getProvider(settings: Pick<EffectiveSettings, "provider" | "purchasesEnabled">): CheckoutProvider {
  if (!settings.purchasesEnabled || settings.provider === "mock") return (mockSingleton ??= new MockProvider());
  return new NotYetImplemented(settings.provider);
}

/** Resolve a provider by the name stored on a reward (so an in-flight checkout keeps its provider). */
export function providerByName(name: string, settings: Pick<EffectiveSettings, "purchasesEnabled">): CheckoutProvider {
  if (name === "mock") return (mockSingleton ??= new MockProvider());
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

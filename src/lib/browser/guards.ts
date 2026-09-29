/**
 * Code-level guardrails for the browser checkout agent. These run on every
 * tool call Claude makes; the prompt asks for the same behaviour, but these
 * are what actually enforce it.
 */

/** Hostname without "www.", reduced to the registrable part (shop.example.ca → example.ca). */
export function storeDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  // Two-part public suffixes (co.uk, com.au, …) keep three labels.
  const twoPartSuffix = /^(co|com|net|org|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPartSuffix ? -3 : -2).join(".");
}

/** Is `url` on the same store as the wishlist item (including its subdomains)? */
export function onSameStore(url: string, productUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const base = storeDomain(productUrl);
    const host = u.hostname.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/** Buttons that commit money. Blocked until the order total has been verified. */
export const PLACE_ORDER_RE =
  /place (your |my )?order|complete (your |my )?(order|purchase)|buy now|pay now|submit (your )?order|confirm (and pay|order|purchase)|purchase now|order now|pay \$|pay with/i;

/** Fields the agent must never type into. */
export const SECRET_FIELD_RE = /password|passcode|card ?number|credit card|debit card|\bcvv\b|\bcvc\b|security code|expir|\bpin\b|one-time code|verification code/i;

/** Digits in a card-number shape that also pass the Luhn check. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** Does the page text show this amount (e.g. 2824 → "28.24", "$28.24", "28,24 $")? */
export function pageShowsAmount(pageText: string, cents: number): boolean {
  const dollars = Math.floor(cents / 100);
  const c = String(cents % 100).padStart(2, "0");
  const withCommas = dollars.toLocaleString("en-US");
  const candidates = [`${dollars}.${c}`, `${withCommas}.${c}`, `${dollars},${c}`, `${dollars.toLocaleString("fr-CA")},${c}`];
  const text = pageText.replace(/ | /g, " ");
  return candidates.some((s) => new RegExp(`(^|[^\\d.,])${s.replace(/[.,]/g, "\\$&")}(?![\\d])`).test(text));
}

/** Does the page show the buyer's postal code (spacing and case ignored)? */
export function pageShowsPostalCode(pageText: string, postalCode: string): boolean {
  const want = postalCode.replace(/\s+/g, "").toUpperCase();
  if (!want) return false;
  return pageText.replace(/\s+/g, "").toUpperCase().includes(want);
}

/** Words that show up on an order confirmation page. */
export const CONFIRMATION_RE = /thank you|order (is )?(confirmed|placed|received|complete)|confirmation (number|#)|order (number|#|no\.?)/i;

/** Headroom above the quote for price changes at checkout, still bounded by the caps. */
export const QUOTE_BUFFER = 1.1;
/** Estimated quotes (shipping unknown until checkout) get more room. */
export const ESTIMATE_BUFFER = 1.25;

/** A spending cap stopped the checkout before any money could move. */
export class CapError extends Error {}

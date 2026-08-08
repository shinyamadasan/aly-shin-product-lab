// One rule for what a peso price LOOKS LIKE, shared by everything that shows a price and by the
// server-side check that asks whether the customer is still looking at the same one.
//
// Why this file exists. F2 first compared prices with `Math.round(value * 100)`, described as
// "centavo precision". Adversarial review measured it against the app's actual formatter and found
// they disagree:
//
//     1.005  ->  displays "1.01"  but  Math.round(1.005 * 100) === 100   (1.005 * 100 is
//     8.165  ->  displays "8.17"  but  Math.round(8.165 * 100) === 816    100.49999999999999)
//
// That gap is reachable in the direction that matters: a catalog price moving 1.005 -> 1.004
// changes what the customer sees (₱1.01 -> ₱1.00) while both map to the same 100 centavos, so the
// consent check would wave through a price change the customer could plainly see. Any arithmetic
// re-derivation of "what two decimal places would show" is an approximation of the formatter; the
// only thing guaranteed to agree with the formatter is the formatter.
//
// So the comparison is defined in terms of the displayed string. If two prices render identically
// the customer cannot tell them apart and the order proceeds; if they render differently, consent
// is broken and the submission is refused.
//
// This is a display and consent rule. It is NOT a money model: the persisted price is always the
// authoritative catalog number, never a formatted or rounded one.

const PESO_LOCALE = "en-PH";
const PESO_DIGITS = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

// The customer-visible representation of a price, without the currency symbol.
export function toDisplayPrice(value: number): string {
  return value.toLocaleString(PESO_LOCALE, PESO_DIGITS);
}

// True when two prices are indistinguishable to a customer reading them.
export function isSameDisplayedPrice(a: number, b: number): boolean {
  return toDisplayPrice(a) === toDisplayPrice(b);
}

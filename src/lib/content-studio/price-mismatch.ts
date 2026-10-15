export type PlannedCopy = {
  caption: string;
  platformVariants: readonly { platform: string; caption: string }[];
};

export type PriceMismatch = { source: string; amount: number };

// Explicit PHP amounts only. No inference from bare numbers, and no changes to the copy.
export function findPriceMismatches(copy: PlannedCopy, confirmedPrice: number): PriceMismatch[] {
  if (!Number.isFinite(confirmedPrice) || confirmedPrice <= 0) return [];
  const captions = [
    { source: "Caption", caption: copy.caption },
    ...copy.platformVariants.map((variant) => ({ source: `${variant.platform} caption`, caption: variant.caption })),
  ];
  const mismatches: PriceMismatch[] = [];
  // Whole amounts, grouped thousands and centavos. Reject partial matches of malformed numbers.
  const amount = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?(?!\\d|[.,]\\d)";
  const amountPattern = new RegExp(`(?:₱|\\bPHP|\\bP(?=\\s*\\d))\\s*(${amount})|(?<![\\d,.])\\b(${amount})\\s*(?:PHP\\b|pesos?\\b)`, "gi");
  for (const { source, caption } of captions) {
    for (const match of caption.matchAll(amountPattern)) {
      const amount = Number((match[1] ?? match[2]).replaceAll(",", ""));
      if (Math.round(amount * 100) !== Math.round(confirmedPrice * 100)) mismatches.push({ source, amount });
    }
  }
  return mismatches;
}

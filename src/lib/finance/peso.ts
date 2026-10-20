// Exact peso arithmetic for the financial report.
//
// Every peso amount this app STORES is a whole-centavo figure: order_lines.unit_price, orders.
// paid_amount, supply_entries.total_cost and business_expenses.amount. Summing those as JavaScript
// doubles drifts (0.1 + 0.2 !== 0.3), and applyPaymentReceived freezes paid_amount from a double sum
// of line totals, so a stored value can arrive as 0.30000000000000004. So the report sums such
// amounts as INTEGER CENTAVOS: converting to centavos only snaps float noise back to the stored
// figure, it never discards information, and integer addition is exact.
//
// The one amount that is NOT whole centavos is ingredient COGS (quantity x a per-piece cost carried
// at full precision). It is summed as the database delivers it and rounded exactly once, when a
// reported figure is produced -- never per order, never per piece.

export function toCentavos(pesos: number): number {
  return Math.round(pesos * 100);
}

export function fromCentavos(centavos: number): number {
  return centavos / 100;
}

// The single rounding point for a reported peso figure.
export function roundToCentavo(pesos: number): number {
  return Math.round(pesos * 100) / 100;
}

// Parses what a person types into an amount field: "1500", "1,500.50", "₱ 1 500.5". Returns null
// for anything that is not a positive amount with at most two decimals -- never a rounded guess.
export function parsePesoAmount(text: string): number | null {
  const cleaned = text.replace(/[₱,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return value > 0 ? value : null;
}

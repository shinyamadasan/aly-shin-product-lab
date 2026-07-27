export type InventoryTab = "stock" | "purchases" | "need-to-buy" | "history" | "ingredients";

export const inventoryTabs: Array<{ key: InventoryTab; label: string }> = [
  { key: "stock", label: "Current Stock" },
  { key: "purchases", label: "Purchases" },
  { key: "need-to-buy", label: "Need to Buy" },
  { key: "history", label: "History" },
  { key: "ingredients", label: "Items" },
];

const validInventoryTabs = new Set<string>(inventoryTabs.map((tab) => tab.key));

export const defaultInventoryTab: InventoryTab = "stock";

// Accepts whatever a Next.js searchParams value can be (string, string[], or missing) so the
// server page can hand this the raw "tab" entry without pre-validating it itself.
export function resolveInventoryTab(value: string | string[] | undefined): InventoryTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && validInventoryTabs.has(raw) ? (raw as InventoryTab) : defaultInventoryTab;
}

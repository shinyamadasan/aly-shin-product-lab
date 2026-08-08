import type { AiReviewRecord, BatchPhoto, BrandProfile, ContentDraft, ContentJournalEntry, CostingEntry, CostingSummary, EquipmentEntry, Ingredient, IngredientAlias, InventoryTransaction, Product, ProductBatch, PurchaseImport, PurchaseImportRow, SellingFormat, SellingFormatPackagingLine, SupplyEntry, TastingFeedback } from "./product-lab-types";

export type LabView =
  | "today"
  | "dashboard"
  | "products"
  | "product-detail"
  | "proof-day"
  | "batches"
  | "costing"
  | "orders"
  | "equipment"
  | "inventory"
  | "bake"
  | "journal"
  | "opportunities"
  | "admin"
  | "launch"
  | "content-studio"
  | "guide"
  | "brand";

export const navItems: Array<{ label: string; href: string; view: LabView }> = [
  { label: "Today", href: "/", view: "today" },
  { label: "Dashboard", href: "/dashboard", view: "dashboard" },
  { label: "Products", href: "/products", view: "products" },
  { label: "Product Detail", href: "/product-detail", view: "product-detail" },
  { label: "Proof Day", href: "/proof-day", view: "proof-day" },
  { label: "Proof Batches", href: "/batches", view: "batches" },
  { label: "Costing", href: "/costing", view: "costing" },
  { label: "Orders", href: "/orders", view: "orders" },
  { label: "Equipment", href: "/equipment", view: "equipment" },
  { label: "Inventory", href: "/inventory", view: "inventory" },
  { label: "Journey", href: "/journal", view: "journal" },
  { label: "Opportunities", href: "/opportunities", view: "opportunities" },
  { label: "Product Admin", href: "/admin", view: "admin" },
  { label: "Launch Offer", href: "/launch", view: "launch" },
  { label: "Brand Foundation", href: "/brand", view: "brand" },
  { label: "Content Studio", href: "/content-studio", view: "content-studio" },
  { label: "How To Use", href: "/guide", view: "guide" },
];

export const storageKey = "aly-shin-product-lab-v1";

export type LabState = {
  brandProfile: BrandProfile | null;
  products: Product[];
  batches: ProductBatch[];
  batchPhotos: BatchPhoto[];
  costingEntries: CostingEntry[];
  costings: CostingSummary[];
  sellingFormats: SellingFormat[];
  sellingFormatPackagingLines: SellingFormatPackagingLine[];
  supplies: SupplyEntry[];
  equipment: EquipmentEntry[];
  ingredients: Ingredient[];
  ingredientAliases: IngredientAlias[];
  purchaseImports: PurchaseImport[];
  purchaseImportRows: PurchaseImportRow[];
  inventoryTransactions: InventoryTransaction[];
  tastings: TastingFeedback[];
  journal: ContentJournalEntry[];
  contentDrafts: ContentDraft[];
  aiReviews: AiReviewRecord[];
};

export const emptyState: LabState = {
  brandProfile: null,
  products: [],
  batches: [],
  batchPhotos: [],
  costingEntries: [],
  costings: [],
  sellingFormats: [],
  sellingFormatPackagingLines: [],
  supplies: [],
  equipment: [],
  ingredients: [],
  ingredientAliases: [],
  purchaseImports: [],
  purchaseImportRows: [],
  inventoryTransactions: [],
  tastings: [],
  journal: [],
  contentDrafts: [],
  aiReviews: [],
};

// Evaluated at call time, not once at module load: a computed-at-import constant goes stale in a
// tab left open overnight, defaulting new batch/journal/supply forms to yesterday's date.
export function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

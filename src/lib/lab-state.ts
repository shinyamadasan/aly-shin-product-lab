import type { AiReviewRecord, BatchPhoto, BrandProfile, ContentDraft, ContentJournalEntry, CostingEntry, CostingSummary, EquipmentEntry, FinishedStockMovement, Ingredient, IngredientAlias, InventoryTransaction, Product, ProductBatch, ProductionExecution, PurchaseImport, PurchaseImportRow, SellingFormat, SellingFormatPackagingLine, SupplyEntry, TastingFeedback } from "./product-lab-types";

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
  | "brand"
  // Registered so AppShell can type and title the /context route. Listed in navItems below since
  // Runtime v1 passed live validation -- it is a normal internal surface now, not an experiment.
  | "context";

// Navigation is information hierarchy only: every page keeps its own route, and the group decides
// where its link sits. Array order IS display order within a group, and Dashboard (the home page,
// at "/") leads the first group. Today is the content-creation feature and lives at /today.
export type NavGroup = "operations" | "marketing" | "more";

export const navGroups: Array<{ id: NavGroup; label: string }> = [
  { id: "operations", label: "Operations" },
  { id: "marketing", label: "Marketing" },
  { id: "more", label: "More" },
];

export const navItems: Array<{ label: string; href: string; view: LabView; group: NavGroup }> = [
  { label: "Dashboard", href: "/", view: "dashboard", group: "operations" },
  { label: "Orders", href: "/orders", view: "orders", group: "operations" },
  { label: "Inventory", href: "/inventory", view: "inventory", group: "operations" },
  { label: "Bake", href: "/bake", view: "bake", group: "operations" },
  { label: "Products", href: "/products", view: "products", group: "operations" },
  { label: "Today", href: "/today", view: "today", group: "marketing" },
  { label: "Content Studio", href: "/content-studio", view: "content-studio", group: "marketing" },
  { label: "Journey", href: "/journal", view: "journal", group: "marketing" },
  { label: "Opportunities", href: "/opportunities", view: "opportunities", group: "marketing" },
  { label: "Proof Day", href: "/proof-day", view: "proof-day", group: "more" },
  { label: "Proof Batches", href: "/batches", view: "batches", group: "more" },
  { label: "Costing", href: "/costing", view: "costing", group: "more" },
  { label: "Equipment", href: "/equipment", view: "equipment", group: "more" },
  { label: "Product Detail", href: "/product-detail", view: "product-detail", group: "more" },
  { label: "Product Admin", href: "/admin", view: "admin", group: "more" },
  { label: "Launch Offer", href: "/launch", view: "launch", group: "more" },
  { label: "Brand Foundation", href: "/brand", view: "brand", group: "more" },
  { label: "Business Context", href: "/context", view: "context", group: "more" },
  { label: "How To Use", href: "/guide", view: "guide", group: "more" },
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
  productionExecutions: ProductionExecution[];
  finishedStockMovements: FinishedStockMovement[];
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
  productionExecutions: [],
  finishedStockMovements: [],
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

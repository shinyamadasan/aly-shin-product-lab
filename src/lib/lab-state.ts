import type { BatchPhoto, ContentJournalEntry, CostingEntry, CostingSummary, EquipmentEntry, ProductBatch, SupplyEntry, TastingFeedback } from "./product-lab-types";

export type LabView =
  | "dashboard"
  | "products"
  | "product-detail"
  | "proof-day"
  | "batches"
  | "costing"
  | "supplies"
  | "equipment"
  | "journal"
  | "admin"
  | "launch"
  | "content-studio"
  | "guide";

export const navItems: Array<{ label: string; href: string; view: LabView }> = [
  { label: "Dashboard", href: "/", view: "dashboard" },
  { label: "Products", href: "/products", view: "products" },
  { label: "Product Detail", href: "/product-detail", view: "product-detail" },
  { label: "Proof Day", href: "/proof-day", view: "proof-day" },
  { label: "Proof Batches", href: "/batches", view: "batches" },
  { label: "Costing", href: "/costing", view: "costing" },
  { label: "Supplies", href: "/supplies", view: "supplies" },
  { label: "Equipment", href: "/equipment", view: "equipment" },
  { label: "Content Journal", href: "/journal", view: "journal" },
  { label: "Product Admin", href: "/admin", view: "admin" },
  { label: "Launch Offer", href: "/launch", view: "launch" },
  { label: "Content Studio", href: "/content-studio", view: "content-studio" },
  { label: "How To Use", href: "/guide", view: "guide" },
];

export const storageKey = "aly-shin-product-lab-v1";

export type LabState = {
  batches: ProductBatch[];
  batchPhotos: BatchPhoto[];
  costingEntries: CostingEntry[];
  costings: CostingSummary[];
  supplies: SupplyEntry[];
  equipment: EquipmentEntry[];
  tastings: TastingFeedback[];
  journal: ContentJournalEntry[];
};

export const emptyState: LabState = {
  batches: [],
  batchPhotos: [],
  costingEntries: [],
  costings: [],
  supplies: [],
  equipment: [],
  tastings: [],
  journal: [],
};

export const today = new Date().toISOString().slice(0, 10);

import type { ContentJournalEntry, CostingEntry, CostingSummary, ProductBatch, TastingFeedback } from "./product-lab-types";

export type LabView =
  | "dashboard"
  | "products"
  | "product-detail"
  | "proof-day"
  | "batches"
  | "costing"
  | "tasting"
  | "journal"
  | "admin"
  | "launch"
  | "content-studio";

export const navItems: Array<{ label: string; href: string; view: LabView }> = [
  { label: "Dashboard", href: "/", view: "dashboard" },
  { label: "Products", href: "/products", view: "products" },
  { label: "Product Detail", href: "/product-detail", view: "product-detail" },
  { label: "Proof Day", href: "/proof-day", view: "proof-day" },
  { label: "Proof Batches", href: "/batches", view: "batches" },
  { label: "Costing", href: "/costing", view: "costing" },
  { label: "Tasting", href: "/tasting", view: "tasting" },
  { label: "Content Journal", href: "/journal", view: "journal" },
  { label: "Product Admin", href: "/admin", view: "admin" },
  { label: "Launch Offer", href: "/launch", view: "launch" },
  { label: "Content Studio", href: "/content-studio", view: "content-studio" },
];

export const storageKey = "aly-shin-product-lab-v1";

export type LabState = {
  batches: ProductBatch[];
  costingEntries: CostingEntry[];
  costings: CostingSummary[];
  tastings: TastingFeedback[];
  journal: ContentJournalEntry[];
};

export const emptyState: LabState = {
  batches: [],
  costingEntries: [],
  costings: [],
  tastings: [],
  journal: [],
};

export const today = new Date().toISOString().slice(0, 10);

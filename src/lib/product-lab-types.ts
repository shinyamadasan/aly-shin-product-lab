export type ProductStatus = "testing" | "costed" | "tasting" | "launch_candidate" | "paused";

export type ProductRole =
  | "Hero candidate"
  | "Bundle product"
  | "Premium upgrade"
  | "Add-on candidate";

export type Product = {
  id: string;
  name: string;
  category: string;
  role: ProductRole;
  status: ProductStatus;
  description: string;
  image: string;
  decision: "Needs proof" | "Retest" | "Candidate" | "Add-on test";
};

export type ProductBatch = {
  id: string;
  productId: string;
  batchVersion: string;
  status?: "draft" | "completed" | "voided" | "";
  completedAt?: string;
  voidedAt?: string;
  voidReason?: string;
  dateMade: string;
  ingredientsNotes: string;
  prepTimeMinutes: number;
  bakeTimeMinutes: number;
  coolingTimeMinutes: number;
  usablePieces: number;
  imperfectPieces: number;
  stressLevel: number;
  tasteNotes: string;
  textureNotes: string;
  wentWrong: string;
  improveNext: string;
  launchDecision: "launch" | "retest" | "pause" | "remove";
};

export type BatchPhoto = {
  id: string;
  batchId: string;
  photoUrl: string;
  photoType: string;
  notes: string;
  storagePath: string;
};

export type CostingSummary = {
  id: string;
  productId: string;
  batchId: string;
  ingredientCost: number;
  packagingCost: number;
  laborEstimate: number;
  waterCost: number;
  gasCost: number;
  ovenElectricCost: number;
  refrigerationCost: number;
  coffeeEquipmentCost: number;
  wasteAllowance: number;
  overheadCost: number;
  equipmentCost: number;
  suggestedPrice: number;
  notes: string;
};

export type CostingEntry = {
  id: string;
  productId: string;
  batchId: string;
  brandName: string;
  ingredientName: string;
  quantityUsed: number;
  unit: string;
  cost: number;
  supplierNote: string;
};

export type CostingIngredientRow = CostingEntry & { brandName: string; isManualCost?: boolean; rowId: string };

export type SupplyEntry = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  brandName: string;
  supplierName: string;
  purchaseDate: string;
  createdAt: string;
  packQuantity: number;
  unit: string;
  totalCost: number;
  qualityRating: number;
  notes: string;
};

export type TastingFeedback = {
  id: string;
  productId: string;
  batchId: string;
  timeLabel: string;
  tasterName: string;
  rating: number;
  liked: string;
  improve: string;
  wouldBuy: "yes" | "maybe" | "no";
  willingToPay: number;
  wouldReorder: "yes" | "maybe" | "no";
  packagingReaction: string;
};

// Journey / content_journal readiness (M2A) -- see MARKETING_MODULE.md's "Journey /
// content_journal Readiness Audit" section. content_journal is the canonical Journey
// persistence table (no separate journey_entries table). batchId was already a nullable
// DB column, unused at this layer until now; entryType is a new nullable DB column
// (supabase-add-journey-entry-type.sql), open-ended and app-enforced, not a DB enum/check.
// Both stay optional -- matching ProductBatch's completedAt/voidedAt/voidReason and
// Ingredient's archivedAt convention for additive nullable columns -- so this change
// requires no update to existing read/save code paths (that's M2B's job).
export type ContentJournalEntry = {
  id: string;
  productId: string;
  batchId?: string;
  entryDate: string;
  whatWasMade: string;
  mediaCaptured: string;
  lessonLearned: string;
  postIdeas: string;
  nextAction: string;
  entryType?: string;
};

// The 5 AI Advisor actions this app supports -- see services/ai/. Deliberately fixed, not
// open-ended: RULE_ENGINE.md/ai-review/ own deterministic checks and specialist judgment, the
// AI Advisor only explains/recommends/brainstorms on top of what they already computed.
export type AiAction = "explain-status" | "recommend-next-action" | "improve-product" | "design-experiment" | "launch-review";

export type SpecialistId =
  | "restaurant-accountant"
  | "bakery-production-manager"
  | "product-development-chef"
  | "food-science-quality-specialist"
  | "supply-chain-manager"
  | "business-intelligence-analyst"
  | "multi-branch-operations-reviewer";

// A saved round trip: the deterministically-assembled prompt the app generated, and (once the
// operator has run it through an AI chat and pasted the reply back) its response. response is
// "" until pasted back -- a review can exist prompt-only.
export type AiReviewRecord = {
  id: string;
  productId: string;
  batchId: string;
  action: AiAction;
  specialists: SpecialistId[];
  prompt: string;
  response: string;
  createdAt: string;
};

export type IngredientBaseUnit = "g" | "kg" | "ml" | "L" | "pcs";

// Deliberately excludes "equipment" -- Equipment already has its own table and workflow. "" means
// not set (existing ingredients read this way until edited; no backfill).
export type IngredientCategory = "ingredient" | "packaging" | "consumable" | "other";

export type Ingredient = {
  id: string;
  name: string;
  baseUnit: IngredientBaseUnit;
  category: IngredientCategory | "";
  currentQuantity: number;
  lowStockThreshold: number;
  targetStockQuantity: number;
  nearestExpirationDate: string;
  averageUnitCost: number;
  notes: string;
  isActive: boolean;
  archivedAt?: string;
};

// "suggested" is a strong partial-name match -- unlike every other method here, it never resolves
// a row to "matched" on its own. It only pre-fills the ingredient picker; the operator still has
// to confirm it, the same way an unmatched row would otherwise require a manual pick.
export type MatchMethod = "alias" | "exact" | "normalized" | "suggested" | "manual" | "none";

export type IngredientAlias = {
  id: string;
  rawText: string;
  normalizedText: string;
  ingredientId: string;
  source: string;
};

export type PurchaseImportStatus = "draft" | "confirmed" | "discarded";

export type PurchaseImport = {
  id: string;
  fileName: string;
  status: PurchaseImportStatus;
  importedAt: string;
  rowCount: number;
  totalValue: number;
  // Receipt-level metadata: usually one CSV upload is one receipt, so these are entered once (in
  // the wizard's header block, auto-filled from the first row) and apply to every row -- but each
  // row still carries its own raw value (see PurchaseImportRow) for the CSV that genuinely mixes
  // receipts.
  supplierName: string;
  receiptNumber: string;
  purchaseDate: string;
};

export type PurchaseImportRowStatus = "pending" | "matched" | "excluded" | "invalid";

export type PurchaseImportRow = {
  id: string;
  importId: string;
  rowIndex: number;
  rawItemName: string;
  rawBrand: string;
  rawQuantity: string;
  rawUnit: string;
  rawTotalPrice: string;
  rawExpirationDate: string;
  // Package-based CSVs (package_count x package_size package_unit @ unit_price) populate these
  // instead of rawQuantity/rawUnit/rawTotalPrice; a flat CSV (quantity/unit/total_price, today's
  // format) leaves them blank and keeps working exactly as before -- see buildPurchaseImportRowDrafts.
  rawPackageCount: string;
  rawPackageSize: string;
  rawPackageUnit: string;
  rawUnitPrice: string;
  rawCategory: string;
  rawSupplier: string;
  rawReceiptNumber: string;
  rawPurchaseDate: string;
  parsedQuantity: number;
  parsedTotalPrice: number;
  parsedExpirationDate: string;
  parsedPackageCount: number;
  parsedPackageSize: number;
  parsedUnitPrice: number;
  ingredientId: string;
  matchMethod: MatchMethod;
  convertedQuantity: number;
  // True once the operator has hand-edited "Inventory Added" directly -- once set, a later edit to
  // package count/size stops recomputing convertedQuantity for this row, the same "manual wins"
  // rule Costing already uses for cost overrides.
  isQuantityOverridden: boolean;
  // Purchase-level, not ingredient-level (see PROP-010 in planning/PROPOSALS.md for why): prefilled
  // only when every existing SupplyEntry for the matched ingredient agrees on one brand, left blank
  // (and required before confirming) otherwise. Every confirmed row creates a SupplyEntry, and a
  // SupplyEntry with an empty brand is never allowed to leave the importer.
  brandName: string;
  rowStatus: PurchaseImportRowStatus;
  excludeReason: string;
  validationErrors: string;
};

export type InventoryTransactionType = "purchase" | "consume" | "adjustment" | "waste";
export type InventoryTransactionSourceType = "purchase_import" | "bake" | "manual";

export type InventoryTransaction = {
  id: string;
  ingredientId: string;
  transactionType: InventoryTransactionType;
  quantityChange: number;
  quantityBefore: number;
  quantityAfter: number;
  sourceType: InventoryTransactionSourceType;
  sourceId: string;
  note: string;
  createdAt: string;
};

export type EquipmentCalculationMode = "depreciation" | "replacement-reserve" | "gas-burn-rate";

export type EquipmentEntry = {
  id: string;
  name: string;
  brand: string;
  model: string;
  purchasePrice: number;
  purchaseDate: string;
  residualValuePercent: number;
  usefulLifeYears: number;
  batchesPerWeek: number;
  annualMaintenancePercent: number;
  batchesPerUnit: number;
  tankSizeKg: number;
  burnRateKgPerHour: number;
  calculationMode: EquipmentCalculationMode;
  notes: string;
  isActive: boolean;
};

// Marketing Module M1 (see PROP-012 in planning/PROPOSALS.md and MARKETING_MODULE.md).
// Schema/type only in this milestone -- no CRUD UI reads or writes this yet. This app has
// no per-user/workspace identity anywhere, so there is no "owner" scoping here: isActive
// marks the single currently-active profile (enforced by a DB partial unique index), not
// a per-user flag. Older profiles can stay isActive: false for history instead of being
// overwritten in place.
export type BrandProfile = {
  id: string;
  businessName: string;
  shortDescription: string;
  targetAudience: string;
  brandVoiceNotes: string;
  primaryCta: string;
  preferredPhrases: string;
  prohibitedPhrases: string;
  primaryColor: string;
  secondaryColor: string;
  headingFont: string;
  bodyFont: string;
  logoStoragePath: string;
  socialLinks: string;
  isActive: boolean;
};

// Content persistence foundation (M2C1) -- see PROP in planning/PROPOSALS.md and
// MARKETING_MODULE.md's "M2C1 implementation record". Schema/type only in this milestone --
// no CRUD UI reads or writes this yet, no row-mapping/payload-building functions (M2C2's job).
// journeyEntryId/sourceSnapshot/title/hook/caption/script are all nullable at the database
// layer; each reads back as "" when unset, matching this app's existing convention for
// nullable text fields (see ContentJournalEntry's own productId/whatWasMade/etc.). There is
// no campaignId, platform, productId, batchId, or owner/user/workspace column here -- all
// deliberately deferred or excluded, per MARKETING_MODULE.md.
export type ContentDraft = {
  id: string;
  journeyEntryId: string;
  sourceSnapshot: string;
  title: string;
  contentType: string;
  status: string;
  hook: string;
  caption: string;
  script: string;
  createdAt: string;
  updatedAt: string;
};

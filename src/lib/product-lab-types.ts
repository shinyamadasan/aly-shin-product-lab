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

export type ContentJournalEntry = {
  id: string;
  productId: string;
  entryDate: string;
  whatWasMade: string;
  mediaCaptured: string;
  lessonLearned: string;
  postIdeas: string;
  nextAction: string;
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

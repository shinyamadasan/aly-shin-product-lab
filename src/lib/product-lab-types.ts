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

export type CostingSummary = {
  id: string;
  productId: string;
  ingredientCost: number;
  packagingCost: number;
  laborEstimate: number;
  waterCost: number;
  gasCost: number;
  ovenElectricCost: number;
  refrigerationCost: number;
  coffeeEquipmentCost: number;
  wasteAllowance: number;
  suggestedPrice: number;
  notes: string;
};

export type CostingEntry = {
  id: string;
  productId: string;
  ingredientName: string;
  quantityUsed: number;
  unit: string;
  cost: number;
  supplierNote: string;
};

export type TastingFeedback = {
  id: string;
  productId: string;
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

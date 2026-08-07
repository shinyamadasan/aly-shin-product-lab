"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ChangeEvent as ReactChangeEvent, Dispatch, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PostgrestError, Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Beaker,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FlaskConical,
  GripVertical,
  NotebookPen,
  PackageCheck,
  PackageX,
  ShieldAlert,
  Sparkles,
  Star,
} from "lucide-react";
import { readinessRules } from "@/lib/sample-data";
import {
  getClosestToLaunch,
  getPauseCandidates,
  getProductPriority,
  getProductsNeedingProof,
  getProductStats,
  getReadinessScore,
  getShinReviewItems,
} from "@/lib/readiness";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { AiAction, BatchPhoto, ContentDraft, ContentJournalEntry, CostingEntry, CostingIngredientRow, CostingSummary, EquipmentCalculationMode, EquipmentEntry, Ingredient, InventoryTransaction, Product, ProductBatch, PurchaseImport, PurchaseImportRow, SellingFormat, SellingFormatPackagingLine, SpecialistId, StockAdjustmentReason, SupplyEntry, TastingFeedback } from "@/lib/product-lab-types";
import { AiAdvisorPanel } from "@/components/ai-advisor-panel";
import { baseUnitOptions, ingredientCategoryLabel, ingredientCategoryOptions, InventoryPage } from "@/components/inventory-page";
import { InventoryStockPage } from "@/components/inventory-stock-page";
import { InventoryTimeline } from "@/components/inventory-timeline";
import { inventoryTabs, type InventoryTab } from "@/lib/inventory-tabs";
import { PurchaseImportWizard } from "@/components/purchase-import-wizard";
import { IngredientPicker } from "@/components/ingredient-picker";
import { BakePage } from "@/components/bake-page";
import { OpportunitiesPage } from "@/components/opportunities-page";
import { Button, FormPanel, Input, MessageBox, MetricCard, Panel, SecondaryButton, Select, StatusPill, Tag, Textarea } from "@/components/ui";
import { emptyState, storageKey, getToday, type LabState, type LabView } from "@/lib/lab-state";
import { AppShell } from "@/components/app-shell";
import type { OpportunityStatusFilter } from "@/lib/opportunity-review";
import { ContentStatusSelect, ContentTypeSelect, JourneyTypeSelect, MediaChecklist, ProductSelect, batchDisplayName, costingDisplayName, productName } from "@/components/product-controls";
import { RecentEntries } from "@/components/recent-entries";
import { buildContentJournalPayload, mapContentJournalRow } from "@/lib/journal";
import {
  buildContentDraftPayload,
  buildContentDraftUpdatePayload,
  contentDraftStatusLabel,
  contentTypeLabel,
  createDraftFromJourney,
  mapContentDraftRow,
} from "@/lib/content-drafts";
import { buildCostingSummaryPayload, findConflictingCosting, formatCostingMetric, getCostingMetrics, getCostingTotals, isBatchProductMismatch, resolveCostingId } from "@/lib/costing";
import {
  buildMovedManualPackagingLine,
  buildSellingFormatPackagingLinePayload,
  buildSellingFormatPayload,
  calculateMoveToSellingFormatAmount,
  getRemovedSellingFormatIds,
  getRemovedSellingFormatPackagingLineIds,
  getSellingFormatPackagingCost,
  getSellingFormatMetrics,
  mapSellingFormatPackagingLineRow,
  mapSellingFormatRow,
  parseSellingFormatsFromFormData,
  replaceSellingFormatPackagingLinesForCosting,
  replaceSellingFormatsForCosting,
  validateSellingFormatsForSave,
  type SellingFormatMoveInterpretation,
} from "@/lib/selling-formats";
import { isDuplicateKeyError } from "@/lib/database-errors";
import { useEditNavigation } from "@/hooks/use-edit-navigation";
import { DEFAULT_EXPIRES_SOON_DAYS, getInventorySummaryCounts, getNeedToBuyList } from "@/lib/inventory-status";
import { buildAliasRecord } from "@/lib/ingredient-matching";
import { applyPurchaseImportConfirmation, buildSupplyEntriesFromPurchaseImport, toSupplyEntryRow } from "@/lib/purchase-import-confirm";
import type { PurchaseImportRowDraft } from "@/lib/purchase-import";
import { applyBakeConfirmation } from "@/lib/bake-confirm";
import type { BakeDeduction } from "@/lib/bake-deduction";
import { toInventoryTransactionRow } from "@/lib/inventory-transaction";
import { applySupplyPurchaseEffect, planSupplyDelete, planSupplyEdit, repairMissingSupplyInventoryEffects, type SupplyRepairResult } from "@/lib/supply-inventory-effect";
import { applyStockAdjustment, reverseStockAdjustment } from "@/lib/stock-adjustment";
import { describeIngredientConstraintError } from "@/lib/inventory-errors";
import {
  getAutoCostedIngredientRowForItems,
  getConversionLabel,
  getMatchingPurchaseHistoryForIngredient,
  getSupplyLabel,
  getSupplyUsedCost,
  normalizeSupplyText,
} from "@/lib/supplies";
import { getChronologicalPurchases, getPurchaseGroupSummary, getPurchaseHistoryForIngredientReference, getUnlinkedPurchases, groupPurchasesByItem } from "@/lib/purchase-history";
import { getAllocatedEquipmentCost, getEquipmentTotals, REFERENCE_COOKING_MINUTES } from "@/lib/equipment";
import {
  diffFormulaRows,
  findConflictingBatch,
  getPreviousBatch,
  parseBatchIngredients,
  parseBatchProcessSteps,
  parseBatchRecord,
  type BatchFormulaRow,
} from "@/lib/batches";
import { archiveItem, canHardDeleteItem, getItemReferenceSummary, itemReferenceCount, restoreItem } from "@/lib/inventory-safety";
import { canDeleteDraftBatch, canVoidBatch, getBatchReferenceSummary, getEffectiveBatchStatus, markBatchCompleted, voidBatch } from "@/lib/batch-safety";
import { canDeleteProduct, getProductReferenceCount, totalProductReferenceCount } from "@/lib/product-safety";

// Keep these in sync with the file_size_limit / allowed_mime_types set on the
// batch-photos bucket in supabase-add-batch-photos-storage.sql -- that bucket
// config is the real enforcement point, this is just fast client-side feedback.
const BATCH_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const BATCH_PHOTO_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// A table the operator hasn't created yet surfaces as PostgREST "undefined table" (PGRST205, a
// schema-cache miss) or the underlying Postgres 42P01 -- not as an arbitrary error message that
// merely happens to contain the table's name. Match on the error CODE so a genuine load failure
// whose text includes e.g. "equipment" is never silently mistaken for "table not set up yet"
// (which would hide the real error behind a "run the setup SQL" banner).
function isMissingTableError(error: PostgrestError | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

// A column the operator hasn't migrated yet (supabase-add-purchase-import-packages.sql not run)
// surfaces as PostgREST "column not found in the schema cache" (PGRST204) or the underlying
// Postgres 42703 -- the same code-not-text-match reasoning as isMissingTableError above.
function isMissingColumnError(error: PostgrestError | null): boolean {
  return error?.code === "PGRST204" || error?.code === "42703";
}

export default function ProductLab({
  view = "dashboard",
  initialInventoryTab,
  initialOpportunityStatusFilter = "new",
}: {
  view?: LabView;
  initialInventoryTab?: InventoryTab;
  initialOpportunityStatusFilter?: OpportunityStatusFilter;
}) {
  const router = useRouter();
  const [labState, setLabState] = useState<LabState>(() => {
    if (typeof window === "undefined") {
      return emptyState;
    }

    // Never let a corrupt or legacy-shaped localStorage value crash the whole app on load. A bad
    // JSON.parse here would white-screen the page with no in-app way to recover, so on any failure
    // we drop back to emptyState and clear the poisoned key instead of throwing during render.
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) {
      return emptyState;
    }

    try {
      return { ...emptyState, ...(JSON.parse(saved) as LabState) };
    } catch {
      window.localStorage.removeItem(storageKey);
      return emptyState;
    }
  });
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "bad" | "info">("info");
  const [isSuppliesTableMissing, setIsSuppliesTableMissing] = useState(false);
  const [isEquipmentTableMissing, setIsEquipmentTableMissing] = useState(false);
  const [isAiReviewsTableMissing, setIsAiReviewsTableMissing] = useState(false);
  const [isInventoryTableMissing, setIsInventoryTableMissing] = useState(false);
  const [isPurchaseImportPackagesMissing, setIsPurchaseImportPackagesMissing] = useState(false);
  const [isContentDraftsTableMissing, setIsContentDraftsTableMissing] = useState(false);
  const [isSellingFormatsTableMissing, setIsSellingFormatsTableMissing] = useState(false);
  const [isProductDecisionColumnMissing, setIsProductDecisionColumnMissing] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingBatch, setEditingBatch] = useState<ProductBatch | null>(null);
  const [editingCosting, setEditingCosting] = useState<CostingSummary | null>(null);
  const [editingSupply, setEditingSupply] = useState<SupplyEntry | null>(null);
  const [editingEquipment, setEditingEquipment] = useState<EquipmentEntry | null>(null);
  const [editingJournal, setEditingJournal] = useState<ContentJournalEntry | null>(null);
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | null>(null);
  const [editingDraft, setEditingDraft] = useState<ContentDraft | null>(null);
  // Which Journey entry's "Create content" insert is currently in flight, if any -- guards
  // against one click firing twice without blocking a *different* entry's button (see
  // isCreateContentPending in src/lib/content-drafts.ts).
  const [creatingContentForEntryId, setCreatingContentForEntryId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsAuthLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !session) {
      return;
    }

    loadSupabaseData();
  }, [session]);

  useEffect(() => {
    if (supabase) {
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(labState));
  }, [labState]);

  async function loadSupabaseData() {
    if (!supabase) {
      return;
    }

    const [productResult, batchResult, batchPhotoResult, costingEntryResult, costingResult, sellingFormatResult, sellingFormatPackagingLineResult, supplyResult, equipmentResult, tastingResult, journalResult, contentDraftResult, aiReviewResult, ingredientResult, ingredientAliasResult, purchaseImportResult, purchaseImportRowResult, inventoryTransactionResult] = await Promise.all([
      supabase.from("products").select("*").order("name", { ascending: true }),
      supabase.from("product_batches").select("*").order("created_at", { ascending: false }),
      supabase.from("batch_photos").select("*").order("created_at", { ascending: false }),
      supabase.from("costing_entries").select("*").order("created_at", { ascending: false }),
      supabase.from("costing_summaries").select("*").order("created_at", { ascending: false }),
      supabase.from("selling_formats").select("*").order("sort_order", { ascending: true }),
      supabase.from("selling_format_packaging_lines").select("*").order("sort_order", { ascending: true }),
      supabase.from("supply_entries").select("*").order("created_at", { ascending: false }),
      supabase.from("equipment").select("*").order("created_at", { ascending: false }),
      supabase.from("tasting_feedback").select("*").order("created_at", { ascending: false }),
      supabase.from("content_journal").select("*").order("created_at", { ascending: false }),
      supabase.from("content_drafts").select("*").order("created_at", { ascending: false }),
      supabase.from("ai_reviews").select("*").order("created_at", { ascending: false }),
      supabase.from("ingredients").select("*").order("created_at", { ascending: false }),
      supabase.from("ingredient_aliases").select("*").order("created_at", { ascending: false }),
      supabase.from("purchase_imports").select("*").order("created_at", { ascending: false }),
      supabase.from("purchase_import_rows").select("*").order("row_index", { ascending: true }),
      supabase.from("inventory_transactions").select("*").order("created_at", { ascending: false }),
    ]);

    const supplyMissing = isMissingTableError(supplyResult.error);
    const equipmentMissing = isMissingTableError(equipmentResult.error);
    const aiReviewsMissing = isMissingTableError(aiReviewResult.error);
    const contentDraftsMissing = isMissingTableError(contentDraftResult.error);
    // Both selling_formats tables ship together in supabase-add-selling-formats.sql, so one shared
    // flag -- mirrors the ingredientsMissing bundle below (same rationale: no scenario where only
    // one of a co-shipped pair exists).
    const sellingFormatsMissing = isMissingTableError(sellingFormatResult.error) || isMissingTableError(sellingFormatPackagingLineResult.error);
    // All 6 inventory tables ship together in supabase-add-inventory.sql, so one shared flag
    // (not one per table) -- there's no real scenario where only some of them exist. Uses the same
    // error-code check as the tables above so a genuine load failure isn't misread as "not set up".
    const ingredientsMissing =
      isMissingTableError(ingredientResult.error) ||
      isMissingTableError(ingredientAliasResult.error) ||
      isMissingTableError(purchaseImportResult.error) ||
      isMissingTableError(purchaseImportRowResult.error) ||
      isMissingTableError(inventoryTransactionResult.error);
    setIsSuppliesTableMissing(Boolean(supplyMissing));
    setIsEquipmentTableMissing(Boolean(equipmentMissing));
    setIsAiReviewsTableMissing(Boolean(aiReviewsMissing));
    setIsInventoryTableMissing(ingredientsMissing);
    setIsContentDraftsTableMissing(Boolean(contentDraftsMissing));
    setIsSellingFormatsTableMissing(Boolean(sellingFormatsMissing));
    if (productResult.error || batchResult.error || batchPhotoResult.error || costingEntryResult.error || costingResult.error || (!sellingFormatsMissing && (sellingFormatResult.error || sellingFormatPackagingLineResult.error)) || (!supplyMissing && supplyResult.error) || (!equipmentMissing && equipmentResult.error) || tastingResult.error || journalResult.error || (!contentDraftsMissing && contentDraftResult.error) || (!aiReviewsMissing && aiReviewResult.error) || (!ingredientsMissing && (ingredientResult.error || ingredientAliasResult.error || purchaseImportResult.error || purchaseImportRowResult.error || inventoryTransactionResult.error))) {
      const error =
        productResult.error?.message ||
        batchResult.error?.message ||
        batchPhotoResult.error?.message ||
        costingEntryResult.error?.message ||
        costingResult.error?.message ||
        sellingFormatResult.error?.message ||
        sellingFormatPackagingLineResult.error?.message ||
        supplyResult.error?.message ||
        equipmentResult.error?.message ||
        tastingResult.error?.message ||
        journalResult.error?.message ||
        contentDraftResult.error?.message ||
        aiReviewResult.error?.message ||
        ingredientResult.error?.message ||
        ingredientAliasResult.error?.message ||
        purchaseImportResult.error?.message ||
        purchaseImportRowResult.error?.message ||
        inventoryTransactionResult.error?.message;
      setMessage(`Could not load Supabase data: ${error}`);
      setMessageTone("bad");
      return;
    }

    setLabState({
      products: (productResult.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        role: row.product_role,
        status: row.status,
        description: row.description ?? "",
        image: row.main_photo_url ?? "",
        decision: row.decision ?? "Needs proof",
      })),
      batches: (batchResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchVersion: row.batch_version,
        status: row.status ?? "draft",
        completedAt: row.completed_at ?? "",
        voidedAt: row.voided_at ?? "",
        voidReason: row.void_reason ?? "",
        dateMade: row.date_made,
        ingredientsNotes: row.ingredients_notes ?? "",
        prepTimeMinutes: row.prep_time_minutes ?? 0,
        bakeTimeMinutes: row.bake_time_minutes ?? 0,
        coolingTimeMinutes: row.cooling_time_minutes ?? 0,
        usablePieces: row.usable_pieces ?? 0,
        imperfectPieces: row.imperfect_pieces ?? 0,
        stressLevel: row.stress_level ?? 3,
        tasteNotes: row.taste_notes ?? "",
        textureNotes: row.texture_notes ?? "",
        wentWrong: row.went_wrong ?? "",
        improveNext: row.improve_next ?? "",
        launchDecision: row.launch_decision,
      })),
      batchPhotos: (batchPhotoResult.data ?? []).map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        photoUrl: row.photo_url,
        photoType: row.photo_type ?? "",
        notes: row.notes ?? "",
        storagePath: row.storage_path ?? "",
      })),
      costingEntries: (costingEntryResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchId: row.batch_id ?? "",
        brandName: getBrandFromCostingNote(row.supplier_note ?? ""),
        ingredientName: row.ingredient_name,
        quantityUsed: Number(row.quantity_used ?? 0),
        unit: row.unit ?? "",
        cost: Number(row.cost ?? 0),
        supplierNote: getCostingNoteWithoutBrand(row.supplier_note ?? ""),
      })),
      costings: (costingResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchId: row.batch_id ?? "",
        ingredientCost: Number(row.ingredient_cost ?? 0),
        packagingCost: Number(row.packaging_cost ?? 0),
        laborEstimate: Number(row.labor_estimate ?? 0),
        waterCost: Number(row.water_cost ?? 0),
        gasCost: Number(row.gas_cost ?? 0),
        ovenElectricCost: Number(row.oven_electric_cost ?? 0),
        refrigerationCost: Number(row.refrigeration_cost ?? 0),
        coffeeEquipmentCost: Number(row.coffee_equipment_cost ?? 0),
        wasteAllowance: Number(row.waste_allowance ?? 0),
        overheadCost: Number(row.overhead_cost ?? 0),
        equipmentCost: Number(row.equipment_cost ?? 0),
        suggestedPrice: Number(row.suggested_price ?? 0),
        notes: row.notes ?? "",
      })),
      sellingFormats: sellingFormatsMissing ? [] : (sellingFormatResult.data ?? []).map(mapSellingFormatRow),
      sellingFormatPackagingLines: sellingFormatsMissing ? [] : (sellingFormatPackagingLineResult.data ?? []).map(mapSellingFormatPackagingLineRow),
      supplies: supplyMissing ? [] : (supplyResult.data ?? []).map((row) => ({
        id: row.id,
        ingredientId: row.ingredient_id ?? "",
        ingredientName: row.ingredient_name,
        brandName: row.brand_name ?? "",
        supplierName: row.supplier_name,
        purchaseDate: row.purchase_date,
        createdAt: row.created_at ?? "",
        packQuantity: Number(row.pack_quantity ?? 0),
        unit: row.unit ?? "",
        totalCost: Number(row.total_cost ?? 0),
        qualityRating: Number(row.quality_rating ?? 0),
        notes: row.notes ?? "",
      })),
      equipment: equipmentMissing ? [] : (equipmentResult.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        brand: row.brand ?? "",
        model: row.model ?? "",
        purchasePrice: Number(row.purchase_price ?? 0),
        purchaseDate: row.purchase_date,
        residualValuePercent: Number(row.residual_value_percent ?? 0),
        usefulLifeYears: Number(row.useful_life_years ?? 0),
        batchesPerWeek: Number(row.batches_per_week ?? 0),
        annualMaintenancePercent: Number(row.annual_maintenance_percent ?? 0),
        batchesPerUnit: Number(row.batches_per_unit ?? 0),
        tankSizeKg: Number(row.tank_size_kg ?? 0),
        burnRateKgPerHour: Number(row.burn_rate_kg_per_hour ?? 0),
        calculationMode: row.calculation_mode ?? "depreciation",
        notes: row.notes ?? "",
        isActive: row.is_active ?? true,
      })),
      tastings: (tastingResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchId: row.batch_id ?? "",
        timeLabel: row.time_label ?? "",
        tasterName: row.taster_name,
        rating: row.rating ?? 0,
        liked: row.liked ?? "",
        improve: row.improve ?? "",
        wouldBuy: row.would_buy,
        willingToPay: Number(row.willing_to_pay ?? 0),
        wouldReorder: row.would_reorder,
        packagingReaction: row.packaging_reaction ?? "",
      })),
      journal: (journalResult.data ?? []).map(mapContentJournalRow),
      contentDrafts: contentDraftsMissing ? [] : (contentDraftResult.data ?? []).map(mapContentDraftRow),
      aiReviews: aiReviewsMissing ? [] : (aiReviewResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchId: row.batch_id ?? "",
        action: row.action,
        specialists: row.specialists ? row.specialists.split(",").filter(Boolean) : [],
        prompt: row.prompt ?? "",
        response: row.response ?? "",
        createdAt: row.created_at ?? "",
      })),
      ingredients: ingredientsMissing ? [] : (ingredientResult.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        baseUnit: row.base_unit,
        category: row.category ?? "",
        currentQuantity: Number(row.current_quantity ?? 0),
        lowStockThreshold: Number(row.low_stock_threshold ?? 0),
        targetStockQuantity: Number(row.target_stock_quantity ?? 0),
        nearestExpirationDate: row.nearest_expiration_date ?? "",
        averageUnitCost: Number(row.average_unit_cost ?? 0),
        notes: row.notes ?? "",
        isActive: row.is_active ?? true,
        archivedAt: row.archived_at ?? "",
        baseUnitMigrationFlaggedReason: row.base_unit_migration_flagged_reason ?? null,
      })),
      ingredientAliases: ingredientsMissing ? [] : (ingredientAliasResult.data ?? []).map((row) => ({
        id: row.id,
        rawText: row.raw_text,
        normalizedText: row.normalized_text,
        ingredientId: row.ingredient_id,
        source: row.source ?? "",
      })),
      purchaseImports: ingredientsMissing ? [] : (purchaseImportResult.data ?? []).map((row) => ({
        id: row.id,
        fileName: row.file_name,
        status: row.status,
        importedAt: row.imported_at ?? "",
        rowCount: Number(row.row_count ?? 0),
        totalValue: Number(row.total_value ?? 0),
        supplierName: row.supplier_name ?? "",
        receiptNumber: row.receipt_number ?? "",
        purchaseDate: row.purchase_date ?? "",
      })),
      purchaseImportRows: ingredientsMissing ? [] : (purchaseImportRowResult.data ?? []).map((row) => ({
        id: row.id,
        importId: row.import_id,
        rowIndex: Number(row.row_index ?? 0),
        rawItemName: row.raw_item_name,
        rawBrand: row.raw_brand ?? "",
        rawQuantity: row.raw_quantity,
        rawUnit: row.raw_unit,
        rawTotalPrice: row.raw_total_price ?? "",
        rawExpirationDate: row.raw_expiration_date ?? "",
        rawPackageCount: row.raw_package_count ?? "",
        rawPackageSize: row.raw_package_size ?? "",
        rawPackageUnit: row.raw_package_unit ?? "",
        rawUnitPrice: row.raw_unit_price ?? "",
        rawCategory: row.raw_category ?? "",
        rawSupplier: row.raw_supplier ?? "",
        rawReceiptNumber: row.raw_receipt_number ?? "",
        rawPurchaseDate: row.raw_purchase_date ?? "",
        parsedQuantity: Number(row.parsed_quantity ?? 0),
        parsedTotalPrice: Number(row.parsed_total_price ?? 0),
        parsedExpirationDate: row.parsed_expiration_date ?? "",
        parsedPackageCount: Number(row.parsed_package_count ?? 0),
        parsedPackageSize: Number(row.parsed_package_size ?? 0),
        parsedUnitPrice: Number(row.parsed_unit_price ?? 0),
        ingredientId: row.ingredient_id ?? "",
        matchMethod: row.match_method ?? "none",
        convertedQuantity: Number(row.converted_quantity ?? 0),
        isQuantityOverridden: row.is_quantity_overridden ?? false,
        brandName: row.brand_name ?? "",
        rowStatus: row.row_status,
        excludeReason: row.exclude_reason ?? "",
        validationErrors: row.validation_errors ?? "",
      })),
      inventoryTransactions: ingredientsMissing ? [] : (inventoryTransactionResult.data ?? []).map((row) => ({
        id: row.id,
        ingredientId: row.ingredient_id,
        transactionType: row.transaction_type,
        quantityChange: Number(row.quantity_change ?? 0),
        quantityBefore: Number(row.quantity_before ?? 0),
        quantityAfter: Number(row.quantity_after ?? 0),
        sourceType: row.source_type,
        sourceId: row.source_id ?? "",
        note: row.note ?? "",
        createdAt: row.created_at ?? "",
        reason: row.reason ?? undefined,
        actor: row.actor ?? null,
      })),
    });
  }

  async function saveAiReview(review: { productId: string; batchId: string; action: AiAction; specialists: SpecialistId[]; prompt: string; response: string }) {
    if (supabase && session) {
      const { error } = await supabase.from("ai_reviews").insert({
        product_id: review.productId,
        batch_id: review.batchId || null,
        action: review.action,
        specialists: review.specialists.join(","),
        prompt: review.prompt,
        response: review.response,
      });
      setMessage(error ? `AI review save failed: ${error.message}` : "AI review saved.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        await loadSupabaseData();
      }
      return;
    }

    setLabState((current) => ({
      ...current,
      aiReviews: [{ ...review, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...current.aiReviews],
    }));
    setMessage("AI review saved locally.");
    setMessageTone("good");
  }

  async function deleteAiReview(reviewId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("ai_reviews").delete().eq("id", reviewId);
      setMessage(error ? `AI review delete failed: ${error.message}` : "AI review deleted.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({ ...current, aiReviews: current.aiReviews.filter((review) => review.id !== reviewId) }));
    setMessage("AI review deleted locally.");
    setMessageTone("good");
  }

  async function signIn(formData: FormData) {
    if (!supabase) {
      return;
    }

    const email = String(formData.get("email"));
    const password = String(formData.get("password"));
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setMessage(error ? error.message : "");
    setMessageTone(error ? "bad" : "good");
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  const metrics = useMemo(() => {
    const launchCandidates = labState.products.filter((product) => {
      const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
      return readiness.percent >= 100;
    }).length;

    return {
      productCount: labState.products.length,
      launchCandidates,
      needsProof: labState.products.filter((product) => getProductStats(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines).proofBatches === 0).length,
      tastingEntries: labState.tastings.length,
    };
  }, [labState]);

  async function saveProduct(formData: FormData) {
    const productId = String(formData.get("id") || "");
    const product: Product = {
      id: productId || crypto.randomUUID(),
      name: String(formData.get("name") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      role: formData.get("role") as Product["role"],
      status: formData.get("status") as Product["status"],
      description: String(formData.get("description") || "").trim(),
      image: String(formData.get("image") || "").trim(),
      decision: formData.get("decision") as Product["decision"],
    };

    if (supabase && session) {
      const payload = {
        name: product.name,
        category: product.category,
        product_role: product.role,
        status: product.status,
        description: product.description,
        main_photo_url: product.image || null,
        decision: product.decision,
      };
      const query = productId
        ? supabase.from("products").update(payload).eq("id", productId)
        : supabase.from("products").insert({ id: product.id, ...payload });
      const { error } = await query;
      const missingDecisionColumn = Boolean(error && isMissingColumnError(error));
      setMessage(
        error
          ? missingDecisionColumn
            ? `Product save failed because products is missing the decision column. Run supabase-add-product-decision.sql in Supabase, then retry. Details: ${error.message}`
            : `Product save failed: ${error.message}`
          : "Product saved.",
      );
      setMessageTone(error ? "bad" : "good");
      setIsProductDecisionColumnMissing(missingDecisionColumn);
      if (!error) {
        setEditingProduct(null);
        await loadSupabaseData();
      }
      return;
    }

    setLabState((current) => ({
      ...current,
      // Sorted by name, matching the Supabase query's `.order("name")` -- Product has no
      // createdAt field client-side, so name is the only sort key available identically in both
      // persistence modes. Sorting on every write (not just once at load) keeps this true even
      // as products are added/edited/deleted, without needing a display-time sort at every one of
      // the ~10 places labState.products is read.
      products: (productId ? current.products.map((entry) => (entry.id === productId ? product : entry)) : [product, ...current.products])
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    setEditingProduct(null);
    setMessage("Product saved locally.");
    setMessageTone("good");
  }

  async function deleteProduct(productId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("products").delete().eq("id", productId);
      setMessage(error ? `Product delete failed: ${error.message}` : "Product deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingProduct?.id === productId) {
        setEditingProduct(null);
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({ ...current, products: current.products.filter((entry) => entry.id !== productId) }));
    if (editingProduct?.id === productId) {
      setEditingProduct(null);
    }
    setMessage("Product deleted locally.");
    setMessageTone("good");
  }

  async function saveBatch(formData: FormData) {
    const batchId = String(formData.get("id") || "");
    // The form always sends a real id now (BatchForm pre-generates one for new batches so photos
    // can be staged against it before the batch itself is saved) -- existingId is the separate
    // signal for whether this was actually a pre-existing row, for messaging and upsert semantics.
    const isExisting = Boolean(formData.get("existingId"));
    const existingBatch = labState.batches.find((item) => item.id === batchId);
    const productId = String(formData.get("productId"));
    const batchVersion = String(formData.get("batchVersion") || "V1");

    const conflictingBatch = findConflictingBatch(labState.batches, { batchId, productId, batchVersion });
    if (conflictingBatch) {
      setMessage(`"${batchDisplayName(productId, conflictingBatch.batchVersion, labState.products)}" already exists for this product. Edit that batch instead, or use a different version name.`);
      setMessageTone("bad");
      return;
    }

    const batch: ProductBatch = {
      id: batchId || crypto.randomUUID(),
      productId,
      batchVersion,
      status: existingBatch?.status ?? "draft",
      completedAt: existingBatch?.completedAt ?? "",
      voidedAt: existingBatch?.voidedAt ?? "",
      voidReason: existingBatch?.voidReason ?? "",
      dateMade: String(formData.get("dateMade") || getToday()),
      ingredientsNotes: buildBatchIngredientsNotes(formData),
      prepTimeMinutes: Number(formData.get("prepTimeMinutes") || 0),
      bakeTimeMinutes: Number(formData.get("bakeTimeMinutes") || 0),
      coolingTimeMinutes: Number(formData.get("coolingTimeMinutes") || 0),
      usablePieces: Number(formData.get("usablePieces") || 0),
      imperfectPieces: Number(formData.get("imperfectPieces") || 0),
      stressLevel: Number(formData.get("stressLevel") || 3),
      tasteNotes: String(formData.get("tasteNotes") || ""),
      textureNotes: String(formData.get("textureNotes") || ""),
      wentWrong: String(formData.get("wentWrong") || ""),
      improveNext: String(formData.get("improveNext") || ""),
      launchDecision: formData.get("launchDecision") as ProductBatch["launchDecision"],
    };
    if (supabase && session) {
      const payload = {
        id: batch.id,
        product_id: batch.productId,
        batch_version: batch.batchVersion,
        date_made: batch.dateMade,
        ingredients_notes: batch.ingredientsNotes,
        prep_time_minutes: batch.prepTimeMinutes,
        bake_time_minutes: batch.bakeTimeMinutes,
        cooling_time_minutes: batch.coolingTimeMinutes,
        usable_pieces: batch.usablePieces,
        imperfect_pieces: batch.imperfectPieces,
        stress_level: batch.stressLevel,
        taste_notes: batch.tasteNotes,
        texture_notes: batch.textureNotes,
        went_wrong: batch.wentWrong,
        improve_next: batch.improveNext,
        launch_decision: batch.launchDecision,
        status: batch.status || "draft",
        completed_at: batch.completedAt || null,
        voided_at: batch.voidedAt || null,
        void_reason: batch.voidReason || null,
      };
      const { error } = await supabase.from("product_batches").upsert(payload);
      const duplicateMessage = `"${batchDisplayName(batch.productId, batch.batchVersion, labState.products)}" already exists for this product. Edit that batch instead, or use a different version name.`;
      setMessage(error ? (isDuplicateKeyError(error) ? duplicateMessage : `Batch save failed: ${error.message}`) : isExisting ? "Batch updated." : "Batch saved.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        setEditingBatch(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      batches: isExisting ? current.batches.map((item) => (item.id === batch.id ? batch : item)) : [batch, ...current.batches],
    }));
    setEditingBatch(null);
    setMessage(isExisting ? "Batch updated locally." : "Batch saved locally.");
    setMessageTone("good");
  }

  async function deleteBatch(batchId: string) {
    const batch = labState.batches.find((item) => item.id === batchId);
    if (!batch) {
      setMessage("Batch not found.");
      setMessageTone("bad");
      return;
    }
    const summary = getBatchReferenceSummary({
      batch,
      inventoryTransactions: labState.inventoryTransactions,
      costings: labState.costings,
      costingEntries: labState.costingEntries,
      tastings: labState.tastings,
      batchPhotos: labState.batchPhotos,
      aiReviews: labState.aiReviews,
    });
    if (!canDeleteDraftBatch(batch, summary, labState.inventoryTransactions)) {
      setMessage("Batch delete blocked. Only untouched draft batches with no stock, costing, tasting, photo, or review references can be permanently deleted. Void completed batches instead.");
      setMessageTone("bad");
      return;
    }
    if (supabase && session) {
      const { error } = await supabase.from("product_batches").delete().eq("id", batchId);
      setMessage(error ? `Batch delete failed: ${error.message}` : "Batch deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingBatch?.id === batchId) {
        setEditingBatch(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, batches: current.batches.filter((batch) => batch.id !== batchId) }));
    if (editingBatch?.id === batchId) {
      setEditingBatch(null);
    }
    setMessage("Batch deleted locally.");
    setMessageTone("good");
  }

  async function voidProductBatch(batchId: string, reason: string) {
    const batch = labState.batches.find((item) => item.id === batchId);
    if (!batch) {
      setMessage("Batch not found.");
      setMessageTone("bad");
      return;
    }
    if (!canVoidBatch(batch, labState.inventoryTransactions)) {
      setMessage(getEffectiveBatchStatus(batch, labState.inventoryTransactions) === "voided" ? "This batch is already voided." : "Only completed batches can be voided.");
      setMessageTone("bad");
      return;
    }
    const voided = voidBatch(batch, reason, new Date().toISOString());
    if ("error" in voided) {
      setMessage(voided.error);
      setMessageTone("bad");
      return;
    }
    if (supabase && session) {
      const { error } = await supabase
        .from("product_batches")
        .update({ status: "voided", voided_at: voided.voidedAt || null, void_reason: voided.voidReason || null })
        .eq("id", batchId);
      setMessage(error ? `Batch void failed: ${error.message}` : "Batch voided. Current stock is unchanged; no InventoryTransaction was created, changed, or deleted.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, batches: current.batches.map((item) => (item.id === batchId ? voided : item)) }));
    setMessage("Batch voided locally. Current stock is unchanged; no InventoryTransaction was created, changed, or deleted.");
    setMessageTone("good");
  }

  async function uploadBatchPhotos(batchId: string, files: FileList | File[]) {
    if (!supabase || !session) {
      setMessage("Sign in with Supabase to upload photos.");
      setMessageTone("bad");
      return;
    }
    const client = supabase;

    const oversized = Array.from(files).find((file) => file.size > BATCH_PHOTO_MAX_BYTES);
    if (oversized) {
      setMessage(`Photo upload failed: "${oversized.name}" is over the 10MB limit.`);
      setMessageTone("bad");
      return;
    }
    const wrongType = Array.from(files).find((file) => !BATCH_PHOTO_ALLOWED_TYPES.includes(file.type));
    if (wrongType) {
      setMessage(`Photo upload failed: "${wrongType.name}" is not a supported image type.`);
      setMessageTone("bad");
      return;
    }

    const results = await Promise.all(
      Array.from(files).map(async (file) => {
        const path = `${batchId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9.\-]+/g, "-")}`;
        const { error: uploadError } = await client.storage.from("batch-photos").upload(path, file, { contentType: file.type });
        if (uploadError) {
          return uploadError.message;
        }

        const { data: publicUrlData } = client.storage.from("batch-photos").getPublicUrl(path);
        const { error: insertError } = await client.from("batch_photos").insert({
          batch_id: batchId,
          photo_url: publicUrlData.publicUrl,
          photo_type: file.type,
          storage_path: path,
        });
        if (insertError) {
          // The file uploaded but its DB row didn't -- remove it rather than leaving an orphan.
          await client.storage.from("batch-photos").remove([path]);
          return insertError.message;
        }
        return null;
      }),
    );

    const failures = results.filter((result): result is string => Boolean(result));
    if (failures.length > 0) {
      setMessage(`Photo upload failed: ${failures[0]}. Run supabase-add-batch-photos-storage.sql if the bucket is missing.`);
      setMessageTone("bad");
    } else {
      setMessage(`${files.length} photo${files.length === 1 ? "" : "s"} uploaded.`);
      setMessageTone("good");
    }
    await loadSupabaseData();
  }

  async function deleteBatchPhoto(photo: BatchPhoto) {
    if (!supabase || !session) {
      return;
    }

    // Older rows saved before storage_path existed don't have it -- fall back to deriving the
    // path from the public URL for those only. New uploads always carry storage_path directly.
    const marker = "/storage/v1/object/public/batch-photos/";
    const markerIndex = photo.photoUrl.indexOf(marker);
    const storagePath = photo.storagePath || (markerIndex >= 0 ? photo.photoUrl.slice(markerIndex + marker.length) : "");

    if (storagePath) {
      const { error: removeError } = await supabase.storage.from("batch-photos").remove([storagePath]);
      if (removeError) {
        setMessage(`Photo delete failed: ${removeError.message}`);
        setMessageTone("bad");
        return;
      }
    }

    const { error } = await supabase.from("batch_photos").delete().eq("id", photo.id);
    setMessage(error ? `Photo delete failed: ${error.message}` : "Photo deleted.");
    setMessageTone(error ? "bad" : "good");
    await loadSupabaseData();
  }

  async function saveCosting(formData: FormData) {
    const costingId = String(formData.get("id") || "");
    const productId = String(formData.get("productId"));
    const batchId = String(formData.get("batchId") || "");

    if (isBatchProductMismatch(labState.batches, { productId, batchId })) {
      setMessage("This batch does not belong to the selected product. Refresh and try again.");
      setMessageTone("bad");
      return;
    }

    const conflictingCosting = findConflictingCosting(labState.costings, { costingId, productId, batchId });
    if (conflictingCosting) {
      setMessage(`A costing for "${costingDisplayName(conflictingCosting, labState.products, labState.batches)}" already exists. Edit that record instead of saving a new one.`);
      setMessageTone("bad");
      return;
    }

    // Resolved once, here, before anything else -- threaded through the in-memory costing object
    // below, the Supabase payload (buildCostingSummaryPayload), and every Selling Format saved
    // alongside it, so all three always agree on this costing's id. See resolveCostingId's own
    // comment (src/lib/costing.ts) for why this replaced the inline `costingId || crypto.randomUUID()`
    // that used to live only in the costing object literal and never reached the Supabase payload.
    const costingSummaryId = resolveCostingId(costingId);
    const { sellingFormats, sellingFormatPackagingLines } = parseSellingFormatsFromFormData(formData, costingSummaryId);
    const sellingFormatValidationError = validateSellingFormatsForSave(sellingFormats, sellingFormatPackagingLines);
    if (sellingFormatValidationError) {
      setMessage(sellingFormatValidationError);
      setMessageTone("bad");
      return;
    }

    const ingredientRowIds = String(formData.get("ingredientRowIds") || "")
      .split(",")
      .filter(Boolean);
    const utilityRowIds = String(formData.get("utilityRowIds") || "")
      .split(",")
      .filter(Boolean);
    const packagingRowIds = String(formData.get("packagingRowIds") || "")
      .split(",")
      .filter(Boolean);
    const overheadRowIds = String(formData.get("overheadRowIds") || "")
      .split(",")
      .filter(Boolean);
    const equipmentUsageRowIds = String(formData.get("equipmentUsageRowIds") || "")
      .split(",")
      .filter(Boolean);
    const wasteRowIds = String(formData.get("wasteRowIds") || "")
      .split(",")
      .filter(Boolean);
    const ingredientRows: CostingEntry[] = ingredientRowIds
      .map((rowId) => {
        const brandName = String(formData.get(`ingredientBrand-${rowId}`) || "").trim();
        return {
          id: String(formData.get(`ingredientId-${rowId}`) || crypto.randomUUID()),
          productId,
          batchId,
          brandName,
          ingredientName: String(formData.get(`ingredientName-${rowId}`) || "").trim(),
          quantityUsed: Number(formData.get(`quantityUsed-${rowId}`) || 0),
          unit: String(formData.get(`unit-${rowId}`) || ""),
          cost: Number(formData.get(`ingredientCost-${rowId}`) || 0),
          supplierNote: buildCostingSupplierNote(brandName, String(formData.get(`supplierNote-${rowId}`) || "")),
        };
      })
      .filter((row) => row.ingredientName || row.cost > 0);
    const utilityRows = utilityRowIds
      .map((rowId) => ({
        name: String(formData.get(`utilityName-${rowId}`) || "").trim(),
        cost: Number(formData.get(`utilityCost-${rowId}`) || 0),
        note: String(formData.get(`utilityNote-${rowId}`) || "").trim(),
      }))
      .filter((row) => row.name || row.cost > 0);
    const utilityBuckets = utilityRows.reduce(
      (buckets, row) => {
        const label = row.name.toLowerCase();
        if (label.includes("water")) {
          buckets.waterCost += row.cost;
        } else if (label.includes("gas")) {
          buckets.gasCost += row.cost;
        } else if (label.includes("coffee") || label.includes("espresso") || label.includes("grinder") || label.includes("blender")) {
          buckets.coffeeEquipmentCost += row.cost;
        } else if (label.includes("refrig") || label.includes("chill") || label.includes("freezer")) {
          buckets.refrigerationCost += row.cost;
        } else {
          buckets.ovenElectricCost += row.cost;
        }
        return buckets;
      },
      { coffeeEquipmentCost: 0, gasCost: 0, ovenElectricCost: 0, refrigerationCost: 0, waterCost: 0 },
    );
    const ingredientCost = ingredientRows.reduce((total, row) => total + row.cost, 0);
    const packagingRows = packagingRowIds.map((rowId) => ({
      cost: Number(formData.get(`packagingCost-${rowId}`) || 0),
      name: String(formData.get(`packagingName-${rowId}`) || "").trim(),
      note: String(formData.get(`packagingNote-${rowId}`) || "").trim(),
      rowId,
    }));
    const overheadRows = overheadRowIds.map((rowId) => ({
      cost: Number(formData.get(`overheadCost-${rowId}`) || 0),
      name: String(formData.get(`overheadName-${rowId}`) || "").trim(),
      note: String(formData.get(`overheadNote-${rowId}`) || "").trim(),
      rowId,
    }));
    const equipmentUsage: EquipmentUsageRow[] = equipmentUsageRowIds
      .map((rowId) => ({
        equipmentId: String(formData.get(`equipmentUsageEquipmentId-${rowId}`) || ""),
        rowId,
        sharedBatches: Number(formData.get(`equipmentUsageSharedBatches-${rowId}`) || 1),
      }))
      .filter((row) => row.equipmentId);
    const formCookingMinutes = Number(formData.get("cookingMinutes") || 0);
    const equipmentAllocations = equipmentUsage.map((row) => {
      const equipmentItem = labState.equipment.find((item) => item.id === row.equipmentId);
      return equipmentItem ? getAllocatedEquipmentCost(equipmentItem, row.sharedBatches, formCookingMinutes) : { allocatedDepreciation: 0, allocatedMaintenance: 0, allocatedTotal: 0 };
    });
    const equipmentDepreciationCost = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedDepreciation, 0);
    const equipmentMaintenanceCost = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedMaintenance, 0);
    const wasteRows = wasteRowIds.map((rowId) => ({
      cost: Number(formData.get(`wasteCost-${rowId}`) || 0),
      name: String(formData.get(`wasteName-${rowId}`) || "").trim(),
      note: String(formData.get(`wasteNote-${rowId}`) || "").trim(),
      rowId,
    }));
    const laborDetail: CostingLaborDetail = {
      activeRate: Number(formData.get("activeLaborRate") || 0),
      cleaningMinutes: Number(formData.get("cleaningMinutes") || 0),
      cookingMinutes: Number(formData.get("cookingMinutes") || 0),
      coolingMinutes: Number(formData.get("coolingMinutes") || 0),
      packagingMinutes: Number(formData.get("packagingMinutes") || 0),
      prepMinutes: Number(formData.get("prepMinutes") || 0),
    };
    const gasDetail: CostingGasDetail = {
      equipmentName: String(formData.get("gasEquipmentName") || "").trim(),
      gasKg: Number(formData.get("gasKg") || 0),
      gasPrice: Number(formData.get("gasPrice") || 0),
      gasUseKgPerHour: Number(formData.get("gasUseKgPerHour") || 0),
    };
    const electricityDetail: CostingElectricityDetail = {
      applianceWatts: Number(formData.get("electricityWatts") || 0),
      equipmentName: String(formData.get("electricityEquipmentName") || "").trim(),
      minutes: Number(formData.get("electricityMinutes") || laborDetail.cookingMinutes || 0),
      ratePerKwh: Number(formData.get("electricityRatePerKwh") || 0),
    };
    const waterDetail: CostingWaterDetail = {
      litersUsed: Number(formData.get("waterLitersUsed") || 0),
      ratePerCubicMeter: Number(formData.get("waterRatePerCubicMeter") || 0),
    };
    const gasCostDetail = getGasCostDetail(gasDetail, laborDetail.cookingMinutes);
    const electricityCostDetail = getElectricityCostDetail(electricityDetail);
    const waterCostDetail = getWaterCostDetail(waterDetail);
    const activeLaborMinutes = laborDetail.prepMinutes + laborDetail.packagingMinutes + laborDetail.cleaningMinutes;
    const laborEstimate = (activeLaborMinutes / 60) * laborDetail.activeRate;
    const packagingCost = packagingRows.reduce((total, row) => total + row.cost, 0);
    const overheadCost = overheadRows.reduce((total, row) => total + row.cost, 0);
    const equipmentCost = equipmentDepreciationCost + equipmentMaintenanceCost;
    const wasteAllowance = wasteRows.reduce((total, row) => total + row.cost, 0);
    const targetFoodCost = Number(formData.get("targetFoodCost") || 0.35);
    const utilityNotes = utilityRows.length
      ? `Utilities: ${utilityRows.map((row) => `${row.name || "Unnamed"} ${row.cost}${row.note ? ` (${row.note})` : ""}`).join("; ")}`
      : "";
    const yieldNotes = Number(formData.get("costingYield") || 0) > 0 ? `Costing yield: ${Number(formData.get("costingYield") || 0)}` : "";
    const baseNotes = getCostingBaseNotes(String(formData.get("notes") || "").trim());
    const gasNotes = gasCostDetail.cost > 0
      ? `Gas: ${gasDetail.equipmentName || "Gas equipment"} / ${gasDetail.gasKg}kg refill / PHP ${gasDetail.gasPrice} / ${gasDetail.gasUseKgPerHour}kg per hour / PHP ${gasCostDetail.costPerMinute.toFixed(4)} per min / ${laborDetail.cookingMinutes} min`
      : "";
    const electricityNotes = electricityCostDetail.cost > 0
      ? `Electricity: ${electricityDetail.equipmentName || "Electric equipment"} / ${electricityDetail.applianceWatts}W / ${electricityDetail.minutes} min / PHP ${electricityDetail.ratePerKwh} per kWh`
      : "";
    const waterNotes = waterCostDetail.cost > 0
      ? `Water: ${waterDetail.litersUsed}L / PHP ${waterDetail.ratePerCubicMeter} per cubic meter`
      : "";
    const structuredNotes = buildCostingStructuredDetail({ electricityDetail, equipmentUsage, gasDetail, laborDetail, overheadRows, packagingRows, targetFoodCost, utilityRows, wasteRows, waterDetail });
    const costing: CostingSummary = {
      id: costingSummaryId,
      productId,
      batchId,
      ingredientCost,
      packagingCost,
      laborEstimate,
      waterCost: utilityBuckets.waterCost + waterCostDetail.cost,
      gasCost: utilityBuckets.gasCost + gasCostDetail.cost,
      ovenElectricCost: utilityBuckets.ovenElectricCost + electricityCostDetail.cost,
      refrigerationCost: utilityBuckets.refrigerationCost,
      coffeeEquipmentCost: utilityBuckets.coffeeEquipmentCost,
      wasteAllowance,
      overheadCost,
      equipmentCost,
      suggestedPrice: Number(formData.get("suggestedPrice") || 0),
      notes: [baseNotes, yieldNotes, utilityNotes, gasNotes, electricityNotes, waterNotes, structuredNotes].filter(Boolean).join("\n"),
    };
    if (supabase && session) {
      // Scoped by batch (not just product) so saving one batch's costing can't wipe the
      // ingredient rows belonging to a sibling costing for a different batch of the same
      // product. Legacy costings with no batch link fall back to the old product-only scope,
      // constrained to other rows that are also unlinked, for the same reason.
      const deleteQuery = supabase.from("costing_entries").delete();
      const scopedDeleteQuery = batchId ? deleteQuery.eq("batch_id", batchId) : deleteQuery.eq("product_id", productId).is("batch_id", null);
      const { error: deleteError } = await scopedDeleteQuery;
      if (deleteError) {
        setMessage(`Costing save failed: ${deleteError.message}`);
        setMessageTone("bad");
        return;
      }

      if (ingredientRows.length > 0) {
        const { error: ingredientError } = await supabase.from("costing_entries").insert(
          ingredientRows.map((row) => ({
            product_id: row.productId,
            batch_id: row.batchId || null,
            ingredient_name: row.ingredientName,
            quantity_used: row.quantityUsed,
            unit: row.unit,
            cost: row.cost,
            supplier_note: row.supplierNote,
          })),
        );

        if (ingredientError) {
          setMessage(`Costing save failed: ${ingredientError.message}`);
          setMessageTone("bad");
          return;
        }
      }

      const payload = buildCostingSummaryPayload(costing);
      const query = costingId
        ? supabase.from("costing_summaries").update(payload).eq("id", costingId)
        : supabase.from("costing_summaries").insert(payload);
      const { error } = await query;
      const duplicateMessage = "A costing for this batch already exists. Refresh and edit that record instead.";
      if (error) {
        setMessage(isDuplicateKeyError(error) ? duplicateMessage : `Costing save failed: ${error.message}`);
        setMessageTone("bad");
        await loadSupabaseData();
        return;
      }

      // Steps 4-7 (Selling Formats + their packaging lines) only run once the costing itself is
      // confirmed saved -- persisting a format against a costing that failed to save would attach
      // it to nothing. A failure from here on still leaves the costing itself saved, so every
      // message below says so explicitly rather than reusing the generic failure text above.
      const partialSaveSuffix = "Reopen and check before trusting these formats' cost.";
      const existingSellingFormats = labState.sellingFormats.filter((format) => format.costingId === costingSummaryId);
      const submittedFormatIds = sellingFormats.map((format) => format.id);
      const removedFormatIds = getRemovedSellingFormatIds(existingSellingFormats, submittedFormatIds);

      if (sellingFormats.length > 0) {
        const { error: formatsError } = await supabase.from("selling_formats").upsert(sellingFormats.map(buildSellingFormatPayload));
        if (formatsError) {
          setMessage(`Costing saved, but selling formats failed to save (${formatsError.message}). ${partialSaveSuffix}`);
          setMessageTone("bad");
          await loadSupabaseData();
          return;
        }
      }

      if (removedFormatIds.length > 0) {
        const { error: removeFormatsError } = await supabase.from("selling_formats").delete().in("id", removedFormatIds);
        if (removeFormatsError) {
          setMessage(`Costing saved, but a removed selling format could not be deleted (${removeFormatsError.message}). ${partialSaveSuffix}`);
          setMessageTone("bad");
          await loadSupabaseData();
          return;
        }
      }

      const existingLinesForKeptFormats = labState.sellingFormatPackagingLines.filter((line) => submittedFormatIds.includes(line.sellingFormatId));
      const submittedLineIds = sellingFormatPackagingLines.map((line) => line.id);
      const removedLineIds = getRemovedSellingFormatPackagingLineIds(existingLinesForKeptFormats, submittedLineIds);

      if (sellingFormatPackagingLines.length > 0) {
        const { error: linesError } = await supabase.from("selling_format_packaging_lines").upsert(sellingFormatPackagingLines.map(buildSellingFormatPackagingLinePayload));
        if (linesError) {
          setMessage(`Selling formats saved, but their packaging lines failed to save (${linesError.message}). ${partialSaveSuffix}`);
          setMessageTone("bad");
          await loadSupabaseData();
          return;
        }
      }

      if (removedLineIds.length > 0) {
        const { error: removeLinesError } = await supabase.from("selling_format_packaging_lines").delete().in("id", removedLineIds);
        if (removeLinesError) {
          setMessage(`Selling formats saved, but a removed packaging line could not be deleted (${removeLinesError.message}). ${partialSaveSuffix}`);
          setMessageTone("bad");
          await loadSupabaseData();
          return;
        }
      }

      setMessage(costingId ? "Costing updated." : "Costing saved.");
      setMessageTone("good");
      setEditingCosting(null);
      await loadSupabaseData();
      return;
    }
    const matchesThisCosting = (entry: { productId: string; batchId: string }) =>
      batchId ? entry.batchId === batchId : entry.productId === productId && !entry.batchId;
    const existingSellingFormatIdsForThisCostingLocal = labState.sellingFormats
      .filter((format) => format.costingId === costingSummaryId)
      .map((format) => format.id);
    setLabState((current) => ({
      ...current,
      costingEntries: [...ingredientRows, ...current.costingEntries.filter((entry) => !matchesThisCosting(entry))],
      costings: costingId ? current.costings.map((entry) => (entry.id === costingId ? costing : entry)) : [costing, ...current.costings.filter((entry) => !matchesThisCosting(entry))],
      sellingFormats: replaceSellingFormatsForCosting(current.sellingFormats, costingSummaryId, sellingFormats),
      sellingFormatPackagingLines: replaceSellingFormatPackagingLinesForCosting(current.sellingFormatPackagingLines, existingSellingFormatIdsForThisCostingLocal, sellingFormatPackagingLines),
    }));
    setEditingCosting(null);
    setMessage(costingId ? "Costing updated locally." : "Costing saved locally.");
    setMessageTone("good");
  }

  async function deleteCosting(costing: CostingSummary) {
    if (supabase && session) {
      const deleteQuery = supabase.from("costing_entries").delete();
      const scopedDeleteQuery = costing.batchId
        ? deleteQuery.eq("batch_id", costing.batchId)
        : deleteQuery.eq("product_id", costing.productId).is("batch_id", null);
      const { error: entryError } = await scopedDeleteQuery;
      if (entryError) {
        setMessage(`Costing delete failed: ${entryError.message}`);
        setMessageTone("bad");
        return;
      }
      const { error } = await supabase.from("costing_summaries").delete().eq("id", costing.id);
      setMessage(error ? `Costing delete failed: ${error.message}` : "Costing deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingCosting?.id === costing.id) {
        setEditingCosting(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => {
      // Supabase relies on selling_formats.costing_id's own "on delete cascade" to remove formats
      // and (transitively) their packaging lines when the costing itself is deleted -- no separate
      // delete call needed there. Local mode has no database to cascade for it, so it's done by
      // hand here, scoped the same way -- deleting is "replace with nothing."
      const removedFormatIds = current.sellingFormats.filter((format) => format.costingId === costing.id).map((format) => format.id);
      return {
        ...current,
        costingEntries: current.costingEntries.filter((entry) =>
          costing.batchId ? entry.batchId !== costing.batchId : !(entry.productId === costing.productId && !entry.batchId)),
        costings: current.costings.filter((entry) => entry.id !== costing.id),
        sellingFormats: replaceSellingFormatsForCosting(current.sellingFormats, costing.id, []),
        sellingFormatPackagingLines: replaceSellingFormatPackagingLinesForCosting(current.sellingFormatPackagingLines, removedFormatIds, []),
      };
    });
    if (editingCosting?.id === costing.id) {
      setEditingCosting(null);
    }
    setMessage("Costing deleted locally.");
    setMessageTone("good");
  }

  // Manual "Log a Purchase" used to only write supply_entries -- it never updated
  // ingredients.current_quantity/average_unit_cost or wrote a ledger row, unlike CSV import and
  // Bake. applySupplyPurchaseEffect/planSupplyEdit (src/lib/supply-inventory-effect.ts) now decide
  // the inventory-side effect the same way those two paths already do (converting into the
  // ingredient's own canonical unit first); save_supply_with_inventory_effect (in
  // supabase-add-manual-purchase-inventory-effect.sql) persists supply_entries, the ingredient
  // update, and the ledger row together as one atomic transaction.
  async function saveSupply(formData: FormData) {
    const supplyId = String(formData.get("id") || "");
    const ingredientId = String(formData.get("ingredientId") || "").trim();
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      setMessage("Choose an Item before saving this purchase.");
      setMessageTone("bad");
      return;
    }

    const previousSupply = supplyId ? labState.supplies.find((entry) => entry.id === supplyId) : undefined;
    if (previousSupply && previousSupply.ingredientId && previousSupply.ingredientId !== ingredientId) {
      setMessage("Changing which Item a purchase belongs to isn't supported. Delete this purchase and log it again under the new Item.");
      setMessageTone("bad");
      return;
    }

    const supply: SupplyEntry = {
      id: supplyId || crypto.randomUUID(),
      ingredientId,
      ingredientName: ingredient?.name ?? String(formData.get("ingredientName") || "").trim(),
      brandName: String(formData.get("brandName") || "").trim(),
      supplierName: String(formData.get("supplierName") || "").trim(),
      purchaseDate: String(formData.get("purchaseDate") || getToday()),
      createdAt: new Date().toISOString(),
      packQuantity: Number(formData.get("packQuantity") || 0),
      unit: String(formData.get("unit") || "").trim(),
      totalCost: Number(formData.get("totalCost") || 0),
      qualityRating: Number(formData.get("qualityRating") || 0),
      notes: String(formData.get("notes") || "").trim(),
    };

    const today = new Date().toISOString();
    let ingredientUpdate: Ingredient | null = null;
    let transactionUpsert: InventoryTransaction | null = null;
    let historicalCostWarning = "";

    if (!previousSupply) {
      const effect = applySupplyPurchaseEffect(ingredient, supply, supply.id, today);
      if ("error" in effect) {
        setMessage(effect.error);
        setMessageTone("bad");
        return;
      }
      ingredientUpdate = effect.ingredient;
      transactionUpsert = effect.transaction;
    } else {
      const plan = planSupplyEdit(ingredient, previousSupply, supply, labState.inventoryTransactions, today);
      if (plan.kind === "error") {
        setMessage(plan.message);
        setMessageTone("bad");
        return;
      }
      if (plan.kind === "recalculated") {
        ingredientUpdate = plan.ingredient;
        transactionUpsert = plan.transaction;
      } else if (plan.kind === "quantity-only") {
        ingredientUpdate = plan.ingredient;
        historicalCostWarning = plan.warning;
      }
      // "not-applied": this purchase never affected inventory (e.g. logged before this fix
      // shipped) -- ingredientUpdate/transactionUpsert stay null; only supply_entries changes.
    }

    if (supabase && session) {
      const { error } = await supabase.rpc("save_supply_with_inventory_effect", {
        p_supply_id: supply.id,
        p_is_new_supply: !supplyId,
        p_supply: {
          ingredient_id: supply.ingredientId || null,
          ingredient_name: supply.ingredientName,
          brand_name: supply.brandName,
          supplier_name: supply.supplierName,
          purchase_date: supply.purchaseDate,
          pack_quantity: supply.packQuantity,
          unit: supply.unit,
          total_cost: supply.totalCost,
          quality_rating: supply.qualityRating,
          notes: supply.notes,
        },
        p_ingredient_update: ingredientUpdate ? { id: ingredientUpdate.id, current_quantity: ingredientUpdate.currentQuantity, average_unit_cost: ingredientUpdate.averageUnitCost } : null,
        p_transaction_upsert: transactionUpsert ? toInventoryTransactionRow(transactionUpsert) : null,
      });
      const missingPurchaseColumn = Boolean(error && isMissingColumnError(error));
      setMessage(
        error
          ? missingPurchaseColumn
            ? `Purchase save failed because supply_entries is missing a required purchase column. Run supabase-add-supplies.sql in Supabase, then retry. Details: ${error.message}`
            : `Purchase save failed: ${describeIngredientConstraintError(error)}`
          : historicalCostWarning
            ? `Purchase saved. ${historicalCostWarning}`
            : "Purchase saved.",
      );
      setMessageTone(error ? "bad" : "good");
      setIsSuppliesTableMissing(Boolean(error?.message.includes("supply_entries") || error?.message.includes("brand_name") || error?.message.includes("ingredient_id")));
      if (!error) {
        setEditingSupply(null);
        await loadSupabaseData();
      }
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: ingredientUpdate ? current.ingredients.map((item) => (item.id === ingredientUpdate!.id ? ingredientUpdate! : item)) : current.ingredients,
      inventoryTransactions: transactionUpsert
        ? [transactionUpsert, ...current.inventoryTransactions.filter((entry) => entry.id !== transactionUpsert!.id)]
        : current.inventoryTransactions,
      supplies: supplyId ? current.supplies.map((entry) => (entry.id === supplyId ? supply : entry)) : [supply, ...current.supplies],
    }));
    setEditingSupply(null);
    setMessage(historicalCostWarning ? `Purchase saved locally. ${historicalCostWarning}` : "Purchase saved locally.");
    setMessageTone("good");
  }

  async function deleteSupply(supplyId: string) {
    const previousSupply = labState.supplies.find((entry) => entry.id === supplyId);
    const ingredient = previousSupply ? labState.ingredients.find((item) => item.id === previousSupply.ingredientId) : undefined;

    let ingredientUpdate: Ingredient | null = null;
    let transactionIdToRemove: string | null = null;
    let historicalCostWarning = "";

    if (previousSupply && ingredient) {
      const plan = planSupplyDelete(ingredient, previousSupply, labState.inventoryTransactions);
      if (plan.kind === "error") {
        setMessage(plan.message);
        setMessageTone("bad");
        return;
      }
      if (plan.kind === "reversed") {
        ingredientUpdate = plan.ingredient;
        transactionIdToRemove = plan.transactionIdToRemove;
      } else if (plan.kind === "quantity-only") {
        ingredientUpdate = plan.ingredient;
        historicalCostWarning = plan.warning;
      }
      // "not-applied": nothing to reverse.
    }

    if (supabase && session) {
      const { error } = await supabase.rpc("delete_supply_with_inventory_effect", {
        p_supply_id: supplyId,
        p_ingredient_update: ingredientUpdate ? { id: ingredientUpdate.id, current_quantity: ingredientUpdate.currentQuantity, average_unit_cost: ingredientUpdate.averageUnitCost } : null,
        p_transaction_id_to_remove: transactionIdToRemove,
      });
      setMessage(error ? `Purchase delete failed: ${describeIngredientConstraintError(error)}` : historicalCostWarning ? `Purchase deleted. ${historicalCostWarning}` : "Purchase deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingSupply?.id === supplyId) {
        setEditingSupply(null);
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: ingredientUpdate ? current.ingredients.map((item) => (item.id === ingredientUpdate!.id ? ingredientUpdate! : item)) : current.ingredients,
      inventoryTransactions: transactionIdToRemove ? current.inventoryTransactions.filter((entry) => entry.id !== transactionIdToRemove) : current.inventoryTransactions,
      supplies: current.supplies.filter((entry) => entry.id !== supplyId),
    }));
    if (editingSupply?.id === supplyId) {
      setEditingSupply(null);
    }
    setMessage(historicalCostWarning ? `Purchase deleted locally. ${historicalCostWarning}` : "Purchase deleted locally.");
    setMessageTone("good");
  }

  function describeSupplyRepairResult(result: SupplyRepairResult): string {
    const parts: string[] = [];
    if (result.changedIngredients.length > 0) {
      parts.push(`Backfilled ${result.transactions.length} purchase${result.transactions.length === 1 ? "" : "s"} across ${result.changedIngredients.length} Item${result.changedIngredients.length === 1 ? "" : "s"}.`);
    }
    if (result.unconvertible.length > 0) {
      parts.push(`${result.unconvertible.length} purchase${result.unconvertible.length === 1 ? "" : "s"} could not be converted and were left untouched -- check the unit on those purchases.`);
    }
    return parts.join(" ") || "Nothing to repair -- every Item's purchase history is already reflected in inventory.";
  }

  // Explicit, operator-triggered only -- never run automatically on load. This will produce a
  // real, one-time jump in current_quantity/average_unit_cost for any Item whose entire purchase
  // history is manual (never touched by CSV import or Bake, since manual purchases never affected
  // inventory before this fix). The summary this reports is for the operator to sanity-check
  // against physical stock before trusting the new numbers, not just a confirmation toast.
  async function repairSupplyInventoryEffects() {
    const today = new Date().toISOString();
    const result = repairMissingSupplyInventoryEffects(labState.ingredients, labState.supplies, labState.inventoryTransactions, today);

    if (result.changedIngredients.length === 0 && result.unconvertible.length === 0) {
      setMessage(describeSupplyRepairResult(result));
      setMessageTone("good");
      return;
    }

    if (supabase && session) {
      const { error } = await supabase.rpc("repair_supply_inventory_effects", {
        p_ingredient_updates: result.changedIngredients.map((ingredient) => ({ id: ingredient.id, current_quantity: ingredient.currentQuantity, average_unit_cost: ingredient.averageUnitCost })),
        p_transactions: result.transactions.map((transaction) => toInventoryTransactionRow(transaction)),
      });

      if (error) {
        setMessage(`Repair failed: ${describeIngredientConstraintError(error)}`);
        setMessageTone("bad");
        return;
      }

      setMessage(describeSupplyRepairResult(result));
      setMessageTone(result.unconvertible.length > 0 ? "bad" : "good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient) => result.changedIngredients.find((updated) => updated.id === ingredient.id) ?? ingredient),
      inventoryTransactions: [...result.transactions, ...current.inventoryTransactions],
    }));
    setMessage(describeSupplyRepairResult(result));
    setMessageTone(result.unconvertible.length > 0 ? "bad" : "good");
  }

  // Stock moved outside baking -- household use, waste/spoilage, a recipe test, spillage, a
  // stock-count correction, or anything else. Deliberately parallel to Bake (see
  // src/lib/stock-adjustment.ts): normalizes the entered unit, respects the same negative-stock
  // policy, and never touches averageUnitCost, recipe usage, or batch costing.
  async function adjustStock(ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      setMessage("Item not found.");
      setMessageTone("bad");
      return;
    }

    const actor = session?.user?.email ?? null;
    const result = applyStockAdjustment({ ingredient, quantity, unit, reason, direction, note, actor, allowNegative, today: new Date().toISOString() });

    if ("error" in result) {
      setMessage(result.error);
      setMessageTone("bad");
      return;
    }

    const { ingredient: updatedIngredient, transaction } = result;

    if (supabase && session) {
      const { error } = await supabase.rpc("apply_inventory_adjustment", {
        p_ingredient_update: { id: updatedIngredient.id, current_quantity: updatedIngredient.currentQuantity },
        p_transaction: toInventoryTransactionRow(transaction),
      });

      if (error) {
        setMessage(`Stock adjustment failed: ${describeIngredientConstraintError(error)}`);
        setMessageTone("bad");
        return;
      }

      setMessage("Stock adjustment recorded.");
      setMessageTone("good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: current.ingredients.map((item) => (item.id === updatedIngredient.id ? updatedIngredient : item)),
      inventoryTransactions: [transaction, ...current.inventoryTransactions],
    }));
    setMessage("Stock adjustment recorded locally.");
    setMessageTone("good");
  }

  // Reverses an adjustment by submitting another one (see reverseStockAdjustment's own comment) --
  // never deletes or edits the original ledger row.
  async function reverseInventoryAdjustment(transactionId: string) {
    const originalTransaction = labState.inventoryTransactions.find((entry) => entry.id === transactionId);
    if (!originalTransaction) {
      setMessage("Adjustment not found.");
      setMessageTone("bad");
      return;
    }
    const ingredient = labState.ingredients.find((item) => item.id === originalTransaction.ingredientId);
    if (!ingredient) {
      setMessage("Item not found.");
      setMessageTone("bad");
      return;
    }

    const actor = session?.user?.email ?? null;
    const result = reverseStockAdjustment(ingredient, originalTransaction, actor, new Date().toISOString());

    if ("error" in result) {
      setMessage(result.error);
      setMessageTone("bad");
      return;
    }

    const { ingredient: updatedIngredient, transaction } = result;

    if (supabase && session) {
      const { error } = await supabase.rpc("apply_inventory_adjustment", {
        p_ingredient_update: { id: updatedIngredient.id, current_quantity: updatedIngredient.currentQuantity },
        p_transaction: toInventoryTransactionRow(transaction),
      });

      if (error) {
        setMessage(`Reversal failed: ${describeIngredientConstraintError(error)}`);
        setMessageTone("bad");
        return;
      }

      setMessage("Adjustment reversed.");
      setMessageTone("good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: current.ingredients.map((item) => (item.id === updatedIngredient.id ? updatedIngredient : item)),
      inventoryTransactions: [transaction, ...current.inventoryTransactions],
    }));
    setMessage("Adjustment reversed locally.");
    setMessageTone("good");
  }

  // currentQuantity is only user-editable on the create path (see InventoryPage) -- on an
  // existing ingredient the form submits a hidden input carrying the unchanged value, so this
  // never doubles as a way to silently correct stock outside a ledgered purchase/bake flow.
  //
  // Returns the saved ingredient's id (or null on failure) -- the id is generated client-side and
  // sent explicitly on insert (matching how createPurchaseImportDraft already generates its own
  // id up front), so a caller that needs to act on the new ingredient immediately -- e.g. the CSV
  // importer's "Create New Item", which auto-assigns the current row to it -- doesn't have to wait
  // for a reload/refetch to learn the id.
  async function saveIngredient(formData: FormData): Promise<string | null> {
    const ingredientId = String(formData.get("id") || "");
    const savedId = ingredientId || crypto.randomUUID();
    const existingIngredient = labState.ingredients.find((item) => item.id === ingredientId);
    const ingredient: Ingredient = {
      id: savedId,
      name: String(formData.get("name") || "").trim(),
      baseUnit: String(formData.get("baseUnit") || "g").trim() as Ingredient["baseUnit"],
      category: String(formData.get("category") || "").trim() as Ingredient["category"],
      currentQuantity: Number(formData.get("currentQuantity") || 0),
      lowStockThreshold: Number(formData.get("lowStockThreshold") || 0),
      targetStockQuantity: Number(formData.get("targetStockQuantity") || 0),
      nearestExpirationDate: String(formData.get("nearestExpirationDate") || "").trim(),
      averageUnitCost: Number(formData.get("averageUnitCost") || 0),
      notes: String(formData.get("notes") || "").trim(),
      isActive: existingIngredient?.isActive ?? true,
      archivedAt: existingIngredient?.archivedAt ?? "",
    };

    if (supabase && session) {
      const payload = {
        name: ingredient.name,
        base_unit: ingredient.baseUnit,
        category: ingredient.category || null,
        current_quantity: ingredient.currentQuantity,
        low_stock_threshold: ingredient.lowStockThreshold,
        target_stock_quantity: ingredient.targetStockQuantity,
        nearest_expiration_date: ingredient.nearestExpirationDate || null,
        average_unit_cost: ingredient.averageUnitCost || null,
        notes: ingredient.notes,
        is_active: ingredient.isActive,
        archived_at: ingredient.archivedAt || null,
      };
      const query = ingredientId ? supabase.from("ingredients").update(payload).eq("id", ingredientId) : supabase.from("ingredients").insert({ id: savedId, ...payload });
      const { error } = await query;
      const missingCategoryColumn = isMissingColumnError(error) && Boolean(error?.message.includes("category"));
      setMessage(
        error
          ? missingCategoryColumn
            ? `Ingredient save failed: run supabase-add-ingredient-category.sql once, then save again. (${error.message})`
            : `Ingredient save failed. Run supabase-add-inventory.sql first if this is your first time: ${describeIngredientConstraintError(error)}`
          : "Ingredient saved."
      );
      setMessageTone(error ? "bad" : "good");
      setIsInventoryTableMissing(Boolean(error?.message.includes("ingredients")) && !missingCategoryColumn);
      if (!error) {
        setEditingIngredient(null);
        await loadSupabaseData();
        return savedId;
      }
      return null;
    }

    setLabState((current) => ({
      ...current,
      ingredients: ingredientId ? current.ingredients.map((entry) => (entry.id === ingredientId ? ingredient : entry)) : [ingredient, ...current.ingredients],
    }));
    setEditingIngredient(null);
    setMessage("Ingredient saved locally.");
    setMessageTone("good");
    return savedId;
  }

  async function deleteIngredient(ingredientId: string) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      setMessage("Ingredient not found.");
      setMessageTone("bad");
      return;
    }
    const archived = archiveItem(ingredient, new Date().toISOString());
    if (supabase && session) {
      const { error } = await supabase.from("ingredients").update({ is_active: false, archived_at: archived.archivedAt || null }).eq("id", ingredientId);
      setMessage(error ? `Ingredient archive failed: ${describeIngredientConstraintError(error)}` : "Ingredient archived. History is preserved.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingIngredient?.id === ingredientId) {
        setEditingIngredient(null);
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({ ...current, ingredients: current.ingredients.map((entry) => (entry.id === ingredientId ? archived : entry)) }));
    if (editingIngredient?.id === ingredientId) {
      setEditingIngredient(null);
    }
    setMessage("Ingredient archived locally. History is preserved.");
    setMessageTone("good");
  }

  async function restoreIngredient(ingredientId: string) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      setMessage("Ingredient not found.");
      setMessageTone("bad");
      return;
    }
    const restored = restoreItem(ingredient);
    if (supabase && session) {
      const { error } = await supabase.from("ingredients").update({ is_active: true, archived_at: null }).eq("id", ingredientId);
      setMessage(error ? `Ingredient restore failed: ${describeIngredientConstraintError(error)}` : "Ingredient restored.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, ingredients: current.ingredients.map((entry) => (entry.id === ingredientId ? restored : entry)) }));
    setMessage("Ingredient restored locally.");
    setMessageTone("good");
  }

  async function hardDeleteIngredient(ingredientId: string) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      setMessage("Ingredient not found.");
      setMessageTone("bad");
      return;
    }
    const summary = getItemReferenceSummary({
      ingredient,
      supplies: labState.supplies,
      inventoryTransactions: labState.inventoryTransactions,
      ingredientAliases: labState.ingredientAliases,
      purchaseImportRows: labState.purchaseImportRows,
      batches: labState.batches,
      costingEntries: labState.costingEntries,
    });
    if (!canHardDeleteItem(summary)) {
      setMessage(`Permanent delete blocked. ${ingredient.name} has ${itemReferenceCount(summary)} reference${itemReferenceCount(summary) === 1 ? "" : "s"}. Archive keeps history intact.`);
      setMessageTone("bad");
      return;
    }
    if (supabase && session) {
      const { error } = await supabase.from("ingredients").delete().eq("id", ingredientId);
      setMessage(error ? `Permanent delete failed: ${error.message}` : "Ingredient permanently deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingIngredient?.id === ingredientId) {
        setEditingIngredient(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, ingredients: current.ingredients.filter((entry) => entry.id !== ingredientId) }));
    if (editingIngredient?.id === ingredientId) {
      setEditingIngredient(null);
    }
    setMessage("Ingredient permanently deleted locally.");
    setMessageTone("good");
  }

  // An alias is "raw text -> ingredient id" regardless of whether the raw text came from a
  // receipt row or (in a later milestone) a bake formula ingredient name -- one shared save
  // path, insert-or-update by raw text rather than a DB-level upsert (avoids fighting
  // Postgres/PostgREST's ON CONFLICT target matching against the case-insensitive unique index).
  async function saveIngredientAlias(rawText: string, ingredientId: string, source: string) {
    const alias = buildAliasRecord(rawText, ingredientId, source);
    if (!alias.rawText || !alias.ingredientId) {
      return;
    }
    const existingAlias = labState.ingredientAliases.find((entry) => entry.rawText.trim().toLowerCase() === alias.rawText.toLowerCase());

    if (supabase && session) {
      const payload = { raw_text: alias.rawText, normalized_text: alias.normalizedText, ingredient_id: alias.ingredientId, source: alias.source };
      const query = existingAlias
        ? supabase.from("ingredient_aliases").update(payload).eq("id", existingAlias.id)
        : supabase.from("ingredient_aliases").insert(payload);
      const { error } = await query;
      if (error) {
        setMessage(`Could not save ingredient alias: ${error.message}`);
        setMessageTone("bad");
        return;
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredientAliases: existingAlias
        ? current.ingredientAliases.map((entry) => (entry.id === existingAlias.id ? { ...entry, ingredientId: alias.ingredientId, source: alias.source } : entry))
        : [{ id: crypto.randomUUID(), rawText: alias.rawText, normalizedText: alias.normalizedText, ingredientId: alias.ingredientId, source: alias.source }, ...current.ingredientAliases],
    }));
  }

  // Persists a draft (header + rows) as soon as the operator finishes CSV upload + column
  // mapping -- this only ever writes to purchase_imports/purchase_import_rows, never to
  // `ingredients`, so CSV preview cannot change inventory even in principle (the only function
  // that touches ingredient quantities is applyPurchaseImportConfirmation, called only from
  // confirmPurchaseImport below). Returns the new import's id so the wizard can show its preview.
  async function createPurchaseImportDraft(fileName: string, rowDrafts: PurchaseImportRowDraft[], importSupplierName: string, importReceiptNumber: string, importPurchaseDate: string): Promise<string | null> {
    const importId = crypto.randomUUID();
    const totalValue = rowDrafts.reduce((sum, row) => sum + (row.rowStatus !== "excluded" ? row.parsedTotalPrice : 0), 0);

    if (supabase && session) {
      const { error: importError } = await supabase.from("purchase_imports").insert({
        id: importId,
        file_name: fileName,
        status: "draft",
        row_count: rowDrafts.length,
        total_value: totalValue,
        supplier_name: importSupplierName || null,
        receipt_number: importReceiptNumber || null,
        purchase_date: importPurchaseDate || null,
      });
      if (importError) {
        setMessage(`Could not start import: ${importError.message}`);
        setMessageTone("bad");
        setIsInventoryTableMissing(Boolean(importError.message.includes("purchase_imports")));
        setIsPurchaseImportPackagesMissing(isMissingColumnError(importError));
        return null;
      }

      const { error: rowsError } = await supabase.from("purchase_import_rows").insert(
        rowDrafts.map((row) => ({
          import_id: importId,
          row_index: row.rowIndex,
          raw_item_name: row.rawItemName,
          raw_brand: row.rawBrand,
          raw_quantity: row.rawQuantity,
          raw_unit: row.rawUnit,
          raw_total_price: row.rawTotalPrice,
          raw_expiration_date: row.rawExpirationDate,
          raw_package_count: row.rawPackageCount,
          raw_package_size: row.rawPackageSize,
          raw_package_unit: row.rawPackageUnit,
          raw_unit_price: row.rawUnitPrice,
          raw_category: row.rawCategory,
          raw_supplier: row.rawSupplier,
          raw_receipt_number: row.rawReceiptNumber,
          raw_purchase_date: row.rawPurchaseDate,
          parsed_quantity: row.parsedQuantity,
          parsed_total_price: row.parsedTotalPrice,
          parsed_expiration_date: row.parsedExpirationDate || null,
          parsed_package_count: row.parsedPackageCount,
          parsed_package_size: row.parsedPackageSize,
          parsed_unit_price: row.parsedUnitPrice,
          ingredient_id: row.ingredientId || null,
          match_method: row.matchMethod,
          converted_quantity: row.convertedQuantity,
          is_quantity_overridden: row.isQuantityOverridden,
          brand_name: row.brandName,
          row_status: row.rowStatus,
          exclude_reason: row.excludeReason,
          validation_errors: row.validationErrors,
        })),
      );
      if (rowsError) {
        setMessage(`Could not save import rows: ${rowsError.message}`);
        setMessageTone("bad");
        setIsPurchaseImportPackagesMissing(isMissingColumnError(rowsError));
        return null;
      }

      await loadSupabaseData();
      return importId;
    }

    const newImport: PurchaseImport = {
      id: importId,
      fileName,
      status: "draft",
      importedAt: "",
      rowCount: rowDrafts.length,
      totalValue,
      supplierName: importSupplierName,
      receiptNumber: importReceiptNumber,
      purchaseDate: importPurchaseDate,
    };
    const newRows: PurchaseImportRow[] = rowDrafts.map((row) => ({ ...row, id: crypto.randomUUID(), importId }));
    setLabState((current) => ({
      ...current,
      purchaseImports: [newImport, ...current.purchaseImports],
      purchaseImportRows: [...newRows, ...current.purchaseImportRows],
    }));
    return importId;
  }

  async function updatePurchaseImportRow(rowId: string, changes: Partial<PurchaseImportRow>) {
    if (supabase && session) {
      const payload: Record<string, unknown> = {};
      if (changes.rawItemName !== undefined) payload.raw_item_name = changes.rawItemName;
      if (changes.rawBrand !== undefined) payload.raw_brand = changes.rawBrand;
      if (changes.rawCategory !== undefined) payload.raw_category = changes.rawCategory;
      if (changes.rawPackageCount !== undefined) payload.raw_package_count = changes.rawPackageCount;
      if (changes.rawPackageSize !== undefined) payload.raw_package_size = changes.rawPackageSize;
      if (changes.rawPackageUnit !== undefined) payload.raw_package_unit = changes.rawPackageUnit;
      if (changes.rawUnitPrice !== undefined) payload.raw_unit_price = changes.rawUnitPrice;
      if (changes.rawSupplier !== undefined) payload.raw_supplier = changes.rawSupplier;
      if (changes.rawReceiptNumber !== undefined) payload.raw_receipt_number = changes.rawReceiptNumber;
      if (changes.rawPurchaseDate !== undefined) payload.raw_purchase_date = changes.rawPurchaseDate;
      if (changes.parsedQuantity !== undefined) payload.parsed_quantity = changes.parsedQuantity;
      if (changes.parsedTotalPrice !== undefined) payload.parsed_total_price = changes.parsedTotalPrice;
      if (changes.parsedPackageCount !== undefined) payload.parsed_package_count = changes.parsedPackageCount;
      if (changes.parsedPackageSize !== undefined) payload.parsed_package_size = changes.parsedPackageSize;
      if (changes.parsedUnitPrice !== undefined) payload.parsed_unit_price = changes.parsedUnitPrice;
      if (changes.ingredientId !== undefined) payload.ingredient_id = changes.ingredientId || null;
      if (changes.matchMethod !== undefined) payload.match_method = changes.matchMethod;
      if (changes.convertedQuantity !== undefined) payload.converted_quantity = changes.convertedQuantity;
      if (changes.isQuantityOverridden !== undefined) payload.is_quantity_overridden = changes.isQuantityOverridden;
      if (changes.brandName !== undefined) payload.brand_name = changes.brandName;
      if (changes.rowStatus !== undefined) payload.row_status = changes.rowStatus;
      if (changes.excludeReason !== undefined) payload.exclude_reason = changes.excludeReason;

      const { error } = await supabase.from("purchase_import_rows").update(payload).eq("id", rowId);
      if (error) {
        setMessage(`Could not update row: ${error.message}`);
        setMessageTone("bad");
        setIsPurchaseImportPackagesMissing(isMissingColumnError(error));
        return;
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      purchaseImportRows: current.purchaseImportRows.map((row) => (row.id === rowId ? { ...row, ...changes } : row)),
    }));
  }

  // Header-only update (supplier/receipt number/purchase date), separate from updatePurchaseImportRow
  // since it targets purchase_imports, not purchase_import_rows.
  async function updatePurchaseImportHeader(importId: string, changes: { supplierName?: string; receiptNumber?: string; purchaseDate?: string }) {
    if (supabase && session) {
      const payload: Record<string, unknown> = {};
      if (changes.supplierName !== undefined) payload.supplier_name = changes.supplierName;
      if (changes.receiptNumber !== undefined) payload.receipt_number = changes.receiptNumber;
      if (changes.purchaseDate !== undefined) payload.purchase_date = changes.purchaseDate || null;

      const { error } = await supabase.from("purchase_imports").update(payload).eq("id", importId);
      if (error) {
        setMessage(`Could not update import details: ${error.message}`);
        setMessageTone("bad");
        setIsPurchaseImportPackagesMissing(isMissingColumnError(error));
        return;
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      purchaseImports: current.purchaseImports.map((item) => (item.id === importId ? { ...item, ...changes } : item)),
    }));
  }

  async function discardPurchaseImport(importId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("purchase_imports").update({ status: "discarded" }).eq("id", importId);
      setMessage(error ? `Could not discard import: ${error.message}` : "Import discarded.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      purchaseImports: current.purchaseImports.map((item) => (item.id === importId ? { ...item, status: "discarded" } : item)),
    }));
    setMessage("Import discarded locally.");
    setMessageTone("good");
  }

  // The only place a purchase import can change `ingredients` quantities. Guards against
  // applying twice: bails immediately unless the import's current status is still "draft" (the
  // Supabase path below re-checks the same guard against the real row, inside the atomic RPC, as
  // defense against a stale client or a second browser tab) -- a page refresh never re-triggers
  // this function on its own (nothing in loadSupabaseData calls it), so a reload cannot reapply
  // an already-confirmed import.
  async function confirmPurchaseImport(importId: string) {
    const purchaseImport = labState.purchaseImports.find((item) => item.id === importId);
    if (!purchaseImport) {
      setMessage("Import not found.");
      setMessageTone("bad");
      return;
    }
    if (purchaseImport.status !== "draft") {
      setMessage("This import has already been confirmed or discarded.");
      setMessageTone("bad");
      return;
    }

    const rows = labState.purchaseImportRows.filter((row) => row.importId === importId) as unknown as PurchaseImportRowDraft[];
    const today = new Date().toISOString();
    const result = applyPurchaseImportConfirmation({ ingredients: labState.ingredients, rows, importId, today });

    if ("error" in result) {
      setMessage(result.error);
      setMessageTone("bad");
      return;
    }

    // A second, independent computation from the inventory-quantity one above -- see
    // buildSupplyEntriesFromPurchaseImport's own comment for why it's kept separate. Computed
    // (and any error surfaced) before anything is written, so a missing brand blocks the whole
    // confirm the same way an unresolved row already does, not a partial apply.
    const supplyEntriesResult = buildSupplyEntriesFromPurchaseImport({
      rows,
      ingredients: labState.ingredients,
      importSupplierName: purchaseImport.supplierName,
      importReceiptNumber: purchaseImport.receiptNumber,
      importPurchaseDate: purchaseImport.purchaseDate,
      today,
    });

    if ("error" in supplyEntriesResult) {
      setMessage(supplyEntriesResult.error);
      setMessageTone("bad");
      return;
    }

    const { ingredients: updatedIngredients, transactions } = result;
    const { supplyEntries } = supplyEntriesResult;
    const changedIngredientIds = new Set(transactions.map((transaction) => transaction.ingredientId));
    const changedIngredients = updatedIngredients.filter((ingredient) => changedIngredientIds.has(ingredient.id));

    if (supabase && session) {
      // One atomic Postgres transaction (confirm_purchase_import in supabase-add-inventory.sql /
      // supabase-add-purchase-import-packages.sql) applies every ingredient update, every ledger
      // insert, every supply_entries insert, and the import's status flip together -- replacing
      // the sequential .update()/.insert() calls Milestones 2-4 used. The RPC persists exactly
      // what applyPurchaseImportConfirmation/buildSupplyEntriesFromPurchaseImport already computed
      // above; it does not recompute or re-derive any business rule.
      const { error } = await supabase.rpc("confirm_purchase_import", {
        p_import_id: importId,
        p_ingredient_updates: changedIngredients.map((ingredient) => ({
          id: ingredient.id,
          current_quantity: ingredient.currentQuantity,
          average_unit_cost: ingredient.averageUnitCost || null,
          nearest_expiration_date: ingredient.nearestExpirationDate || null,
        })),
        p_transactions: transactions.map((transaction) => toInventoryTransactionRow(transaction)),
        p_supply_entries: supplyEntries.map((entry) => toSupplyEntryRow(entry)),
      });

      if (error) {
        setMessage(`Import confirm failed: ${describeIngredientConstraintError(error)}`);
        setMessageTone("bad");
        setIsPurchaseImportPackagesMissing(isMissingColumnError(error));
        return;
      }

      setMessage("Purchase import confirmed. Inventory and supplier prices updated.");
      setMessageTone("good");
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient) => changedIngredients.find((updated) => updated.id === ingredient.id) ?? ingredient),
      inventoryTransactions: [...transactions, ...current.inventoryTransactions],
      supplies: [...supplyEntries, ...current.supplies],
      purchaseImports: current.purchaseImports.map((item) => (item.id === importId ? { ...item, status: "confirmed", importedAt: new Date().toISOString() } : item)),
    }));
    setMessage("Purchase import confirmed locally. Inventory and supplier prices updated.");
    setMessageTone("good");
  }

  // The only place a bake can change `ingredients` quantities. Unlike purchase import, there is
  // no persisted "draft" row to guard against reapplying on refresh -- a bake's selection
  // (batch, multiplier, resolved rows) lives only in BakePage's own component state until this
  // function is called, so a reload simply loses the in-progress selection with nothing to
  // reapply. The re-entrancy risk this function does face is a fast double-click firing it twice
  // before the first call's response lands -- guarded synchronously in BakePage itself
  // (handleConfirm's isConfirming check), the same pattern used for Confirm Import.
  async function confirmBake(batchId: string, batchLabel: string, multiplier: number, deductions: BakeDeduction[], allowNegative: boolean) {
    const result = applyBakeConfirmation({ ingredients: labState.ingredients, deductions, batchId, batchLabel, multiplier, allowNegative, today: new Date().toISOString() });

    if ("error" in result) {
      setMessage(result.error);
      setMessageTone("bad");
      return;
    }

    const { ingredients: updatedIngredients, transactions } = result;
    const changedIngredientIds = new Set(transactions.map((transaction) => transaction.ingredientId));
    const changedIngredients = updatedIngredients.filter((ingredient) => changedIngredientIds.has(ingredient.id));

    if (supabase && session) {
      // One atomic Postgres transaction (confirm_bake in supabase-add-inventory.sql) applies
      // every ingredient update and every ledger insert together -- replacing the sequential
      // .update()/.insert() calls Milestones 2-4 used. The RPC persists exactly what
      // applyBakeConfirmation already computed above; it does not recompute or re-derive any
      // business rule (insufficient-stock checking stays entirely in applyBakeConfirmation).
      const { error } = await supabase.rpc("confirm_bake", {
        p_ingredient_updates: changedIngredients.map((ingredient) => ({ id: ingredient.id, current_quantity: ingredient.currentQuantity })),
        p_transactions: transactions.map((transaction) => toInventoryTransactionRow(transaction)),
      });

      if (error) {
        setMessage(`Bake confirm failed: ${describeIngredientConstraintError(error)}`);
        setMessageTone("bad");
        return;
      }

      const completedAt = new Date().toISOString();
      const { error: completionError } = await supabase
        .from("product_batches")
        .update({ status: "completed", completed_at: completedAt })
        .eq("id", batchId);
      setMessage(
        completionError
          ? `Bake confirmed and inventory updated, but batch completion status could not be saved: ${completionError.message}. Do not confirm this bake again; the stock deduction already happened.`
          : "Bake confirmed. Inventory updated and batch marked completed."
      );
      setMessageTone(completionError ? "bad" : "good");
      await loadSupabaseData();
      return;
    }

    const completedAt = new Date().toISOString();
    setLabState((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient) => changedIngredients.find((updated) => updated.id === ingredient.id) ?? ingredient),
      batches: current.batches.map((batch) => (batch.id === batchId ? markBatchCompleted(batch, completedAt) : batch)),
      inventoryTransactions: [...transactions, ...current.inventoryTransactions],
    }));
    setMessage("Bake confirmed locally. Inventory updated and batch marked completed.");
    setMessageTone("good");
  }

  async function saveEquipment(formData: FormData) {
    const equipmentId = String(formData.get("id") || "");
    const equipment: EquipmentEntry = {
      id: equipmentId || crypto.randomUUID(),
      name: String(formData.get("name") || "").trim(),
      brand: String(formData.get("brand") || "").trim(),
      model: String(formData.get("model") || "").trim(),
      purchasePrice: Number(formData.get("purchasePrice") || 0),
      purchaseDate: String(formData.get("purchaseDate") || getToday()),
      residualValuePercent: Number(formData.get("residualValuePercent") || 0),
      usefulLifeYears: Number(formData.get("usefulLifeYears") || 0),
      batchesPerWeek: Number(formData.get("batchesPerWeek") || 0),
      annualMaintenancePercent: Number(formData.get("annualMaintenancePercent") || 0),
      batchesPerUnit: Number(formData.get("batchesPerUnit") || 0),
      tankSizeKg: Number(formData.get("tankSizeKg") || 0),
      burnRateKgPerHour: Number(formData.get("burnRateKgPerHour") || 0),
      calculationMode:
        formData.get("calculationMode") === "gas-burn-rate"
          ? "gas-burn-rate"
          : formData.get("calculationMode") === "replacement-reserve"
            ? "replacement-reserve"
            : "depreciation",
      notes: String(formData.get("notes") || "").trim(),
      isActive: formData.get("isActive") === "on",
    };

    if (supabase && session) {
      const payload = {
        name: equipment.name,
        brand: equipment.brand,
        model: equipment.model,
        purchase_price: equipment.purchasePrice,
        purchase_date: equipment.purchaseDate,
        residual_value_percent: equipment.residualValuePercent,
        useful_life_years: equipment.usefulLifeYears,
        batches_per_week: equipment.batchesPerWeek,
        annual_maintenance_percent: equipment.annualMaintenancePercent,
        batches_per_unit: equipment.batchesPerUnit,
        tank_size_kg: equipment.tankSizeKg,
        burn_rate_kg_per_hour: equipment.burnRateKgPerHour,
        calculation_mode: equipment.calculationMode,
        notes: equipment.notes,
        is_active: equipment.isActive,
      };
      const query = equipmentId
        ? supabase.from("equipment").update(payload).eq("id", equipmentId)
        : supabase.from("equipment").insert(payload);
      const { error } = await query;
      setMessage(error ? `Equipment save failed. Run the latest equipment SQL first if this is your first time: ${error.message}` : "Equipment saved.");
      setMessageTone(error ? "bad" : "good");
      setIsEquipmentTableMissing(Boolean(error?.message.includes("equipment")));
      if (!error) {
        setEditingEquipment(null);
        await loadSupabaseData();
      }
      return;
    }

    setLabState((current) => ({
      ...current,
      equipment: equipmentId ? current.equipment.map((entry) => (entry.id === equipmentId ? equipment : entry)) : [equipment, ...current.equipment],
    }));
    setEditingEquipment(null);
    setMessage("Equipment saved locally.");
    setMessageTone("good");
  }

  async function deleteEquipment(equipmentId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("equipment").delete().eq("id", equipmentId);
      setMessage(error ? `Equipment delete failed: ${error.message}` : "Equipment deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingEquipment?.id === equipmentId) {
        setEditingEquipment(null);
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({ ...current, equipment: current.equipment.filter((entry) => entry.id !== equipmentId) }));
    if (editingEquipment?.id === equipmentId) {
      setEditingEquipment(null);
    }
    setMessage("Equipment deleted locally.");
    setMessageTone("good");
  }

  async function saveTasting(formData: FormData) {
    const tastingId = String(formData.get("id") || "");
    const tasting: TastingFeedback = {
      id: tastingId || crypto.randomUUID(),
      productId: String(formData.get("productId")),
      batchId: String(formData.get("batchId") || ""),
      timeLabel: String(formData.get("timeLabel") || "").trim(),
      tasterName: String(formData.get("tasterName") || "Unnamed taster"),
      rating: Number(formData.get("rating") || 0),
      liked: String(formData.get("liked") || ""),
      improve: String(formData.get("improve") || ""),
      wouldBuy: formData.get("wouldBuy") as TastingFeedback["wouldBuy"],
      willingToPay: Number(formData.get("willingToPay") || 0),
      wouldReorder: formData.get("wouldReorder") as TastingFeedback["wouldReorder"],
      packagingReaction: String(formData.get("packagingReaction") || ""),
    };
    if (supabase && session) {
      const payload = {
        product_id: tasting.productId,
        batch_id: tasting.batchId || null,
        time_label: tasting.timeLabel,
        taster_name: tasting.tasterName,
        rating: tasting.rating,
        liked: tasting.liked,
        improve: tasting.improve,
        would_buy: tasting.wouldBuy,
        willing_to_pay: tasting.willingToPay,
        would_reorder: tasting.wouldReorder,
        packaging_reaction: tasting.packagingReaction,
      };
      const query = tastingId
        ? supabase.from("tasting_feedback").update(payload).eq("id", tastingId)
        : supabase.from("tasting_feedback").insert(payload);
      const { error } = await query;
      setMessage(error ? `Feedback save failed: ${error.message}` : tastingId ? "Feedback updated." : "Feedback saved.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      tastings: tastingId ? current.tastings.map((entry) => (entry.id === tastingId ? tasting : entry)) : [tasting, ...current.tastings],
    }));
    setMessage(tastingId ? "Feedback updated locally." : "Feedback saved locally.");
    setMessageTone("good");
  }

  async function deleteTasting(tastingId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("tasting_feedback").delete().eq("id", tastingId);
      setMessage(error ? `Feedback delete failed: ${error.message}` : "Feedback deleted.");
      setMessageTone(error ? "bad" : "good");
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, tastings: current.tastings.filter((entry) => entry.id !== tastingId) }));
    setMessage("Feedback deleted locally.");
    setMessageTone("good");
  }

  async function saveJournal(formData: FormData) {
    const journalId = String(formData.get("id") || "");
    const mediaCaptured = formData.getAll("mediaCaptured").join(", ");
    const mediaLink = String(formData.get("mediaLink") || "").trim();
    const contentAngle = String(formData.get("contentAngle") || "");
    const entry: ContentJournalEntry = {
      id: journalId || crypto.randomUUID(),
      productId: String(formData.get("productId") || ""),
      entryDate: String(formData.get("entryDate") || getToday()),
      whatWasMade: String(formData.get("whatWasMade") || ""),
      mediaCaptured: mediaLink ? `${mediaCaptured}. Link: ${mediaLink}` : mediaCaptured,
      lessonLearned: String(formData.get("lessonLearned") || ""),
      postIdeas: contentAngle,
      nextAction: String(formData.get("nextAction") || ""),
      entryType: String(formData.get("entryType") || ""),
    };
    if (supabase && session) {
      const payload = buildContentJournalPayload(entry);
      const query = journalId
        ? supabase.from("content_journal").update(payload).eq("id", journalId)
        : supabase.from("content_journal").insert(payload);
      const { error } = await query;
      setMessage(error ? `Journey save failed: ${error.message}` : journalId ? "Journey entry updated." : "Journey entry saved.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        setEditingJournal(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      journal: journalId ? current.journal.map((item) => (item.id === journalId ? entry : item)) : [entry, ...current.journal],
    }));
    setEditingJournal(null);
    setMessage(journalId ? "Journey entry updated locally." : "Journey entry saved locally.");
    setMessageTone("good");
  }

  async function deleteJournal(journalId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("content_journal").delete().eq("id", journalId);
      setMessage(error ? `Journey delete failed: ${error.message}` : "Journey entry deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingJournal?.id === journalId) {
        setEditingJournal(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, journal: current.journal.filter((entry) => entry.id !== journalId) }));
    if (editingJournal?.id === journalId) {
      setEditingJournal(null);
    }
    setMessage("Journey entry deleted locally.");
    setMessageTone("good");
  }

  // The single Content Studio save pipeline (M2C2) -- both the edit form and the Journey
  // handoff action funnel through this one function; neither assembles a Supabase query by
  // hand. Insert vs. update is decided by membership in labState.contentDrafts, not by
  // whether draft.id is empty -- unlike content_journal, a content_drafts id is always
  // assigned up front by createDraftFromJourney/the form's own lazy crypto.randomUUID(), so
  // "does this id already exist" is the only reliable signal. Deliberately keeps the draft
  // selected after a successful save (setEditingDraft(draft), never null) -- unlike
  // saveJournal's "reset to blank," content drafting is ongoing, multi-session work, not a
  // one-shot capture; see MARKETING_MODULE.md's M2C1.5 UX contract for the reasoning. Returns
  // whether the save succeeded so a caller (createContentFromJourney) can decide whether it's
  // safe to navigate away.
  // journeyEntryId/sourceSnapshot are write-once, set only at creation (buildContentDraftPayload).
  // An edit can never change them, even if a future bug fed a different value through the form's
  // hidden fields -- for an existing draft, the already-persisted values always win over
  // whatever the incoming `draft` argument says; the UPDATE payload itself
  // (buildContentDraftUpdatePayload) also structurally excludes both columns, so this is a
  // belt-and-suspenders guarantee, not just a convention the caller has to remember.
  async function saveDraft(draft: ContentDraft): Promise<boolean> {
    const existingDraft = labState.contentDrafts.find((item) => item.id === draft.id);
    const isNewDraft = !existingDraft;
    const persistedDraft: ContentDraft = existingDraft
      ? { ...draft, journeyEntryId: existingDraft.journeyEntryId, sourceSnapshot: existingDraft.sourceSnapshot }
      : draft;

    if (supabase && session) {
      const query = isNewDraft
        ? supabase.from("content_drafts").insert({ id: persistedDraft.id, ...buildContentDraftPayload(persistedDraft) })
        : supabase.from("content_drafts").update(buildContentDraftUpdatePayload(persistedDraft)).eq("id", persistedDraft.id);
      const { error } = await query;
      setMessage(error ? `Content draft save failed: ${error.message}` : isNewDraft ? "Content draft saved." : "Content draft updated.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        setEditingDraft(persistedDraft);
      }
      await loadSupabaseData();
      return !error;
    }
    setLabState((current) => ({
      ...current,
      contentDrafts: isNewDraft ? [persistedDraft, ...current.contentDrafts] : current.contentDrafts.map((item) => (item.id === persistedDraft.id ? persistedDraft : item)),
    }));
    setEditingDraft(persistedDraft);
    setMessage(isNewDraft ? "Content draft saved locally." : "Content draft updated locally.");
    setMessageTone("good");
    return true;
  }

  // Reads the edit form's fields into a ContentDraft and hands it to saveDraft -- the only
  // place FormData gets parsed for this domain. journeyEntryId/sourceSnapshot travel through
  // as hidden fields (never a visible, editable control) so the frozen-snapshot/read-only-link
  // rule from M2C1 can't be bypassed by editing -- and saveDraft itself now enforces this
  // structurally regardless of what these two fields carry. contentType/status are read as
  // plain "" on empty rather than repeating the "general"/"idea" default literals here too --
  // buildContentDraftPayload/buildContentDraftUpdatePayload already own that fallback.
  async function saveDraftForm(formData: FormData) {
    const draftId = String(formData.get("id") || crypto.randomUUID());
    await saveDraft({
      id: draftId,
      journeyEntryId: String(formData.get("journeyEntryId") || ""),
      sourceSnapshot: String(formData.get("sourceSnapshot") || ""),
      title: String(formData.get("title") || ""),
      contentType: String(formData.get("contentType") || ""),
      status: String(formData.get("status") || ""),
      hook: String(formData.get("hook") || ""),
      caption: String(formData.get("caption") || ""),
      script: String(formData.get("script") || ""),
      createdAt: "",
      updatedAt: "",
    });
  }

  // Journey -> Content handoff (M2C2) -- see MARKETING_MODULE.md's "M2C1.5 UX contract".
  // Exactly `saveDraft(createDraftFromJourney(entry))`: the UI never touches title/snapshot/
  // defaults/linkage logic, only the one owning helper does. Navigates via the App Router
  // (no hard reload -- preserves client state, matches where this app is headed) only after a
  // confirmed successful insert; on failure the operator stays on /journal with a toast and
  // the button re-enabled for retry. creatingContentForEntryId guards against one click
  // firing twice without blocking a *different* entry's button (see isCreateContentPending in
  // src/lib/content-drafts.ts) -- cleared in a finally so a thrown exception (not just a
  // returned save failure) can never leave the button stuck disabled.
  async function createContentFromJourney(entry: ContentJournalEntry) {
    setCreatingContentForEntryId(entry.id);
    try {
      const succeeded = await saveDraft(createDraftFromJourney(entry));
      if (succeeded) {
        router.push("/content-studio");
      }
    } finally {
      setCreatingContentForEntryId(null);
    }
  }

  if (isSupabaseConfigured && isAuthLoading) {
    return <LoadingScreen />;
  }

  if (isSupabaseConfigured && !session) {
    return <LoginScreen message={message} signIn={signIn} />;
  }

  return (
    <AppShell view={view}>
          {message && view !== "dashboard" && view !== "costing" ? <MessageBox message={message} tone={messageTone} /> : null}
          {view === "dashboard" ? <DashboardPage metrics={metrics} labState={labState} message={message} messageTone={messageTone} session={session} signOut={signOut} /> : null}

          {view === "products" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_360px]" id="products">
              <ProductReadiness labState={labState} />
              <DecisionSidebar labState={labState} />
            </section>
          ) : null}

          {view === "product-detail" ? <ProductDetailPage deleteAiReview={deleteAiReview} isAiReviewsTableMissing={isAiReviewsTableMissing} labState={labState} saveAiReview={saveAiReview} /> : null}

          {view === "proof-day" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="proof-day-mode">
              <BatchForm batch={editingBatch} batches={labState.batches} batchPhotos={labState.batchPhotos} cancelEdit={() => setEditingBatch(null)} deleteBatchPhoto={deleteBatchPhoto} ingredients={labState.ingredients} products={labState.products} saveBatch={saveBatch} supplies={labState.supplies} uploadBatchPhotos={uploadBatchPhotos} />
              <div className="space-y-5">
                <ProofDayModeGuide />
                <JournalForm cancelEdit={() => setEditingJournal(null)} entry={editingJournal} products={labState.products} saveJournal={saveJournal} />
              </div>
            </section>
          ) : null}

          {view === "batches" ? (
            <BatchHistoryPage batch={editingBatch} cancelEdit={() => setEditingBatch(null)} deleteBatch={deleteBatch} deleteBatchPhoto={deleteBatchPhoto} deleteTasting={deleteTasting} editBatch={setEditingBatch} labState={labState} saveBatch={saveBatch} saveTasting={saveTasting} uploadBatchPhotos={uploadBatchPhotos} voidBatch={voidProductBatch} />
          ) : null}

          {view === "costing" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="costing">
              <CostingForm batches={labState.batches} cancelEdit={() => setEditingCosting(null)} costing={editingCosting} equipment={labState.equipment} ingredientEntries={labState.costingEntries} ingredients={labState.ingredients} isSellingFormatsTableMissing={isSellingFormatsTableMissing} key={editingCosting?.id ?? "new-costing"} message={message} messageTone={messageTone} products={labState.products} saveCosting={saveCosting} sellingFormatPackagingLines={labState.sellingFormatPackagingLines} sellingFormats={labState.sellingFormats} supplies={labState.supplies} />
              <div className="space-y-5">
                <CostingGuide />
                <RecentEntries deleteCosting={deleteCosting} editCosting={setEditingCosting} editingCostingId={editingCosting?.id} labState={labState} only="costing" />
              </div>
            </section>
          ) : null}

          {view === "equipment" ? <EquipmentPage cancelEdit={() => setEditingEquipment(null)} deleteEquipment={deleteEquipment} editEquipment={setEditingEquipment} equipment={editingEquipment} isEquipmentTableMissing={isEquipmentTableMissing} labState={labState} saveEquipment={saveEquipment} /> : null}
          {view === "inventory" ? (
            <InventoryWorkspace
              adjustStock={adjustStock}
              cancelEditIngredient={() => setEditingIngredient(null)}
              cancelEditSupply={() => setEditingSupply(null)}
              confirmPurchaseImport={confirmPurchaseImport}
              createPurchaseImportDraft={createPurchaseImportDraft}
              deleteIngredient={deleteIngredient}
              deleteSupply={deleteSupply}
              discardPurchaseImport={discardPurchaseImport}
              editIngredient={setEditingIngredient}
              editSupply={setEditingSupply}
              hardDeleteIngredient={hardDeleteIngredient}
              ingredient={editingIngredient}
              initialTab={initialInventoryTab}
              isInventoryTableMissing={isInventoryTableMissing}
              isPurchaseImportPackagesMissing={isPurchaseImportPackagesMissing}
              isSuppliesTableMissing={isSuppliesTableMissing}
              labState={labState}
              repairSupplyInventoryEffects={repairSupplyInventoryEffects}
              reverseInventoryAdjustment={reverseInventoryAdjustment}
              saveIngredient={saveIngredient}
              saveIngredientAlias={saveIngredientAlias}
              saveSupply={saveSupply}
              restoreIngredient={restoreIngredient}
              supply={editingSupply}
              updatePurchaseImportHeader={updatePurchaseImportHeader}
              updatePurchaseImportRow={updatePurchaseImportRow}
            />
          ) : null}
          {view === "bake" ? <BakePage confirmBake={confirmBake} isInventoryTableMissing={isInventoryTableMissing} labState={labState} saveIngredientAlias={saveIngredientAlias} /> : null}

          {view === "journal" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="journal">
              <JournalForm cancelEdit={() => setEditingJournal(null)} entry={editingJournal} products={labState.products} saveJournal={saveJournal} />
              <div className="space-y-5">
                <ContentJournalGuide />
                <RecentEntries
                  createContentFromJourney={createContentFromJourney}
                  creatingContentForEntryId={creatingContentForEntryId}
                  deleteJournal={deleteJournal}
                  editingJournalId={editingJournal?.id}
                  editJournal={setEditingJournal}
                  labState={labState}
                  only="journal"
                />
              </div>
            </section>
          ) : null}

          {view === "opportunities" ? <OpportunitiesPage initialStatusFilter={initialOpportunityStatusFilter} /> : null}

          {view === "admin" ? <ProductAdminPage cancelEdit={() => setEditingProduct(null)} deleteProduct={deleteProduct} editProduct={setEditingProduct} isProductDecisionColumnMissing={isProductDecisionColumnMissing} labState={labState} product={editingProduct} saveProduct={saveProduct} /> : null}

          {view === "launch" ? <LaunchOfferBuilder labState={labState} /> : null}

          {view === "content-studio" ? (
            <ContentStudio
              editingDraft={editingDraft}
              isContentDraftsTableMissing={isContentDraftsTableMissing}
              labState={labState}
              saveDraftForm={saveDraftForm}
              setEditingDraft={setEditingDraft}
            />
          ) : null}

          {view === "guide" ? <OperatingGuide labState={labState} /> : null}
    </AppShell>
  );
}

type BatchProcessStepRow = { rowId: string; text: string };

function buildBatchIngredientsNotes(formData: FormData) {
  const rowIds = String(formData.get("batchIngredientRowIds") || "")
    .split(",")
    .filter(Boolean);
  const formula = rowIds
    .map((rowId) => ({
      brand: String(formData.get(`batchBrand-${rowId}`) || "").trim(),
      ingredient: String(formData.get(`batchIngredient-${rowId}`) || "").trim(),
      quantity: Number(formData.get(`batchQuantity-${rowId}`) || 0),
      unit: String(formData.get(`batchUnit-${rowId}`) || "").trim(),
      change: String(formData.get(`batchChange-${rowId}`) || "").trim(),
      step: String(formData.get(`batchIngredientStep-${rowId}`) || "").trim(),
    }))
    .filter((row) => row.brand || row.ingredient || row.quantity > 0 || row.change);

  const stepRowIds = String(formData.get("batchProcessStepRowIds") || "")
    .split(",")
    .filter(Boolean);
  const steps = stepRowIds
    .map((rowId) => String(formData.get(`batchProcessStep-${rowId}`) || "").trim())
    .filter(Boolean);

  return JSON.stringify({ formula, steps });
}

function getFormulaAdjustment(row: BatchFormulaRow) {
  if (row.previousQuantity === undefined) {
    return row.change;
  }

  if (!row.ingredient.trim()) {
    return "";
  }

  if (row.previousQuantity === 0 && row.quantity > 0) {
    return "New ingredient";
  }

  const difference = row.quantity - row.previousQuantity;
  if (difference === 0) {
    return "Same as previous";
  }

  const sign = difference > 0 ? "+" : "";
  return `${sign}${difference}${row.unit ? ` ${row.unit}` : ""} vs previous`;
}

function buildFormulaRowsFromPreviousBatch(previousBatch: ProductBatch | undefined) {
  const previousRows = parseBatchIngredients(previousBatch?.ingredientsNotes ?? "");
  if (previousRows.length === 0) {
    return [{ brand: "", change: "", ingredient: "", previousQuantity: undefined, quantity: 0, rowId: crypto.randomUUID(), step: "", unit: "" }];
  }

  return previousRows.map((row) => ({
    ...row,
    change: "",
    previousQuantity: row.quantity,
    rowId: crypto.randomUUID(),
  }));
}


function formatBatchFormula(formula: BatchFormulaRow[]) {
  return formula
    .filter((row) => row.ingredient.trim())
    .map((row) => `${row.brand ? `${row.brand.trim()} ` : ""}${row.ingredient.trim()} - ${row.quantity || ""}${row.unit ? ` ${row.unit}` : ""}${row.change ? ` - ${row.change}` : ""}${row.step ? ` [${row.step}]` : ""}`.trim())
    .join("\n");
}

function parseFormulaText(text: string, supplies: SupplyEntry[], ingredients: Ingredient[]) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as Array<Partial<BatchFormulaRow>>;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((row) => row.ingredient)
        .map((row) => ({
          brand: row.brand ?? "",
          change: "",
          ingredient: row.ingredient ?? "",
          previousQuantity: Number(row.quantity || 0),
          quantity: Number(row.quantity || 0),
          rowId: crypto.randomUUID(),
          step: row.step ?? "",
          unit: row.unit ?? "",
        }));
    }
  } catch {
    // Fall through to the human-readable formula parser.
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart = "", quantityPart = ""] = line.split(/\s+-\s+/);
      const quantityMatch = quantityPart.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
      const quantity = Number(quantityMatch?.[1] ?? 0);
      const unit = quantityMatch?.[2]?.trim() ?? "";
      const normalizedName = normalizeSupplyText(namePart);
      const supplyMatch = getPurchaseHistoryForIngredientReference(ingredients, supplies, { ingredientName: namePart })
        .sort((a, b) => getSupplyLabel(b).length - getSupplyLabel(a).length)
        .find((supply) => {
          const fullName = `${supply.brandName} ${supply.ingredientName}`.trim();
          return normalizeSupplyText(fullName) === normalizedName || normalizeSupplyText(supply.ingredientName) === normalizedName;
        });

      return {
        brand: supplyMatch?.brandName ?? "",
        change: "",
        ingredient: supplyMatch?.ingredientName ?? namePart,
        previousQuantity: quantity,
        quantity,
        rowId: crypto.randomUUID(),
        step: "",
        unit,
      };
    });
}

function csvValue(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  if (typeof document === "undefined") {
    return;
  }

  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function printPage(reportId: string) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const report = document.getElementById(reportId);
  if (!report) {
    window.print();
    return;
  }

  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    window.print();
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${report.querySelector("h1")?.textContent ?? "Aly & Shin Report"}</title>
        <style>
          @page { size: A4; margin: 10mm; }
          * { box-sizing: border-box; }
          body { color: #111; font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 1.25; margin: 0; }
          h1 { font-size: 18px; margin: 0 0 4px; }
          h2 { border-bottom: 1px solid #777; font-size: 12px; margin: 14px 0 6px; padding-bottom: 3px; }
          p { margin: 0 0 6px; }
          table { border-collapse: collapse; table-layout: fixed; width: 100%; }
          th, td { border: 1px solid #888; padding: 4px; text-align: left; vertical-align: top; word-break: break-word; }
          th { background: #f2f2f2; font-weight: 700; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          .print-report { display: block; }
        </style>
      </head>
      <body>${report.outerHTML}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function ProductDetailPage({
  deleteAiReview,
  isAiReviewsTableMissing,
  labState,
  saveAiReview,
}: {
  deleteAiReview: (reviewId: string) => void;
  isAiReviewsTableMissing: boolean;
  labState: LabState;
  saveAiReview: (review: { productId: string; batchId: string; action: AiAction; specialists: SpecialistId[]; prompt: string; response: string }) => void;
}) {
  const [selectedProductId, setSelectedProductId] = useState(labState.products[0]?.id ?? "");
  const product = labState.products.find((item) => item.id === selectedProductId) ?? labState.products[0];

  if (!product) {
    return <p className="text-sm leading-6 text-[#6f5a4c]">No products yet. Add one from the Product Admin page first.</p>;
  }

  const batches = labState.batches.filter((batch) => batch.productId === product.id);
  const latestBatch = batches[0];
  const costing = labState.costings.find((entry) => entry.productId === product.id);
  const tastings = labState.tastings.filter((entry) => entry.productId === product.id);
  const journal = labState.journal.filter((entry) => entry.productId === product.id);
  const aiReviews = labState.aiReviews.filter((review) => review.productId === product.id);
  const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
  const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
  const averageRating = stats.averageRating ? stats.averageRating.toFixed(1) : "None";
  const costingTotals = costing ? getCostingTotals(costing) : null;

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        <div className="border-b border-[#eaded2] p-5">
          <label className="grid max-w-sm gap-1 text-sm font-medium">
            Product
            <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
              {labState.products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <h3 className="mt-4 text-2xl font-semibold">{product.name}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#6f5a4c]">{product.description}</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<FlaskConical size={20} />} label="Batches" value={batches.length} detail={latestBatch ? latestBatch.launchDecision : "No proof yet"} />
          <MetricCard icon={<Sparkles size={20} />} label="Batch cost" value={costingTotals ? Math.round(costingTotals.totalBatchCost) : 0} detail={costing ? "PHP total" : "No costing"} />
          <MetricCard icon={<Star size={20} />} label="Tastings" value={tastings.length} detail={`Avg: ${averageRating}`} />
          <MetricCard icon={<NotebookPen size={20} />} label="Content" value={journal.length} detail="Journey entries" />
        </div>
        <div className="grid gap-4 p-5 pt-0 xl:grid-cols-2">
          <DetailCard title="Latest Proof" lines={[latestBatch?.batchVersion ?? "No proof batch saved", latestBatch?.wentWrong ? `Issue: ${latestBatch.wentWrong}` : "Issue: not logged", latestBatch?.improveNext ? `Next: ${latestBatch.improveNext}` : "Next: not set"]} />
          <DetailCard title="Costing" lines={[costingTotals ? `Batch cost: PHP ${costingTotals.totalBatchCost.toFixed(2)}` : "No costing saved", costing ? `Selling price: PHP ${costing.suggestedPrice}` : "Price not set", costingTotals ? `Utilities: PHP ${costingTotals.utilityTotal.toFixed(2)}` : "Utilities not set"]} />
          <DetailCard title="Tasting Signals" lines={[`Feedback count: ${tastings.length}`, `Average rating: ${averageRating}`, tastings[0]?.improve ? `Latest improvement: ${tastings[0].improve}` : "No improvement signal yet"]} />
          <DetailCard title="Content Signals" lines={[journal[0]?.postIdeas ? `Best use: ${journal[0].postIdeas}` : "No content angle yet", journal[0]?.mediaCaptured ? `Captured: ${journal[0].mediaCaptured}` : "No media logged", journal[0]?.nextAction ? `Next: ${journal[0].nextAction}` : "No next content action"]} />
        </div>
      </div>
      <Panel title="Next Action" icon={<ClipboardCheck size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          <p>Readiness: {readiness.percent}%</p>
          <p>{latestBatch?.improveNext || "Create or complete the next proof batch before making a launch decision."}</p>
          <a className="inline-flex rounded-md bg-[#8f5632] px-3 py-2 text-sm font-semibold text-white" href="/proof-day">Open Proof Day</a>
        </div>
      </Panel>
      <div className="xl:col-span-2">
        <AiAdvisorPanel
          batches={labState.batches}
          costings={labState.costings}
          deleteReview={deleteAiReview}
          ingredients={labState.ingredients}
          isTableMissing={isAiReviewsTableMissing}
          product={product}
          reviews={aiReviews}
          saveReview={saveAiReview}
          supplies={labState.supplies}
          tastings={labState.tastings}
        />
      </div>
    </section>
  );
}

function DetailCard({ lines, title }: { lines: string[]; title: string }) {
  return (
    <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-4">
      <h4 className="font-semibold">{title}</h4>
      <div className="mt-3 space-y-2 text-sm leading-6 text-[#5f4a3d]">
        {lines.map((line) => <p key={line}>{line}</p>)}
      </div>
    </div>
  );
}

function ProofDayModeGuide() {
  return (
    <Panel title="Proof Day Mode" icon={<CheckCircle2 size={18} />}>
      <div className="space-y-4 text-sm leading-6 text-[#5f4a3d]">
        <p>Use this page during the actual kitchen session. Save the batch record first, then save the content capture while the details are fresh.</p>
        <ProofDayChecklist />
        <ProofBatchGuide />
      </div>
    </Panel>
  );
}

function getProductGap(stats: ReturnType<typeof getProductStats>) {
  if (stats.proofBatches === 0) {
    return "Needs first proof batch";
  }

  if (!stats.costingDone) {
    return "Needs costing";
  }

  if (!stats.packagingDone) {
    return "Needs packaging cost";
  }

  if (stats.tastingCount < 5) {
    return `Needs ${5 - stats.tastingCount} more tasting${5 - stats.tastingCount === 1 ? "" : "s"}`;
  }

  if (stats.averageRating !== null && stats.averageRating < 8) {
    return "Rating below 8 — retest or adjust";
  }

  if (stats.latestDecision !== "launch") {
    return "Awaiting launch decision";
  }

  return "Launch-ready";
}

function ReadinessPanels({ labState }: { labState: LabState }) {
  const closestToLaunch = getClosestToLaunch(labState.products, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
  const pauseCandidates = getPauseCandidates(labState.products, labState.batches, labState.costings, labState.tastings);
  const reviewItems = getShinReviewItems(labState.products, labState.batches, labState.costings, labState.tastings);

  return (
    <>
      <Panel title="Closest To Launch" icon={<PackageCheck size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          {closestToLaunch.length === 0 ? <p>No product has a readiness score yet.</p> : null}
          {closestToLaunch.map((entry) => (
            <p key={entry.product.id}><strong>{entry.product.name}:</strong> {entry.readiness.percent}% ({entry.readiness.passed}/{entry.readiness.total} gates)</p>
          ))}
        </div>
      </Panel>
      <Panel title="Consider Pausing" icon={<ShieldAlert size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          {pauseCandidates.length === 0 ? <p>No product currently flagged to pause.</p> : null}
          {pauseCandidates.map((product) => <p key={product.id}>{product.name}</p>)}
        </div>
      </Panel>
      <Panel title="Needs Your Review" icon={<ClipboardCheck size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          {reviewItems.length === 0 ? <p>Nothing has enough signal for a decision yet.</p> : null}
          {reviewItems.map((product) => <p key={product.id}>{product.name}: costed and tasted, still marked retest.</p>)}
        </div>
      </Panel>
    </>
  );
}

function ContextBrain({ labState }: { labState: LabState }) {
  const needsProof = getProductsNeedingProof(labState.products, labState.batches);
  const averageRating = labState.tastings.length
    ? Math.round((labState.tastings.reduce((total, tasting) => total + tasting.rating, 0) / labState.tastings.length) * 10) / 10
    : null;

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Context Brain</p>
          <h3 className="mt-1 text-xl font-semibold">What the data says right now</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#6f5a4c]">Generated from real Proof Day, Costing, Tasting, and Journey entries — not generic text.</p>
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-4">
          <MetricCard icon={<FlaskConical size={20} />} label="Proof batches" value={labState.batches.length} detail="Logged so far" />
          <MetricCard icon={<Beaker size={20} />} label="Purchases" value={labState.supplies.length} detail="Purchase records" />
          <MetricCard icon={<Star size={20} />} label="Tastings" value={labState.tastings.length} detail="Feedback entries" />
          <MetricCard icon={<Star size={20} />} label="Avg rating" value={averageRating ?? 0} detail={averageRating === null ? "No ratings yet" : "Out of 10"} />
        </div>
        <div className="border-t border-[#eaded2] p-5">
          <h4 className="font-semibold">What&apos;s missing, per product</h4>
          <div className="mt-3 divide-y divide-[#f0e4d8]">
            {labState.products.map((product) => {
              const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
              return (
                <div className="flex items-center justify-between gap-3 py-3 text-sm" key={product.id}>
                  <span className="font-medium">{product.name}</span>
                  <span className="text-[#6f5a4c]">{getProductGap(stats)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-5">
        <ReadinessPanels labState={labState} />
        <Panel title="Needs A Proof Batch" icon={<FlaskConical size={18} />}>
          <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
            {needsProof.length === 0 ? <p>Every product has at least one proof batch.</p> : null}
            {needsProof.map((product) => <p key={product.id}>{product.name}</p>)}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function OperatingGuide({ labState }: { labState: LabState }) {
  const dailyFlow = [
    { title: "1. Record the kitchen test", page: "/proof-day", detail: "Use Proof Day every time a product is made. Select the product, adjust the auto-filled formula, record timing, sellable yield, issues, freshness, packaging behavior, and the next test only." },
    { title: "2. Capture useful content", page: "/proof-day", detail: "Use Journey only when real media or a real lesson exists. Log texture close-ups, process clips, packaging photos, reactions, content angle, and next action." },
    { title: "3. Review the experiment history", page: "/batches", detail: "Use Batches after the kitchen work. Compare formulas, see automatic ingredient adjustments, review what failed, and decide whether to retest, pause, launch, or remove." },
    { title: "4. Add tasting checkpoints", page: "/batches", detail: "Tasting now lives directly under each batch on the Batches page. Add a checkpoint every time someone tries it -- 2 hours post-bake, 24 hours, whenever -- with rating, what they liked, what should improve, willingness to pay, reorder signal, and packaging reaction." },
    { title: "5. Cost only promising formulas", page: "/costing", detail: "Use Costing after the formula is close. Pull the latest proof formula into ingredients, then add real costs, packaging, labor, utilities, waste, and suggested price." },
    { title: "6. Check product readiness", page: "/product-detail", detail: "Use Product Detail to see the full picture for one product: proof, costing, tasting, content, and what is missing before launch." },
    { title: "7. Prepare the offer later", page: "/launch", detail: "Use Launch Offer only after proof, tasting, costing, freshness, and packaging look good enough. Draft cutoff, pickup or delivery rules, storage, serving instructions, and bundle idea." },
  ];

  const weeklyFlow = [
    "Pick one product and one test change.",
    "Run Proof Day and save the real formula.",
    "Review Batches before deciding the next test.",
    "Let people taste the strongest version.",
    "Repeat the proof batch if feedback is unclear.",
    "Cost the product only when the formula is stable.",
    "Decide: retest, cost, taste again, launch, pause, or remove.",
  ];

  return (
    <div className="space-y-5">
      <ContextBrain labState={labState} />
      <section className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="rounded-lg border border-[#e1d4c4] bg-white">
          <div className="border-b border-[#eaded2] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Operating Manual</p>
            <h3 className="mt-1 text-xl font-semibold">Day-to-day Product Lab flow</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#6f5a4c]">This app should help you prove products before launch. Your wife records what happened in the kitchen. You review the data and decide what to improve, cost, launch, pause, or remove.</p>
          </div>
          <div className="divide-y divide-[#f0e4d8]">
            {dailyFlow.map((step) => (
              <article className="grid gap-3 p-5 md:grid-cols-[1fr_150px]" key={step.title}>
                <div>
                  <h4 className="font-semibold">{step.title}</h4>
                  <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">{step.detail}</p>
                </div>
                <a className="inline-flex h-10 items-center justify-center rounded-md bg-[#8f5632] px-3 text-sm font-semibold text-white" href={step.page}>Open page</a>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <Panel title="Simple Roles" icon={<ClipboardCheck size={18} />}>
            <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
              <p><strong>Your wife:</strong> Proof Day, Tasting, Journey.</p>
              <p><strong>You:</strong> Batches, Costing, Product Detail, Products, Admin, Launch.</p>
            </div>
          </Panel>
          <Panel title="Weekly Rhythm" icon={<CalendarDays size={18} />}>
            <ol className="space-y-2 text-sm leading-6 text-[#5f4a3d]">
              {weeklyFlow.map((item) => <li key={item}>{item}</li>)}
            </ol>
          </Panel>
          <Panel title="Testing Rule" icon={<ShieldAlert size={18} />}>
            <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
              <p>Do not change too many things at once.</p>
              <p><strong>Weak test:</strong> changed sugar, butter, bake time, pan, packaging, and cooling.</p>
              <p><strong>Good test:</strong> same formula as last batch, only reduced sugar by 15g.</p>
            </div>
          </Panel>
        </div>
      </section>
    </div>
  );
}

function BatchHistoryPage({
  batch,
  cancelEdit,
  deleteBatch,
  deleteBatchPhoto,
  deleteTasting,
  editBatch,
  labState,
  saveBatch,
  saveTasting,
  uploadBatchPhotos,
  voidBatch,
}: {
  batch: ProductBatch | null;
  cancelEdit: () => void;
  deleteBatch: (batchId: string) => void;
  deleteBatchPhoto: (photo: BatchPhoto) => void;
  deleteTasting: (tastingId: string) => void;
  editBatch: (batch: ProductBatch) => void;
  labState: LabState;
  saveBatch: (formData: FormData) => void;
  saveTasting: (formData: FormData) => void;
  uploadBatchPhotos: (batchId: string, files: FileList | File[]) => void;
  voidBatch: (batchId: string, reason: string) => void;
}) {
  const [copiedBatchId, setCopiedBatchId] = useState("");
  // Captured before the batches.map() below, which shadows `batch` with its own loop variable.
  const editingBatchId = batch?.id ?? null;

  async function copyFormula(batchId: string, formula: BatchFormulaRow[]) {
    const text = formatBatchFormula(formula);
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setCopiedBatchId(batchId);
  }

  function downloadBatches() {
    downloadCsv(
      "proof-batches.csv",
      ["Product", "Batch", "Date", "Decision", "Formula", "Process steps", "Taste notes", "Texture notes", "Issue", "Next test", "Sellable", "Rejects"],
      labState.batches.map((batch) => {
        const { formula, steps } = parseBatchRecord(batch.ingredientsNotes);
        return [
          productName(batch.productId, labState.products),
          batch.batchVersion,
          batch.dateMade,
          batch.launchDecision,
          formatBatchFormula(formula),
          steps.map((step, index) => `${index + 1}. ${step}`).join(" / "),
          batch.tasteNotes,
          batch.textureNotes,
          batch.wentWrong,
          batch.improveNext,
          batch.usablePieces,
          batch.imperfectPieces,
        ];
      }),
    );
  }

  return (
    <section className="grid gap-5">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        {batch ? (
          <div className="border-b border-[#eaded2] p-5">
            <BatchForm batch={batch} batches={labState.batches} batchPhotos={labState.batchPhotos} cancelEdit={cancelEdit} deleteBatchPhoto={deleteBatchPhoto} ingredients={labState.ingredients} products={labState.products} saveBatch={saveBatch} supplies={labState.supplies} uploadBatchPhotos={uploadBatchPhotos} />
          </div>
        ) : null}
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Experiment History</p>
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="text-xl font-semibold">Proof batch records</h3>
            <div className="flex flex-wrap gap-2">
              <a className="flex h-9 items-center rounded-md bg-[#8f5632] px-3 text-sm font-semibold text-white" href="/bake">Bake a batch</a>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("proof-batches-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadBatches} type="button">Download CSV</button>
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Review formulas, adjustments, issues, and next tests. Create new experiments from Proof Day. When you actually bake one, use <strong>Bake a batch</strong> (or a record&apos;s <strong>Bake this</strong> link) to deduct its ingredients from inventory.</p>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {labState.batches.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No proof batches yet.</p> : null}
          {labState.batches.map((batch) => {
            const { formula, steps: processSteps } = parseBatchRecord(batch.ingredientsNotes);
            const effectiveStatus = getEffectiveBatchStatus(batch, labState.inventoryTransactions);
            const canVoid = canVoidBatch(batch, labState.inventoryTransactions);
            return (
              <article className={`p-5 ${batch.id === editingBatchId ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`} key={batch.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="font-semibold">{batchDisplayName(batch.productId, batch.batchVersion, labState.products)}</h4>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[#6f5a4c]">
                      <span>{batch.dateMade} / {batch.launchDecision}</span>
                      <Tag tone={effectiveStatus === "voided" ? "danger" : effectiveStatus === "completed" ? "green" : "warm"}>{effectiveStatus}</Tag>
                    </div>
                    {effectiveStatus === "voided" ? <p className="mt-1 text-sm text-[#8a3827]">Voided: {batch.voidReason || "No reason recorded"}</p> : null}
                  </div>
                  <div className="flex gap-2">
                    <a className="text-sm font-semibold text-[#8f5632] underline" href={`/bake?batch=${batch.id}`}>Bake this</a>
                    <button className="text-sm font-semibold text-[#8f5632] underline" onClick={() => copyFormula(batch.id, formula)} type="button">{copiedBatchId === batch.id ? "Copied" : "Copy formula"}</button>
                    <button className="text-sm font-semibold text-[#8f5632] underline" onClick={() => editBatch(batch)} type="button">Edit</button>
                    {canVoid ? (
                      <button
                        className="text-sm font-semibold text-[#8a3827] underline"
                        onClick={() => {
                          const reason = window.prompt(`Void ${batch.batchVersion}? This batch will remain in history and current stock will remain unchanged. Enter a reason:`);
                          if (reason !== null) voidBatch(batch.id, reason);
                        }}
                        type="button"
                      >
                        Void
                      </button>
                    ) : null}
                    <button className="text-sm font-semibold text-[#8a3827] underline" onClick={() => window.confirm(`Permanently delete ${batch.batchVersion}? Only untouched draft batches with no stock, costing, tasting, photo, or review references can be deleted.`) ? deleteBatch(batch.id) : undefined} type="button">Delete</button>
                  </div>
                </div>
                <div className="mt-4 grid gap-4 xl:grid-cols-3">
                  <DetailCard title="Formula" lines={formula.length ? formula.map((row) => `${row.brand ? `${row.brand} ` : ""}${row.ingredient || "Ingredient"}: ${row.quantity || ""}${row.unit ? ` ${row.unit}` : ""}${row.step ? ` [${row.step}]` : ""}`) : ["No formula rows saved"]} />
                  <DetailCard title="Process steps" lines={processSteps.length ? processSteps.map((step, index) => `${index + 1}. ${step}`) : ["No steps saved"]} />
                  <DetailCard title="Learning" lines={[batch.tasteNotes || "No process/quality notes", batch.wentWrong ? `Issue: ${batch.wentWrong}` : "Issue: none logged", batch.improveNext ? `Next: ${batch.improveNext}` : "Next: not set"]} />
                </div>
                <BatchComparisonSection currentBatch={batch} previousBatch={getPreviousBatch(labState.batches, batch)} />
                <BatchPhotosSection batchId={batch.id} deleteBatchPhoto={deleteBatchPhoto} photos={labState.batchPhotos.filter((photo) => photo.batchId === batch.id)} uploadBatchPhotos={uploadBatchPhotos} />
                <BatchTastingSection batchId={batch.id} deleteTasting={deleteTasting} productId={batch.productId} saveTasting={saveTasting} tastings={labState.tastings.filter((tasting) => tasting.batchId === batch.id)} />
              </article>
            );
          })}
        </div>
      </div>
      <ProofBatchesPrintReport batches={labState.batches} products={labState.products} />
    </section>
  );
}

function BatchPhotosSection({
  batchId,
  deleteBatchPhoto,
  photos,
  uploadBatchPhotos,
}: {
  batchId: string;
  deleteBatchPhoto: (photo: BatchPhoto) => void;
  photos: BatchPhoto[];
  uploadBatchPhotos: (batchId: string, files: FileList | File[]) => void;
}) {
  const [isUploading, setIsUploading] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    setIsUploading(true);
    await uploadBatchPhotos(batchId, files);
    setIsUploading(false);
  }

  return (
    <div className="mt-4 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold">Photos</p>
        <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]">
          {isUploading ? "Uploading..." : "Add photo"}
          <input
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={isUploading}
            multiple
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
      </div>
      {photos.length === 0 ? (
        <p className="mt-2 text-sm text-[#6f5a4c]">No photos yet.</p>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {photos.map((photo) => (
            <div className="relative aspect-square overflow-hidden rounded-md border border-[#ead9c8] bg-white" key={photo.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URLs, not a static/local asset */}
              <img alt="Batch photo" className="h-full w-full object-cover" src={photo.photoUrl} />
              <button
                aria-label="Delete photo"
                className="absolute right-1 top-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs font-semibold text-white"
                onClick={() => window.confirm("Delete this photo?") ? deleteBatchPhoto(photo) : undefined}
                type="button"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchComparisonSection({ currentBatch, previousBatch }: { currentBatch: ProductBatch; previousBatch: ProductBatch | undefined }) {
  if (!previousBatch) {
    return (
      <div className="mt-4 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
        <p className="text-sm font-semibold">Compare to previous version</p>
        <p className="mt-1 text-sm text-[#6f5a4c]">This is the first logged version for this product — nothing to compare yet.</p>
      </div>
    );
  }

  const { formula: previousFormula } = parseBatchRecord(previousBatch.ingredientsNotes);
  const { formula: currentFormula } = parseBatchRecord(currentBatch.ingredientsNotes);
  const rows = diffFormulaRows(previousFormula, currentFormula);
  const changedCount = rows.filter((row) => row.status !== "same").length;
  const statusLabel = { changed: "Changed", new: "New", removed: "Removed", same: "Same" };
  const statusTone = { changed: "text-[#9a5b2f]", new: "text-[#2e6b44]", removed: "text-[#8a3827]", same: "text-[#6f5a4c]" };

  return (
    <div className="mt-4 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <p className="text-sm font-semibold">Compare to previous version — {previousBatch.batchVersion} ({previousBatch.dateMade})</p>
      <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">{changedCount} of {rows.length} ingredient{rows.length === 1 ? "" : "s"} changed.</p>
      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9a5b2f]">
                <th className="pb-2 pr-3">Ingredient</th>
                <th className="pb-2 pr-3">Step</th>
                <th className="pb-2 pr-3">Previous</th>
                <th className="pb-2 pr-3">This version</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#ead9c8]">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-2 pr-3">{row.brand ? `${row.brand} ` : ""}{row.ingredient}</td>
                  <td className="py-2 pr-3 text-[#6f5a4c]">{row.step || "—"}</td>
                  <td className="py-2 pr-3">{row.previousQuantity === null ? "—" : `${row.previousQuantity}${row.previousUnit ? ` ${row.previousUnit}` : ""}`}</td>
                  <td className="py-2 pr-3">{row.currentQuantity === null ? "—" : `${row.currentQuantity}${row.currentUnit ? ` ${row.currentUnit}` : ""}`}</td>
                  <td className={`py-2 font-semibold ${statusTone[row.status]}`}>{statusLabel[row.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 text-xs text-[#6f5a4c] sm:grid-cols-3">
        <p>Prep: {previousBatch.prepTimeMinutes || 0} → {currentBatch.prepTimeMinutes || 0} min</p>
        <p>Bake: {previousBatch.bakeTimeMinutes || 0} → {currentBatch.bakeTimeMinutes || 0} min</p>
        <p>Cooling: {previousBatch.coolingTimeMinutes || 0} → {currentBatch.coolingTimeMinutes || 0} min</p>
        <p>Sellable: {previousBatch.usablePieces || 0} → {currentBatch.usablePieces || 0}</p>
        <p>Rejects: {previousBatch.imperfectPieces || 0} → {currentBatch.imperfectPieces || 0}</p>
        <p>Decision: {previousBatch.launchDecision} → {currentBatch.launchDecision}</p>
      </div>
    </div>
  );
}

function ProofBatchesPrintReport({ batches, products }: { batches: ProductBatch[]; products: Product[] }) {
  return (
    <div className="print-report" id="proof-batches-print-report">
      <h1>Aly & Shin Proof Batch Records</h1>
      <p>Generated {getToday()}</p>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch</th>
            <th>Date</th>
            <th>Formula</th>
            <th>Process steps</th>
            <th>Yield</th>
            <th>Decision</th>
            <th>Learning / Next Test</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const { formula, steps } = parseBatchRecord(batch.ingredientsNotes);
            return (
              <tr key={batch.id}>
                <td>{productName(batch.productId, products)}</td>
                <td>{batch.batchVersion}</td>
                <td>{batch.dateMade}</td>
                <td>{formatBatchFormula(formula) || "No formula saved"}</td>
                <td>{steps.map((step, index) => `${index + 1}. ${step}`).join(" ") || "No steps saved"}</td>
                <td>{batch.usablePieces} sellable / {batch.imperfectPieces} reject</td>
                <td>{batch.launchDecision}</td>
                <td>{[batch.tasteNotes, batch.textureNotes, batch.wentWrong ? `Issue: ${batch.wentWrong}` : "", batch.improveNext ? `Next: ${batch.improveNext}` : ""].filter(Boolean).join(" / ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProductAdminPage({
  cancelEdit,
  deleteProduct,
  editProduct,
  isProductDecisionColumnMissing,
  labState,
  product,
  saveProduct,
}: {
  cancelEdit: () => void;
  deleteProduct: (productId: string) => void;
  editProduct: (product: Product) => void;
  isProductDecisionColumnMissing: boolean;
  labState: LabState;
  product: Product | null;
  saveProduct: (formData: FormData) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(product?.id ?? null);
  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Backend Control</p>
          <h3 className="mt-1 text-xl font-semibold">Product Admin Board</h3>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Use this as your backend checklist for what each product needs before your wife spends more kitchen time.</p>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {labState.products.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No products yet. Add the first one on the right.</p> : null}
          {labState.products.map((item) => {
            const stats = getProductStats(item, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
            const referenceCount = getProductReferenceCount(item.id, labState);
            const referenceTotal = totalProductReferenceCount(referenceCount);
            const deletable = canDeleteProduct(referenceCount);
            return (
              <article className={`grid gap-3 p-4 md:grid-cols-[1fr_240px] ${item.id === product?.id ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`} key={item.id}>
                <div>
                  <h4 className="font-semibold">{item.name}</h4>
                  <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">{item.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill label={`${stats.proofBatches} proof`} done={stats.proofBatches > 0} />
                    <StatusPill label="Costing" done={stats.costingDone} />
                    <StatusPill label={`${stats.tastingCount}/5 tastings`} done={stats.tastingCount >= 5} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button className="text-sm font-semibold text-[#8f5632] underline" onClick={() => editProduct(item)} type="button">Edit</button>
                    <button
                      className="text-sm font-semibold text-[#8a3827] underline disabled:cursor-not-allowed disabled:text-[#c2a794] disabled:no-underline"
                      disabled={!deletable}
                      onClick={() => (window.confirm(`Permanently delete ${item.name}? This cannot be undone.`) ? deleteProduct(item.id) : undefined)}
                      type="button"
                    >
                      Delete
                    </button>
                    {!deletable ? <span className="text-xs text-[#8a7465]">{referenceTotal} linked record{referenceTotal === 1 ? "" : "s"} (batches/costing/tasting/journal) — set status to Paused instead, or clear those records first.</span> : null}
                  </div>
                </div>
                <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm leading-6 text-[#5f4a3d]">
                  <p className="font-semibold">Admin decision</p>
                  <p>{stats.proofBatches === 0 ? "Needs first proof batch" : `Latest: ${stats.latestDecision}`}</p>
                  <p>{item.category === "Coffee" ? "Keep as later add-on test." : "Eligible for proof cycle."}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <FormPanel ref={editorRef} title={product ? "Edit product" : "Add product"} icon={<PackageCheck size={18} />}>
        {product ? (
          <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {product.name}</p>
        ) : null}
        {isProductDecisionColumnMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Product database fields are not ready yet. Run <strong>supabase-add-product-decision.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveProduct} className="grid gap-3" key={product?.id ?? "new-product"}>
          <input name="id" type="hidden" value={product?.id ?? ""} />
          <Input name="name" label="Product name" placeholder="Ube Cookies" defaultValue={product?.name} ref={fieldRef} />
          <Input name="category" label="Category" placeholder="Baked goods" defaultValue={product?.category} />
          <Select name="role" label="Role" options={["Hero candidate", "Bundle product", "Premium upgrade", "Add-on candidate"]} defaultValue={product?.role ?? "Hero candidate"} />
          <Select name="status" label="Status" options={["testing", "costed", "tasting", "launch_candidate", "paused"]} defaultValue={product?.status ?? "testing"} />
          <Select name="decision" label="Decision" options={["Needs proof", "Retest", "Candidate", "Add-on test"]} defaultValue={product?.decision ?? "Needs proof"} />
          <Textarea name="description" label="Description" placeholder="Short description of the product idea." defaultValue={product?.description} />
          <Input name="image" label="Photo path (optional)" placeholder="/product-images/whatever.png" helper="Only if you've already added a photo file under public/product-images/. Leave blank for now." defaultValue={product?.image} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button>{product ? "Update product" : "Save product"}</Button>
            {product ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
          </div>
        </form>
      </FormPanel>
    </section>
  );
}

function LaunchOfferBuilder({ labState }: { labState: LabState }) {
  const candidates = labState.products.filter((product) => {
    const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
    return stats.proofBatches > 0 && stats.costingDone;
  });

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <FormPanel title="Launch offer draft" icon={<PackageCheck size={18} />}>
        <form className="grid gap-3">
          <Input label="Offer name" placeholder="Aly & Shin First Weekend Box" />
          <Select label="Hero product" options={candidates.length ? candidates.map((product) => product.name) : ["No costed proof product yet"]} />
          <Input label="Target launch date" type="date" />
          <Input label="Order cutoff" placeholder="Friday 6 PM" />
          <Textarea label="Pickup/delivery rules" placeholder="Pickup only / limited delivery / delivery fee / delivery window." />
          <Textarea label="Storage and serving instructions" placeholder="Keep chilled, stir before drinking, add ice after delivery, consume within..." />
          <Textarea label="Bundle idea" placeholder="Example: Brownie box + optional bottled latte add-on." />
        </form>
      </FormPanel>
      <Panel title="Ready Inputs" icon={<ClipboardCheck size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          {candidates.length === 0 ? <p>No product has both proof and costing yet.</p> : null}
          {candidates.map((product) => <p key={product.id}>{product.name}: proof + costing exist.</p>)}
        </div>
      </Panel>
    </section>
  );
}

// Content Studio (M2C2) -- see MARKETING_MODULE.md's "M2C2 implementation record" and the
// "M2C1.5 UX contract" it implements. Replaces the old journal[0]-derived stub entirely --
// nothing about that stub's logic survives (it was never real persistence). Table-missing
// banner mirrors every other isXTableMissing screen in this app exactly.
function ContentStudio({
  editingDraft,
  isContentDraftsTableMissing,
  labState,
  saveDraftForm,
  setEditingDraft,
}: {
  editingDraft: ContentDraft | null;
  isContentDraftsTableMissing: boolean;
  labState: LabState;
  saveDraftForm: (formData: FormData) => void;
  setEditingDraft: Dispatch<SetStateAction<ContentDraft | null>>;
}) {
  if (isContentDraftsTableMissing) {
    return (
      <Panel icon={<Sparkles size={18} />} title="Content Studio needs one-time setup">
        <p className="text-sm leading-6 text-[#5f4a3d]">
          Run <code>supabase-add-content-drafts.sql</code> once in the Supabase SQL editor, then
          reload this page.
        </p>
      </Panel>
    );
  }

  const sortedDrafts = [...labState.contentDrafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <ContentDraftForm cancelEdit={() => setEditingDraft(null)} draft={editingDraft} saveDraft={saveDraftForm} />
      <div className="space-y-5">
        <ContentStudioGuide />
        <Panel icon={<Sparkles size={18} />} title="Content drafts">
          <div className="space-y-3">
            {sortedDrafts.length === 0 ? (
              <p className="text-sm text-[#6f5a4c]">No content drafts yet. Create one from a Journey entry, or start one below.</p>
            ) : null}
            {sortedDrafts.map((draft) => (
              <div
                className={`border-t border-[#ead9c8] pt-3 first:border-t-0 first:pt-0 ${draft.id === editingDraft?.id ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8] pl-2" : ""}`}
                key={draft.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{draft.title || "Untitled draft"}</p>
                  <button className="shrink-0 text-xs font-semibold text-[#8f5632] underline" onClick={() => setEditingDraft(draft)} type="button">
                    Edit
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-[#6f5a4c]">
                  {contentTypeLabel(draft.contentType)} · {contentDraftStatusLabel(draft.status)}
                  {draft.journeyEntryId ? " · From Journey" : ""}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function ContentDraftForm({
  cancelEdit,
  draft,
  saveDraft,
}: {
  cancelEdit: () => void;
  draft: ContentDraft | null;
  saveDraft: (formData: FormData) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(draft?.id ?? null);
  return (
    <FormPanel icon={<Sparkles size={18} />} ref={editorRef} title={draft ? "Edit content draft" : "New content draft"}>
      {draft ? (
        <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {draft.title || "Untitled draft"}</p>
      ) : null}
      <form action={saveDraft} className="grid gap-3" key={draft?.id ?? "new-draft"}>
        <input name="id" type="hidden" value={draft?.id ?? ""} />
        {/* journeyEntryId/sourceSnapshot never appear as an editable control -- only ever a
            hidden pass-through -- so editing this form can never rewrite a draft's Journey
            source or its frozen snapshot (M2C1's read-only-link rule). */}
        <input name="journeyEntryId" type="hidden" value={draft?.journeyEntryId ?? ""} />
        <input name="sourceSnapshot" type="hidden" value={draft?.sourceSnapshot ?? ""} />
        {draft?.sourceSnapshot ? (
          <Panel icon={<NotebookPen size={18} />} title="Source: Journey">
            <p className="whitespace-pre-line text-sm leading-6 text-[#5f4a3d]">{draft.sourceSnapshot}</p>
          </Panel>
        ) : null}
        <Input defaultValue={draft?.title} label="Title" name="title" placeholder="Example: Brownies V2 texture reel" ref={fieldRef} />
        <div className="grid gap-3 sm:grid-cols-2">
          <ContentTypeSelect selectedType={draft?.contentType} />
          <ContentStatusSelect selectedStatus={draft?.status} />
        </div>
        <Textarea defaultValue={draft?.hook} label="Hook" name="hook" placeholder="Example: Testing brownies again -- here's what changed." />
        <Textarea defaultValue={draft?.caption} label="Caption" name="caption" placeholder="The full caption text for this post." />
        <Textarea defaultValue={draft?.script} label="Script" name="script" placeholder="Shot-by-shot notes or a full script." />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{draft ? "Update content draft" : "Save content draft"}</Button>
          {draft ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
    </FormPanel>
  );
}

function ContentStudioGuide() {
  return (
    <Panel icon={<Sparkles size={18} />} title="Keep It Simple">
      <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
        <p>Create content from a real Journey moment, or start from scratch below.</p>
        <ul className="space-y-2">
          <li><strong>Journey drafts:</strong> the source moment is shown above, frozen -- editing it here never changes the original Journey entry.</li>
          <li><strong>Status:</strong> a label you set yourself. There is no publishing automation yet.</li>
        </ul>
      </div>
    </Panel>
  );
}

function DashboardPage({
  metrics,
  labState,
  message,
  messageTone,
  session,
  signOut,
}: {
  metrics: { productCount: number; launchCandidates: number; needsProof: number; tastingEntries: number };
  labState: LabState;
  message: string;
  messageTone: "good" | "bad" | "info";
  session: Session | null;
  signOut: () => void;
}) {
  const productsNeedingProof = getProductsNeedingProof(labState.products, labState.batches);
  const proofDayCopy = productsNeedingProof.length
    ? `Test ${productsNeedingProof.map((product) => product.name).join(", ")}. Capture yield, timing, texture, packaging behavior, freshness after 12/24 hours, and willingness to pay.`
    : "Every product has at least one proof batch logged. Pick the weakest formula and run a focused retest.";
  const inventoryCounts = getInventorySummaryCounts(labState.ingredients, getToday());

  return (
    <div className="space-y-5">
      <section className="grid gap-4 xl:grid-cols-[1.5fr_0.8fr]" id="dashboard">
        <div className="rounded-lg border border-[#e1d4c4] bg-[#fffaf3] p-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={<Beaker size={20} />} label="Products" value={metrics.productCount} detail="Starter candidates" />
            <MetricCard icon={<ClipboardCheck size={20} />} label="Launch-ready" value={metrics.launchCandidates} detail="Target after proof" />
            <MetricCard icon={<FlaskConical size={20} />} label="Need batches" value={metrics.needsProof} detail="Proof logs missing" />
            <MetricCard icon={<Star size={20} />} label="Taste entries" value={metrics.tastingEntries} detail="Target: 5 each" />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <MetricCard icon={<AlertTriangle size={20} />} label="Low stock" value={inventoryCounts.lowCount} detail="Ingredients running low" />
            <MetricCard icon={<PackageX size={20} />} label="Out of stock" value={inventoryCounts.outCount} detail="Ingredients at zero" />
            <MetricCard icon={<CalendarClock size={20} />} label="Expiring" value={inventoryCounts.expiringCount} detail={`Within ${DEFAULT_EXPIRES_SOON_DAYS} days or already past`} />
          </div>
          <div className="mt-5 rounded-md border border-[#e7d8c9] bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="rounded-md bg-[#f8ead9] p-2 text-[#9a5b2f]"><CalendarDays size={20} /></span>
              <div>
                <h3 className="font-semibold">Next Product Proof Day</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-[#6f5a4c]">
                  {proofDayCopy}
                </p>
              </div>
            </div>
          </div>
        </div>
        <aside className="rounded-lg border border-[#e1d4c4] bg-[#231813] p-5 text-[#fff8ef]">
          <div className="flex items-center gap-2 text-[#ddb778]"><ShieldAlert size={20} /><p className="text-sm font-semibold uppercase tracking-[0.16em]">Guardrails</p></div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Coffee is not a hero yet.</h3>
            {session ? <button className="text-sm text-[#ddb778] underline" onClick={signOut}>Sign out</button> : null}
          </div>
          <p className="mt-3 text-sm leading-6 text-[#e6d3c4]">Bottled coffee stays as an add-on test until it proves freshness, cold delivery, margin, and premium feel.</p>
          {message ? <MessageBox message={message} tone={messageTone} dark /> : null}
        </aside>
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        <ReadinessPanels labState={labState} />
      </section>
    </div>
  );
}

function ProductReadiness({ labState }: { labState: LabState }) {
  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white">
      <div className="flex flex-col gap-3 border-b border-[#eaded2] p-5 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Product decisions</p><h3 className="mt-1 text-xl font-semibold">Launch readiness by product</h3></div>
        <p className="max-w-md text-sm leading-6 text-[#6f5a4c]">Saved in this browser for now. Supabase will make this shared for both users.</p>
      </div>
      <div className="divide-y divide-[#f0e4d8]">
        {labState.products.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No products yet. Add one from the Product Admin page.</p> : null}
        {labState.products.map((product) => {
          const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
          const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings, labState.sellingFormats, labState.sellingFormatPackagingLines);
          return (
            <article className="grid gap-4 p-4 md:grid-cols-[92px_1fr_170px]" key={product.id}>
              <div className="relative h-24 overflow-hidden rounded-md border border-[#eaded2] bg-[#fbf2e8]">
                {product.image ? <Image src={product.image} alt={product.name} fill sizes="92px" className="object-contain p-2" /> : <div className="flex h-full items-center justify-center text-xs text-[#a88b6f]">No photo</div>}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{product.name}</h4><Tag tone="warm">{product.role}</Tag><Tag tone={product.category === "Coffee" ? "danger" : "green"}>{getProductPriority(product)}</Tag></div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6f5a4c]">{product.description}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-4"><StatusPill label={`${stats.proofBatches} batches`} done={stats.proofBatches > 0} /><StatusPill label="Costing" done={stats.costingDone} /><StatusPill label={`${stats.tastingCount}/5 tastings`} done={stats.tastingCount >= 5} /><StatusPill label={`Decision: ${stats.latestDecision}`} done={stats.latestDecision === "launch"} /></div>
              </div>
              <div className="self-center">
                <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium">Readiness</span><span>{readiness.percent}%</span></div>
                <div className="h-2 rounded-full bg-[#f0e3d6]"><div className="h-2 rounded-full bg-[#8f5632]" style={{ width: `${readiness.percent}%` }} /></div>
                <p className="mt-3 text-xs text-[#6f5a4c]">{readiness.passed}/{readiness.total} gates passed</p>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function DecisionSidebar({ labState }: { labState: LabState }) {
  const latestJournal = labState.journal.slice(0, 3);

  return (
    <div className="space-y-5">
      <Panel title="Launch gates" icon={<PackageCheck size={18} />}>
        <ul className="space-y-3 text-sm text-[#5f4a3d]">
          {readinessRules.map((rule) => (
            <li className="flex gap-2" key={rule}>
              <CheckCircle2 className="mt-0.5 shrink-0 text-[#9a5b2f]" size={16} />
              <span>{rule}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Journey signals" icon={<NotebookPen size={18} />}>
        <div className="space-y-3">
          {latestJournal.length === 0 ? <p className="text-sm text-[#6f5a4c]">No Journey entries yet. Save one after real kitchen work.</p> : null}
          {latestJournal.map((entry) => (
            <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3" key={entry.id}>
              <p className="text-sm font-semibold">{productName(entry.productId, labState.products)} — {entry.entryDate}</p>
              <p className="mt-1 text-sm leading-5 text-[#6f5a4c]">{entry.lessonLearned || entry.whatWasMade || "No lesson logged yet"}</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{entry.nextAction || "Next action not set"}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function BatchForm({
  batch,
  batches,
  batchPhotos,
  cancelEdit,
  deleteBatchPhoto,
  ingredients,
  products,
  saveBatch,
  supplies,
  uploadBatchPhotos,
}: {
  batch: ProductBatch | null;
  batches: ProductBatch[];
  batchPhotos: BatchPhoto[];
  cancelEdit: () => void;
  deleteBatchPhoto: (photo: BatchPhoto) => void;
  ingredients: Ingredient[];
  products: Product[];
  saveBatch: (formData: FormData) => void;
  supplies: SupplyEntry[];
  uploadBatchPhotos: (batchId: string, files: FileList | File[]) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(batch?.id ?? null);
  // Generated once and reused as the batch's real id, even before it's saved -- lets photos be
  // staged and uploaded against a real batch_id the moment the save succeeds, instead of only
  // being addable after the record already exists and you're back on the Batches list.
  const [formBatchId] = useState(() => batch?.id ?? crypto.randomUUID());
  const [stagedPhotos, setStagedPhotos] = useState<Array<{ file: File; previewUrl: string; rowId: string }>>([]);
  const [isSavingWithPhotos, setIsSavingWithPhotos] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState(batch?.productId ?? products[0]?.id ?? "");
  const [formulaMessage, setFormulaMessage] = useState("");
  const [formulaRows, setFormulaRows] = useState<BatchFormulaRow[]>(() => {
    const savedRows = parseBatchIngredients(batch?.ingredientsNotes ?? "");
    if (savedRows.length > 0) {
      return savedRows;
    }

    return buildFormulaRowsFromPreviousBatch(batches.find((item) => item.productId === (batch?.productId ?? products[0]?.id ?? "")));
  });

  const [processStepRows, setProcessStepRows] = useState<BatchProcessStepRow[]>(() => {
    const savedSteps = parseBatchProcessSteps(batch?.ingredientsNotes ?? "");
    if (savedSteps.length > 0) {
      return savedSteps.map((text) => ({ rowId: crypto.randomUUID(), text }));
    }
    return [{ rowId: crypto.randomUUID(), text: "" }];
  });
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const stepRowElements = useRef(new Map<string, HTMLDivElement>());
  const processStepInputElements = useRef(new Map<string, HTMLInputElement>());
  // Tracks the word currently being typed in a process-step field (rowId + character range),
  // so a suggestion inserts *that word* -- not the whole field -- letting a step reference
  // several ingredients ("25g Cocoa Powder and 100g Brown Sugar") one at a time.
  const [ingredientSuggestion, setIngredientSuggestion] = useState<{ rowId: string; wordStart: number; wordEnd: number; query: string } | null>(null);

  const stepNameSuggestions = Array.from(
    new Set([
      ...formulaRows.map((row) => row.step),
      ...batches.flatMap((item) => parseBatchIngredients(item.ingredientsNotes).map((row) => row.step)),
    ]),
  ).filter(Boolean).sort();

  // Sourced from this batch's own formula (with quantity/unit), not all-time ingredient history,
  // so a suggestion can only offer an ingredient that's actually in the formula right now, with
  // the exact quantity used -- that's what keeps Process Steps from drifting from Ingredients.
  // Substring match anywhere in the name, not just a prefix -- "Vanhouten Dark Chocolate
  // Compound" should still surface for "chocolate" or "cocoa", not just "vanhouten".
  const ingredientSuggestionMatches = ingredientSuggestion
    ? formulaRows.filter((row) => row.ingredient && row.ingredient.toLowerCase().includes(ingredientSuggestion.query.toLowerCase()))
    : [];

  function addFormulaRow() {
    setFormulaRows((current) => [...current, { brand: "", change: "", ingredient: "", previousQuantity: 0, quantity: 0, rowId: crypto.randomUUID(), step: "", unit: "" }]);
  }

  function changeProduct(productId: string) {
    setSelectedProductId(productId);
    if (!batch) {
      setFormulaRows(buildFormulaRowsFromPreviousBatch(batches.find((item) => item.productId === productId)));
    }
  }

  function updateFormulaRow(rowId: string, changes: Partial<BatchFormulaRow>) {
    setFormulaRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...changes } : row));
  }

  function addProcessStepRow() {
    setProcessStepRows((current) => [...current, { rowId: crypto.randomUUID(), text: "" }]);
  }

  function updateProcessStepRow(rowId: string, text: string) {
    setProcessStepRows((current) => current.map((row) => (row.rowId === rowId ? { ...row, text } : row)));
  }

  function getCurrentWordRange(text: string, cursorIndex: number) {
    const beforeCursor = text.slice(0, cursorIndex);
    const wordStart = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf(",")) + 1;
    return { wordStart, wordEnd: cursorIndex };
  }

  function handleProcessStepChange(rowId: string, event: ReactChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    const cursorIndex = event.target.selectionStart ?? text.length;
    updateProcessStepRow(rowId, text);

    const { wordStart, wordEnd } = getCurrentWordRange(text, cursorIndex);
    const query = text.slice(wordStart, wordEnd).trim();
    setIngredientSuggestion(query.length > 0 ? { rowId, wordStart, wordEnd, query } : null);
  }

  function insertIngredientIntoStep(formulaRow: BatchFormulaRow) {
    if (!ingredientSuggestion) {
      return;
    }
    const { rowId, wordStart, wordEnd } = ingredientSuggestion;
    const row = processStepRows.find((item) => item.rowId === rowId);
    if (!row) {
      return;
    }

    const insertText = `${formulaRow.quantity}${formulaRow.unit} ${formulaRow.ingredient}`;
    const newText = `${row.text.slice(0, wordStart)}${insertText} ${row.text.slice(wordEnd)}`;
    updateProcessStepRow(rowId, newText);
    setIngredientSuggestion(null);

    const cursorPosition = wordStart + insertText.length + 1;
    requestAnimationFrame(() => {
      const element = processStepInputElements.current.get(rowId);
      element?.focus();
      element?.setSelectionRange(cursorPosition, cursorPosition);
    });
  }

  function handleProcessStepKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!ingredientSuggestion || ingredientSuggestionMatches.length === 0) {
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertIngredientIntoStep(ingredientSuggestionMatches[0]);
    } else if (event.key === "Escape") {
      setIngredientSuggestion(null);
    }
  }

  // Reorders live as the pointer crosses each row's midpoint, so forgetting a step and dragging
  // it into place feels immediate instead of drop-to-commit. Pointer Events (not HTML5 DnD) so
  // this works the same with a mouse or a finger on the phone Aly actually uses in the kitchen.
  function startStepDrag(event: ReactPointerEvent<HTMLButtonElement>, rowId: string) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingStepId(rowId);
  }

  function dragStep(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!draggingStepId) {
      return;
    }
    const pointerY = event.clientY;
    const others = processStepRows.filter((row) => row.rowId !== draggingStepId);
    let targetIndex = others.length;
    for (let index = 0; index < others.length; index += 1) {
      const element = stepRowElements.current.get(others[index].rowId);
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        targetIndex = index;
        break;
      }
    }

    const draggingRow = processStepRows.find((row) => row.rowId === draggingStepId);
    if (!draggingRow) {
      return;
    }
    others.splice(targetIndex, 0, draggingRow);
    if (others.some((row, index) => row.rowId !== processStepRows[index]?.rowId)) {
      setProcessStepRows(others);
    }
  }

  function endStepDrag() {
    setDraggingStepId(null);
  }

  async function pasteFormulaFromClipboard() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      setFormulaMessage("Clipboard paste is not available in this browser. Open the app in the deployed HTTPS page and try again.");
      return;
    }

    const clipboardText = await navigator.clipboard.readText();
    const pastedRows = parseFormulaText(clipboardText, supplies, ingredients);
    if (pastedRows.length === 0) {
      setFormulaMessage("No formula rows found in clipboard.");
      return;
    }

    setFormulaRows(pastedRows);
    setFormulaMessage(`Pasted ${pastedRows.length} formula row${pastedRows.length === 1 ? "" : "s"}. Edit quantities to create the V2 adjustments.`);
  }

  async function submitBatch(formData: FormData) {
    setIsSavingWithPhotos(stagedPhotos.length > 0);
    await saveBatch(formData);
    if (stagedPhotos.length > 0) {
      await uploadBatchPhotos(formBatchId, stagedPhotos.map((item) => item.file));
      stagedPhotos.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setStagedPhotos([]);
    }
    setIsSavingWithPhotos(false);
  }

  return (
    <FormPanel ref={editorRef} title={batch ? "Edit proof batch" : "Proof batch record"} icon={<FlaskConical size={18} />}>
      {batch ? (
        <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">
          Editing: {batchDisplayName(batch.productId, batch.batchVersion, products)}
        </p>
      ) : null}
      <form action={submitBatch} className="grid gap-3" key={batch?.id ?? "new-batch"}>
        <input name="id" type="hidden" value={formBatchId} />
        <input name="existingId" type="hidden" value={batch?.id ?? ""} />
        <input name="batchIngredientRowIds" type="hidden" value={formulaRows.map((row) => row.rowId).join(",")} />
        <input name="batchProcessStepRowIds" type="hidden" value={processStepRows.map((row) => row.rowId).join(",")} />
        <datalist id="formulaStepSuggestions">
          {stepNameSuggestions.map((step) => <option key={step} value={step} />)}
        </datalist>
        <ProductSelect onChange={(event) => changeProduct(event.target.value)} products={products} value={selectedProductId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="batchVersion" label="Batch/version tested" placeholder="Brownies V2 - less sugar" defaultValue={batch?.batchVersion} helper="Name the exact test, not just V1/V2." ref={fieldRef} />
          <Input name="dateMade" label="Date made" type="date" defaultValue={batch?.dateMade ?? getToday()} />
        </div>
        <Textarea
          name="tasteNotes"
          label="Process change and quality result"
          defaultValue={batch?.tasteNotes}
          placeholder="Changed bake time from 28 to 25 min. Taste: less dry, chocolate stronger, top still clean."
        />
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Formula / ingredients tested</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Record the actual formula. Use change notes for +10g sugar, less butter, new cocoa, etc. Use Step when the same ingredient is added more than once, like Cocoa powder in both First mix and Final mix.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={pasteFormulaFromClipboard} type="button">Paste formula</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addFormulaRow} type="button">Add ingredient</button>
            </div>
          </div>
          {formulaMessage ? <p className="mt-3 rounded-md border border-[#ead9c8] bg-white px-3 py-2 text-sm text-[#5f4a3d]">{formulaMessage}</p> : null}
          <div className="mt-3 grid gap-3">
            {formulaRows.map((row, index) => (
              <div className="grid gap-2 lg:grid-cols-[minmax(220px,2fr)_100px_80px_130px_150px_170px_70px]" key={row.rowId}>
                <SupplyItemPicker ingredients={ingredients} row={row} rowIndex={index} supplies={supplies} updateFormulaRow={updateFormulaRow} />
                <Input name={`batchQuantity-${row.rowId}`} label="Qty" type="number" step="0.01" placeholder="50" value={row.quantity || ""} onChange={(event) => updateFormulaRow(row.rowId, { quantity: Number(event.target.value || 0) })} />
                <Input name={`batchUnit-${row.rowId}`} label="Unit used" placeholder="g / ml / tbsp" value={row.unit} onChange={(event) => updateFormulaRow(row.rowId, { unit: event.target.value })} />
                <Input list="formulaStepSuggestions" name={`batchIngredientStep-${row.rowId}`} label="Step" placeholder="First mix" value={row.step} onChange={(event) => updateFormulaRow(row.rowId, { step: event.target.value })} />
                <div className="grid gap-1 text-sm font-medium">
                  Previous
                  <p className="flex h-10 items-center rounded-md border border-[#ead9c8] bg-white px-3 text-[#6f5a4c]">{row.previousQuantity === undefined ? "No previous" : `${row.previousQuantity || 0}${row.unit ? ` ${row.unit}` : ""}`}</p>
                </div>
                <div className="grid gap-1 text-sm font-medium">
                  Auto adjustment
                  <input name={`batchChange-${row.rowId}`} type="hidden" value={getFormulaAdjustment(row)} />
                  <p className="flex h-10 items-center rounded-md border border-[#ead9c8] bg-white px-3 text-[#6f5a4c]">{getFormulaAdjustment(row) || "No change yet"}</p>
                </div>
                <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => setFormulaRows((current) => current.filter((item) => item.rowId !== row.rowId))} type="button">Remove</button>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Process steps</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Write the actual method in order. Match the wording used in the formula&apos;s Step field, like First mix or Final mix.</p>
            </div>
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addProcessStepRow} type="button">Add step</button>
          </div>
          <div className="mt-3 grid gap-2">
            {processStepRows.map((row, index) => (
              <div
                className={`grid grid-cols-[28px_1fr_70px] gap-2 rounded-md ${draggingStepId === row.rowId ? "bg-white/60 opacity-70" : ""}`}
                key={row.rowId}
                ref={(element) => {
                  if (element) {
                    stepRowElements.current.set(row.rowId, element);
                  } else {
                    stepRowElements.current.delete(row.rowId);
                  }
                }}
              >
                <button
                  aria-label={`Drag to reorder step ${index + 1}`}
                  className="mt-6 flex h-10 cursor-grab items-center justify-center rounded-md border border-[#d8c7b7] bg-white text-[#8a6a54] touch-none active:cursor-grabbing"
                  onPointerDown={(event) => startStepDrag(event, row.rowId)}
                  onPointerMove={dragStep}
                  onPointerUp={endStepDrag}
                  onPointerCancel={endStepDrag}
                  type="button"
                >
                  <GripVertical size={16} />
                </button>
                <div className="relative">
                  <Input
                    name={`batchProcessStep-${row.rowId}`}
                    label={`Step ${index + 1}`}
                    placeholder="Cream butter and sugar for 3 minutes"
                    value={row.text}
                    onChange={(event) => handleProcessStepChange(row.rowId, event)}
                    onKeyDown={handleProcessStepKeyDown}
                    onFocus={(event) => processStepInputElements.current.set(row.rowId, event.currentTarget)}
                    onBlur={() => setTimeout(() => setIngredientSuggestion((current) => (current?.rowId === row.rowId ? null : current)), 150)}
                    autoComplete="off"
                  />
                  {ingredientSuggestion?.rowId === row.rowId && ingredientSuggestionMatches.length > 0 ? (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-[#d8c7b7] bg-white shadow-md">
                      {ingredientSuggestionMatches.map((formulaRow) => (
                        <button
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[#fffaf3]"
                          key={formulaRow.rowId}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            insertIngredientIntoStep(formulaRow);
                          }}
                          type="button"
                        >
                          <span className="font-semibold">{formulaRow.ingredient}</span>
                          <span className="text-[#8a6a54]"> — {formulaRow.quantity}{formulaRow.unit}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => setProcessStepRows((current) => current.filter((item) => item.rowId !== row.rowId))} type="button">Remove</button>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input name="prepTimeMinutes" label="Prep minutes" type="number" placeholder="35" defaultValue={batch?.prepTimeMinutes || undefined} />
          <Input name="bakeTimeMinutes" label="Cook/bake minutes" type="number" placeholder="25" defaultValue={batch?.bakeTimeMinutes || undefined} />
          <Input name="coolingTimeMinutes" label="Cooling/set minutes" type="number" placeholder="60" defaultValue={batch?.coolingTimeMinutes || undefined} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input name="usablePieces" label="Sellable pieces" type="number" placeholder="12" defaultValue={batch?.usablePieces || undefined} helper="Pieces you would feel okay selling." />
          <Input name="imperfectPieces" label="Reject/test pieces" type="number" placeholder="2" defaultValue={batch?.imperfectPieces || undefined} helper="Broken, ugly, underdone, overdone, or used for testing." />
          <Input name="stressLevel" label="Kitchen difficulty 1-5" type="number" min="1" max="5" defaultValue={batch?.stressLevel ?? 3} helper="1 easy, 5 too stressful for preorder days." />
        </div>
        <Textarea
          name="textureNotes"
          label="Freshness and packaging result"
          defaultValue={batch?.textureNotes}
          placeholder="After 2 hours: still fudgy. In box: top smudged slightly. Needs liner before delivery test."
        />
        <Textarea name="wentWrong" label="Main issue found" placeholder="Example: Edges overbaked before center set; box trapped steam; drink separated after 20 minutes." defaultValue={batch?.wentWrong} />
        <Textarea name="improveNext" label="Next test only" placeholder="Example: Retest at 24 min, cool 90 min before cutting, compare two box liners." defaultValue={batch?.improveNext} />
        <Select name="launchDecision" label="Current decision" options={["retest", "launch", "pause", "remove"]} defaultValue={batch?.launchDecision ?? "retest"} />
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <p className="text-sm font-semibold">Photos</p>
          {batch ? (
            <>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Uploads immediately, no need to save first.</p>
              <BatchPhotosSection batchId={batch.id} deleteBatchPhoto={deleteBatchPhoto} photos={batchPhotos.filter((photo) => photo.batchId === batch.id)} uploadBatchPhotos={uploadBatchPhotos} />
            </>
          ) : (
            <>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Attach photos now — they upload automatically the moment you save this batch, not after.</p>
              <label className="mt-3 inline-flex h-9 cursor-pointer items-center rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]">
                Add photo
                <input
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  multiple
                  onChange={(event) => {
                    const files = event.target.files;
                    if (files && files.length > 0) {
                      setStagedPhotos((current) => [
                        ...current,
                        ...Array.from(files).map((file) => ({ file, previewUrl: URL.createObjectURL(file), rowId: crypto.randomUUID() })),
                      ]);
                    }
                    event.target.value = "";
                  }}
                  type="file"
                />
              </label>
              {stagedPhotos.length > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                  {stagedPhotos.map((staged) => (
                    <div className="relative aspect-square overflow-hidden rounded-md border border-[#ead9c8] bg-white" key={staged.rowId}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local blob: preview URL, not a static/local asset path */}
                      <img alt={staged.file.name} className="h-full w-full object-cover" src={staged.previewUrl} />
                      <button
                        aria-label="Remove staged photo"
                        className="absolute right-1 top-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs font-semibold text-white"
                        onClick={() => {
                          URL.revokeObjectURL(staged.previewUrl);
                          setStagedPhotos((current) => current.filter((item) => item.rowId !== staged.rowId));
                        }}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={isSavingWithPhotos}>{isSavingWithPhotos ? "Saving + uploading photos..." : batch ? "Update batch" : "Save batch"}</Button>
          {batch ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
    </FormPanel>
  );
}

function ProofBatchGuide() {
  return (
    <Panel title="What This Page Proves" icon={<ClipboardCheck size={18} />}>
      <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
        <p>Use one record per real kitchen test. The goal is to decide what changes next, not to write a diary.</p>
        <ul className="space-y-2">
          <li><strong>Quality:</strong> taste, texture, appearance.</li>
          <li><strong>Repeatability:</strong> timing, yield, kitchen difficulty.</li>
          <li><strong>Customer fit:</strong> freshness, packaging, delivery risk.</li>
        </ul>
      </div>
    </Panel>
  );
}

function ProofDayChecklist() {
  const groups = [
    {
      title: "Before making",
      items: ["Pick one product and one test change", "Weigh ingredients before mixing", "Set phone timer for each stage"],
    },
    {
      title: "During making",
      items: ["Record prep, cook/bake, and cooling time", "Note anything that slows the kitchen down", "Capture one process clip if hands are clean"],
    },
    {
      title: "After making",
      items: ["Count sellable vs reject pieces", "Taste after cooling, not only while warm", "Pack one sample the way a customer would receive it"],
    },
    {
      title: "Freshness check",
      items: ["Check after 2 hours", "Check after 12 or 24 hours if relevant", "Log the next test before cleaning up"],
    },
  ];

  return (
    <Panel title="Proof Day Checklist" icon={<CheckCircle2 size={18} />}>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="text-sm font-semibold">{group.title}</p>
            <div className="mt-2 space-y-2">
              {group.items.map((item) => (
                <label className="flex items-start gap-2 text-sm leading-5 text-[#5f4a3d]" key={item}>
                  <input className="mt-0.5 h-4 w-4 accent-[#8f5632]" type="checkbox" />
                  <span>{item}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

type CostingUtilityRow = { cost: number; name: string; note: string; rowId: string };
type CostingNamedCostRow = { cost: number; name: string; note: string; rowId: string };
type CostingGasDetail = { equipmentName: string; gasKg: number; gasPrice: number; gasUseKgPerHour: number };
type CostingElectricityDetail = { applianceWatts: number; equipmentName: string; ratePerKwh: number; minutes: number };
type CostingWaterDetail = { litersUsed: number; ratePerCubicMeter: number };
type CostingLaborDetail = {
  activeRate: number;
  cleaningMinutes: number;
  cookingMinutes: number;
  coolingMinutes: number;
  packagingMinutes: number;
  prepMinutes: number;
};
type EquipmentUsageRow = { equipmentId: string; rowId: string; sharedBatches: number };

const defaultPackagingComponents = ["Box", "Sticker", "Cup", "Lid", "Sleeve", "Label", "Bag", "Napkin", "Tape"];
const defaultOverheadRows = ["Rent", "Internet", "POS Subscription", "Cleaning Supplies", "Equipment Maintenance", "Business Permits", "Accounting", "Miscellaneous"];
const defaultWasteRows = ["Ingredient Waste", "Production Waste", "Packaging Waste", "Unsold Inventory", "Spoilage", "Returned Products"];


function getBrandFromCostingNote(note: string) {
  return note.match(/^Brand: ([^/]+)/)?.[1]?.trim() ?? "";
}

function getCostingNoteWithoutBrand(note: string) {
  return note.replace(/^Brand: [^/]+\/?\s*/, "").trim();
}

function buildCostingSupplierNote(brandName: string, note: string) {
  const cleanNote = getCostingNoteWithoutBrand(note);
  return [brandName ? `Brand: ${brandName}` : "", cleanNote].filter(Boolean).join(" / ");
}

function getCostingYieldFromNotes(notes: string) {
  return Number(notes.match(/^Costing yield: ([\d.]+)/m)?.[1] ?? 0);
}

function getCostingBaseNotes(notes: string) {
  return notes
    .split("\n")
    .filter((line) => !line.startsWith("Costing yield:") && !line.startsWith("Utilities:") && !line.startsWith("Gas:") && !line.startsWith("Electricity:") && !line.startsWith("Water:") && !line.startsWith("Professional costing detail:"))
    .join("\n")
    .trim();
}

function getCostingStructuredDetail(notes: string) {
  const rawJson = notes.match(/^Professional costing detail: (.+)$/m)?.[1];
  if (!rawJson) {
    return null;
  }

  try {
    return JSON.parse(rawJson) as {
      electricityDetail?: CostingElectricityDetail;
      equipmentUsage?: EquipmentUsageRow[];
      gasDetail?: CostingGasDetail;
      laborDetail?: CostingLaborDetail;
      overheadRows?: CostingNamedCostRow[];
      packagingRows?: CostingNamedCostRow[];
      targetFoodCost?: number;
      utilityRows?: CostingUtilityRow[];
      waterDetail?: CostingWaterDetail;
      wasteRows?: CostingNamedCostRow[];
    };
  } catch {
    return null;
  }
}

function compactNamedCostRows(rows: CostingNamedCostRow[]) {
  return rows
    .map((row) => ({ cost: Number(row.cost || 0), name: row.name.trim(), note: row.note.trim(), rowId: row.rowId }))
    .filter((row) => row.name || row.cost > 0 || row.note);
}

function bucketUtilityRows(rows: CostingUtilityRow[]) {
  return rows.reduce(
    (buckets, row) => {
      const label = row.name.toLowerCase();
      if (label.includes("water")) {
        buckets.water += Number(row.cost || 0);
      } else if (label.includes("gas")) {
        buckets.gas += Number(row.cost || 0);
      } else if (label.includes("electric")) {
        buckets.electricity += Number(row.cost || 0);
      } else {
        buckets.other += Number(row.cost || 0);
      }
      return buckets;
    },
    { electricity: 0, gas: 0, other: 0, water: 0 },
  );
}

function compactEquipmentUsageRows(rows: EquipmentUsageRow[]) {
  return rows
    .map((row) => ({ equipmentId: row.equipmentId, rowId: row.rowId, sharedBatches: Number(row.sharedBatches || 1) }))
    .filter((row) => row.equipmentId);
}

function buildCostingStructuredDetail(detail: {
  electricityDetail: CostingElectricityDetail;
  equipmentUsage: EquipmentUsageRow[];
  gasDetail: CostingGasDetail;
  laborDetail: CostingLaborDetail;
  overheadRows: CostingNamedCostRow[];
  packagingRows: CostingNamedCostRow[];
  targetFoodCost: number;
  utilityRows: Array<{ cost: number; name: string; note: string; rowId?: string }>;
  waterDetail: CostingWaterDetail;
  wasteRows: CostingNamedCostRow[];
}) {
  return `Professional costing detail: ${JSON.stringify({
    electricityDetail: detail.electricityDetail,
    equipmentUsage: compactEquipmentUsageRows(detail.equipmentUsage),
    gasDetail: detail.gasDetail,
    laborDetail: detail.laborDetail,
    overheadRows: compactNamedCostRows(detail.overheadRows),
    packagingRows: compactNamedCostRows(detail.packagingRows),
    targetFoodCost: detail.targetFoodCost,
    utilityRows: detail.utilityRows
      .map((row) => ({ cost: Number(row.cost || 0), name: row.name.trim(), note: row.note.trim(), rowId: row.rowId }))
      .filter((row) => row.name || row.cost > 0 || row.note),
    waterDetail: detail.waterDetail,
    wasteRows: compactNamedCostRows(detail.wasteRows),
  })}`;
}

function getGasCostDetail(gasDetail: CostingGasDetail, cookingMinutes: number) {
  const pricePerKg = gasDetail.gasKg > 0 ? gasDetail.gasPrice / gasDetail.gasKg : 0;
  const costPerMinute = (gasDetail.gasUseKgPerHour / 60) * pricePerKg;
  const cost = costPerMinute * cookingMinutes;

  return { cost, costPerMinute, pricePerKg };
}

function getElectricityCostDetail(electricityDetail: CostingElectricityDetail) {
  const kwhUsed = (electricityDetail.applianceWatts / 1000) * (electricityDetail.minutes / 60);
  const cost = kwhUsed * electricityDetail.ratePerKwh;

  return { cost, kwhUsed };
}

function getWaterCostDetail(waterDetail: CostingWaterDetail) {
  const pricePerLiter = waterDetail.ratePerCubicMeter / 1000;
  const cost = waterDetail.litersUsed * pricePerLiter;

  return { cost, pricePerLiter };
}

function buildNamedCostRows(names: string[], savedRows?: CostingNamedCostRow[], fallbackCost = 0) {
  if (savedRows?.length) {
    return savedRows.map((row) => ({ ...row, rowId: row.rowId || crypto.randomUUID() }));
  }

  return names.map((name, index) => ({
    cost: index === 0 ? fallbackCost : 0,
    name,
    note: "",
    rowId: crypto.randomUUID(),
  }));
}

// A Selling Format packaging line's "current cost" for a catalog-linked item, resolved the exact
// same way -- most recent valid purchase wins, never a weighted average -- as ingredient rows
// already are (getAutoCostedIngredientRowForItems). Falls back to the ingredient's own maintained
// average only when no matching purchase history exists at all.
function resolvePackagingItemUnitCost(ingredientId: string, ingredients: Ingredient[], supplies: SupplyEntry[]): number {
  const ingredient = ingredients.find((item) => item.id === ingredientId);
  if (!ingredient) {
    return 0;
  }

  const bestMatch = getMatchingPurchaseHistoryForIngredient(supplies, ingredients, { ingredientId: ingredient.id, ingredientName: ingredient.name }, "", ingredient.baseUnit)[0];
  if (bestMatch && bestMatch.packQuantity > 0) {
    return bestMatch.totalCost / bestMatch.packQuantity;
  }

  return ingredient.averageUnitCost;
}

// Manual purchases must attach to an existing Item, not arbitrary free text -- an ingredient and
// its purchase history are one business item now (see inventory-items.ts), so a purchase logged
// under a name that doesn't match any Item silently orphans itself the same way the "Vanhouten
// Dark chocolate" bug did. "Create New Item" is the escape hatch for a genuinely new item, using
// the same saveIngredient the Items tab itself uses -- not a second, divergent creation path.
//
// Lives inside PurchaseLogPage's own <form key={supply?.id ?? "new-supply"}> (see call site), so
// switching which supply is being edited remounts this component and correctly resets its local
// state -- the same key-remount convention this file already uses for the outer form itself,
// rather than a useEffect syncing local state to a changed prop.
//
// The "Create New Item" panel below is deliberately NOT a nested <form> -- forms cannot nest in
// HTML, and this field already lives inside PurchaseLogPage's outer <form>. It reads its inputs via
// refs and builds a FormData by hand instead, matching what a real form submission would send.
function SupplyIngredientField({
  ingredients,
  initialIngredientId,
  initialIngredientName,
  isLocked = false,
  saveIngredient,
}: {
  ingredients: Ingredient[];
  initialIngredientId?: string;
  initialIngredientName: string;
  isLocked?: boolean;
  saveIngredient: (formData: FormData) => Promise<string | null>;
}) {
  const matched = ingredients.find((item) => item.id === initialIngredientId) ?? ingredients.find((item) => item.name === initialIngredientName);
  const [selectedIngredientId, setSelectedIngredientId] = useState(matched?.id ?? "");
  const [ingredientName, setIngredientName] = useState(initialIngredientName);
  const [isCreatingItem, setIsCreatingItem] = useState(false);
  const [isSavingItem, setIsSavingItem] = useState(false);
  const newNameRef = useRef<HTMLInputElement>(null);
  const newBaseUnitRef = useRef<HTMLSelectElement>(null);
  const newCategoryRef = useRef<HTMLSelectElement>(null);
  const selected = ingredients.find((item) => item.id === selectedIngredientId);

  async function handleCreateItem() {
    const formData = new FormData();
    formData.set("name", newNameRef.current?.value.trim() ?? "");
    formData.set("baseUnit", newBaseUnitRef.current?.value ?? "g");
    formData.set("category", newCategoryRef.current?.value ?? "");
    setIsSavingItem(true);
    const newIngredientId = await saveIngredient(formData);
    setIsSavingItem(false);
    if (!newIngredientId) {
      return;
    }
    setSelectedIngredientId(newIngredientId);
    setIngredientName(String(formData.get("name") || ""));
    setIsCreatingItem(false);
  }

  return (
    <label className="grid gap-1 text-sm font-medium">
      Ingredient
      <input name="ingredientId" type="hidden" value={selectedIngredientId} />
      <input name="ingredientName" type="hidden" value={ingredientName} />
      {selected ? (
        <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-[#d8c7b7] bg-white px-3">
          <span className="truncate text-sm font-semibold">{selected.name}</span>
          {isLocked ? <span className="shrink-0 text-xs font-semibold text-[#8f5632]">Locked</span> : (
            <button
              className="shrink-0 text-xs font-semibold text-[#8f5632]"
              onClick={() => {
                setSelectedIngredientId("");
                setIngredientName("");
              }}
              type="button"
            >
              Change
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <IngredientPicker
            ingredients={ingredients}
            onSelect={(ingredientId) => {
              const item = ingredients.find((entry) => entry.id === ingredientId);
              setSelectedIngredientId(ingredientId);
              setIngredientName(item?.name ?? "");
            }}
            placeholder="Cocoa powder"
          />
          <button className="shrink-0 text-xs font-semibold text-[#8f5632]" onClick={() => setIsCreatingItem((current) => !current)} type="button">
            {isCreatingItem ? "Cancel" : "Create New Item"}
          </button>
        </div>
      )}
      {isCreatingItem ? (
        <div className="mt-1 grid gap-2 rounded-md border border-[#d8c7b7] bg-[#fffaf3] p-3">
          <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-normal" defaultValue={ingredientName} placeholder="Ingredient name" ref={newNameRef} />
          <div className="grid grid-cols-2 gap-2">
            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm font-normal" defaultValue="g" ref={newBaseUnitRef}>
              {baseUnitOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm font-normal" defaultValue="" ref={newCategoryRef}>
              <option value="">Category (optional)</option>
              {ingredientCategoryOptions.map((option) => (
                <option key={option} value={option}>
                  {ingredientCategoryLabel[option]}
                </option>
              ))}
            </select>
          </div>
          <button
            className="h-8 rounded-md bg-[#8f5632] px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSavingItem}
            onClick={handleCreateItem}
            type="button"
          >
            {isSavingItem ? "Saving..." : "Save new item"}
          </button>
        </div>
      ) : null}
    </label>
  );
}

function getUniqueSupplyValues(supplies: SupplyEntry[], key: "brandName" | "ingredientName" | "supplierName" | "unit") {
  return Array.from(new Set(supplies.map((supply) => supply[key].trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function PurchaseRecordRow({
  deleteSupply,
  editSupply,
  isActive,
  supply,
}: {
  deleteSupply: (supplyId: string) => void;
  editSupply: (supply: SupplyEntry) => void;
  isActive?: boolean;
  supply: SupplyEntry;
}) {
  const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;
  const supplierLabel = supply.supplierName || "Supplier not set";
  const brandLabel = supply.brandName || "Brand not set";
  const source = "source" in supply ? String((supply as SupplyEntry & { source?: string }).source || "") : "";
  const deleteMessage = [
    `Delete this purchase record?`,
    `${brandLabel} / ${supply.ingredientName} / ${supplierLabel} / ${supply.purchaseDate || "date not set"} / ${supply.packQuantity}${supply.unit ? ` ${supply.unit}` : ""} / PHP ${supply.totalCost.toFixed(2)}`,
    "Only this purchase record will be removed.",
    "Current stock will not change.",
    "No InventoryTransaction will be created, changed, or deleted.",
  ].join("\n\n");

  return (
    <article className={`grid gap-4 p-5 lg:grid-cols-[1fr_160px_160px_120px_140px] ${isActive ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`} key={supply.id}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="green">{brandLabel}</Tag>
          <Tag tone="warm">{supplierLabel}</Tag>
          {source ? <Tag tone="warm">{source}</Tag> : null}
        </div>
        <h4 className="mt-2 font-semibold">{supply.ingredientName}</h4>
        <p className="mt-1 text-sm text-[#6f5a4c]">Bought {supply.purchaseDate || "date not set"}</p>
        {supply.notes ? <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">{supply.notes}</p> : null}
      </div>
      <div className="text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Pack</p>
        <p className="mt-1 font-semibold">{supply.packQuantity}{supply.unit ? ` ${supply.unit}` : ""}</p>
        <p className="text-[#6f5a4c]">PHP {supply.totalCost.toFixed(2)}</p>
      </div>
      <div className="text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Unit Cost</p>
        <p className="mt-1 font-semibold">PHP {unitCost.toFixed(4)}</p>
        <p className="text-[#6f5a4c]">per {supply.unit || "unit"}</p>
      </div>
      <div className="text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Quality</p>
        <p className="mt-1 font-semibold">{supply.qualityRating || 0}/5</p>
      </div>
      <div className="flex gap-2 lg:flex-col">
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editSupply(supply)} type="button">Edit</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(deleteMessage) ? deleteSupply(supply.id) : undefined} type="button">Delete</button>
      </div>
    </article>
  );
}

function SupplyValuePicker({
  label,
  name,
  onValueChange,
  options,
  placeholder,
  value,
}: {
  label: string;
  name: string;
  onValueChange?: (value: string) => void;
  options: string[];
  placeholder: string;
  value?: string;
}) {
  const [inputValue, setInputValue] = useState(value ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(inputValue.trim().toLowerCase()));

  return (
    <label className="relative grid gap-1 text-sm font-medium">
      {label}
      <div className="relative">
        <input
          autoComplete="off"
          className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 pr-10"
          name={name}
          onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
          onChange={(event) => {
            setInputValue(event.target.value);
            onValueChange?.(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          value={inputValue}
        />
        <button
          aria-label={`Show saved ${label.toLowerCase()} options`}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md border-l border-[#ead9c8] bg-[#fffaf3] text-[#6f5a4c] hover:bg-[#f5eadf]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setIsOpen((current) => !current)}
          type="button"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {isOpen ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded-md border border-[#d8c7b7] bg-white shadow-lg">
          {filteredOptions.length === 0 ? <p className="px-3 py-2 text-sm font-normal text-[#6f5a4c]">No saved {label.toLowerCase()} yet. Type a new one.</p> : null}
          {filteredOptions.map((option) => (
            <button
              className="block w-full px-3 py-2 text-left text-sm font-normal text-[#211713] hover:bg-[#fffaf3]"
              key={option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setInputValue(option);
                onValueChange?.(option);
                setIsOpen(false);
              }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}

function SupplyItemPicker({
  ingredients,
  row,
  rowIndex,
  supplies,
  updateFormulaRow,
}: {
  ingredients: Ingredient[];
  row: BatchFormulaRow;
  rowIndex: number;
  supplies: SupplyEntry[];
  updateFormulaRow: (rowId: string, changes: Partial<BatchFormulaRow>) => void;
}) {
  const [inputValue, setInputValue] = useState(row.ingredient ? getSupplyLabel({ brandName: row.brand, ingredientName: row.ingredient, unit: row.unit }) : "");
  const [isOpen, setIsOpen] = useState(false);
  const itemOptions = groupPurchasesByItem(ingredients, supplies).map((group) => {
    const latestPurchase = group.purchases[0];
    return {
      id: group.ingredient.id,
      brandName: latestPurchase?.brandName ?? "",
      ingredientName: group.ingredient.name,
      supplierName: latestPurchase?.supplierName ?? "",
      unit: latestPurchase?.unit || group.ingredient.baseUnit,
      isItem: true,
    };
  });
  const unlinkedOptions = getUnlinkedPurchases(ingredients, supplies).map((supply) => ({
    id: supply.id,
    brandName: supply.brandName,
    ingredientName: supply.ingredientName,
    supplierName: supply.supplierName,
    unit: supply.unit,
    isItem: false,
  }));
  const filteredOptions = [...itemOptions, ...unlinkedOptions].filter((option) => getSupplyLabel(option).toLowerCase().includes(inputValue.trim().toLowerCase()));

  return (
    <label className="relative grid gap-1 text-sm font-medium">
      Purchase item {rowIndex + 1}
      <input name={`batchBrand-${row.rowId}`} type="hidden" value={row.brand} />
      <input name={`batchIngredient-${row.rowId}`} type="hidden" value={row.ingredient} />
      <div className="relative">
        <input
          autoComplete="off"
          className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 pr-10"
          onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
          onChange={(event) => {
            setInputValue(event.target.value);
            updateFormulaRow(row.rowId, { brand: "", ingredient: event.target.value, unit: "" });
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder="Beryl's - Cocoa powder (g)"
          value={inputValue}
        />
        <button
          aria-label="Show purchase history items"
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md border-l border-[#ead9c8] bg-[#fffaf3] text-[#6f5a4c] hover:bg-[#f5eadf]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setIsOpen((current) => !current)}
          type="button"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {isOpen ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-[#d8c7b7] bg-white shadow-lg">
          {filteredOptions.length === 0 ? <p className="px-3 py-2 text-sm font-normal text-[#6f5a4c]">No purchase match. Log a purchase first, or type a custom ingredient.</p> : null}
          {filteredOptions.map((option) => (
            <button
              className="block w-full px-3 py-2 text-left text-sm font-normal text-[#211713] hover:bg-[#fffaf3]"
              key={option.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const label = getSupplyLabel(option);
                setInputValue(label);
                updateFormulaRow(row.rowId, { brand: option.brandName, ingredient: option.ingredientName, unit: option.unit });
                setIsOpen(false);
              }}
              type="button"
            >
              <span className="font-semibold">{getSupplyLabel(option)}</span>
              <span className="ml-2 text-[#6f5a4c]">{option.supplierName || "Supplier not set"} · {option.isItem ? "Item" : "Unlinked"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}

function NeedToBuyPage({ labState }: { labState: LabState }) {
  const items = getNeedToBuyList(labState.ingredients);

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white">
      <div className="border-b border-[#eaded2] p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Buy List</p>
        <h3 className="mt-1 text-xl font-semibold">Need to buy</h3>
        <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Ingredients at or below their low-stock threshold, with a suggested purchase quantity: target stock minus current, never below zero.</p>
      </div>
      <div className="divide-y divide-[#f0e4d8]">
        {items.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">Nothing needs buying right now.</p> : null}
        {items.map((item) => (
          <article className="grid gap-4 p-5 sm:grid-cols-[1fr_140px_160px]" key={item.id}>
            <div>
              <Tag tone={item.status === "out" ? "danger" : "warm"}>{item.status === "out" ? "Out" : "Low"}</Tag>
              <h4 className="mt-2 font-semibold">{item.name}</h4>
            </div>
            <div className="text-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Current</p>
              <p className="mt-1 font-semibold">{item.currentQuantity} {item.baseUnit}</p>
            </div>
            <div className="text-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Suggested buy</p>
              <p className="mt-1 font-semibold">{item.suggestedBuyQuantity} {item.baseUnit}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

// One Inventory page, five jobs that used to be five separate nav entries: Current Stock (what's
// on hand), Purchases (Supplier prices log + CSV import -- both are ways of recording a purchase),
// Need to Buy, History (the inventory transaction timeline), and Items (the unified ingredient +
// purchase history: add/edit/delete an item, see its brand/supplier/price/purchase history). Nothing
// here recomputes state; every tab renders the same components and callbacks that used to live
// behind their own routes.
function InventoryWorkspace({
  initialTab,
  adjustStock,
  cancelEditIngredient,
  deleteIngredient,
  editIngredient,
  hardDeleteIngredient,
  ingredient,
  isInventoryTableMissing,
  saveIngredient,
  cancelEditSupply,
  deleteSupply,
  editSupply,
  isSuppliesTableMissing,
  repairSupplyInventoryEffects,
  reverseInventoryAdjustment,
  saveSupply,
  supply,
  confirmPurchaseImport,
  createPurchaseImportDraft,
  discardPurchaseImport,
  isPurchaseImportPackagesMissing,
  restoreIngredient,
  saveIngredientAlias,
  updatePurchaseImportHeader,
  updatePurchaseImportRow,
  labState,
}: {
  initialTab?: InventoryTab;
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  cancelEditIngredient: () => void;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  hardDeleteIngredient: (ingredientId: string) => void;
  ingredient: Ingredient | null;
  isInventoryTableMissing: boolean;
  saveIngredient: (formData: FormData) => Promise<string | null>;
  cancelEditSupply: () => void;
  deleteSupply: (supplyId: string) => void;
  editSupply: (supply: SupplyEntry) => void;
  isSuppliesTableMissing: boolean;
  repairSupplyInventoryEffects: () => void;
  reverseInventoryAdjustment: (transactionId: string) => Promise<void>;
  saveSupply: (formData: FormData) => void;
  supply: SupplyEntry | null;
  confirmPurchaseImport: (importId: string) => Promise<void>;
  createPurchaseImportDraft: (fileName: string, rows: PurchaseImportRowDraft[], importSupplierName: string, importReceiptNumber: string, importPurchaseDate: string) => Promise<string | null>;
  discardPurchaseImport: (importId: string) => void;
  isPurchaseImportPackagesMissing: boolean;
  restoreIngredient: (ingredientId: string) => void;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
  updatePurchaseImportHeader: (importId: string, changes: { supplierName?: string; receiptNumber?: string; purchaseDate?: string }) => void;
  updatePurchaseImportRow: (rowId: string, changes: Partial<PurchaseImportRow>) => void;
  labState: LabState;
}) {
  const [tab, setTab] = useState<InventoryTab>(initialTab ?? "stock");
  const [purchasesTab, setPurchasesTab] = useState<"manual" | "csv">("manual");
  function logPurchaseForIngredient(item: Ingredient) {
    editSupply({
      id: "",
      ingredientId: item.id,
      ingredientName: item.name,
      brandName: "",
      supplierName: "",
      purchaseDate: getToday(),
      createdAt: new Date().toISOString(),
      packQuantity: 0,
      unit: item.baseUnit,
      totalCost: 0,
      qualityRating: 0,
      notes: "",
    });
    setPurchasesTab("manual");
    setTab("purchases");
  }

  return (
    <div className="grid gap-5">
      <div className="inline-flex w-fit flex-wrap rounded-md border border-[#d8c7b7] bg-white p-1">
        {inventoryTabs.map((item) => (
          <button
            className={`rounded px-4 py-1.5 text-sm font-semibold ${tab === item.key ? "bg-[#231813] text-white" : "text-[#5f4a3d]"}`}
            key={item.key}
            onClick={() => setTab(item.key)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "stock" ? <InventoryStockPage goToManageItems={() => setTab("ingredients")} labState={labState} /> : null}

      {tab === "purchases" ? (
        <div className="grid gap-4">
          <div className="inline-flex w-fit rounded-md border border-[#d8c7b7] bg-white p-1">
            <button
              className={`rounded px-4 py-1.5 text-sm font-semibold ${purchasesTab === "manual" ? "bg-[#231813] text-white" : "text-[#5f4a3d]"}`}
              onClick={() => setPurchasesTab("manual")}
              type="button"
            >
              Log a purchase
            </button>
            <button
              className={`rounded px-4 py-1.5 text-sm font-semibold ${purchasesTab === "csv" ? "bg-[#231813] text-white" : "text-[#5f4a3d]"}`}
              onClick={() => setPurchasesTab("csv")}
              type="button"
            >
              Import CSV
            </button>
          </div>
          {purchasesTab === "manual" ? (
            <PurchaseLogPage cancelEdit={cancelEditSupply} deleteSupply={deleteSupply} editSupply={editSupply} isSuppliesTableMissing={isSuppliesTableMissing} labState={labState} repairSupplyInventoryEffects={repairSupplyInventoryEffects} saveIngredient={saveIngredient} saveSupply={saveSupply} supply={supply} />
          ) : (
            <PurchaseImportWizard
              confirmPurchaseImport={confirmPurchaseImport}
              createPurchaseImportDraft={createPurchaseImportDraft}
              discardPurchaseImport={discardPurchaseImport}
              isInventoryTableMissing={isInventoryTableMissing}
              isPurchaseImportPackagesMissing={isPurchaseImportPackagesMissing}
              labState={labState}
              saveIngredient={saveIngredient}
              saveIngredientAlias={saveIngredientAlias}
              updatePurchaseImportHeader={updatePurchaseImportHeader}
              updatePurchaseImportRow={updatePurchaseImportRow}
            />
          )}
        </div>
      ) : null}

      {tab === "need-to-buy" ? <NeedToBuyPage labState={labState} /> : null}

      {tab === "history" ? <InventoryTimeline labState={labState} reverseInventoryAdjustment={reverseInventoryAdjustment} /> : null}

      {tab === "ingredients" ? (
        <InventoryPage adjustStock={adjustStock} cancelEdit={cancelEditIngredient} deleteIngredient={deleteIngredient} editIngredient={editIngredient} hardDeleteIngredient={hardDeleteIngredient} ingredient={ingredient} isInventoryTableMissing={isInventoryTableMissing} labState={labState} logPurchaseForIngredient={logPurchaseForIngredient} restoreIngredient={restoreIngredient} saveIngredient={saveIngredient} />
      ) : null}
    </div>
  );
}

function PurchaseLogPage({
  cancelEdit,
  deleteSupply,
  editSupply,
  isSuppliesTableMissing,
  labState,
  repairSupplyInventoryEffects,
  saveIngredient,
  saveSupply,
  supply,
}: {
  cancelEdit: () => void;
  deleteSupply: (supplyId: string) => void;
  editSupply: (supply: SupplyEntry) => void;
  isSuppliesTableMissing: boolean;
  labState: LabState;
  repairSupplyInventoryEffects: () => void;
  saveIngredient: (formData: FormData) => Promise<string | null>;
  saveSupply: (formData: FormData) => void;
  supply: SupplyEntry | null;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(supply?.id ?? null);
  // Captured once here since chronologicalPurchases.map() below shadows `supply` with its own
  // loop variable.
  const editingSupplyId = supply?.id ?? null;
  const [purchaseView, setPurchaseView] = useState<"by-item" | "all">("by-item");
  const brandOptions = getUniqueSupplyValues(labState.supplies, "brandName");
  const supplierOptions = getUniqueSupplyValues(labState.supplies, "supplierName");
  const unitOptions = getUniqueSupplyValues(labState.supplies, "unit");
  const purchaseGroups = groupPurchasesByItem(labState.ingredients, labState.supplies);
  const unlinkedPurchases = getUnlinkedPurchases(labState.ingredients, labState.supplies);
  const chronologicalPurchases = getChronologicalPurchases(labState.supplies);

  function logPurchaseForIngredient(item: Ingredient) {
    editSupply({
      id: "",
      ingredientId: item.id,
      ingredientName: item.name,
      brandName: "",
      supplierName: "",
      purchaseDate: getToday(),
      createdAt: "",
      packQuantity: 0,
      unit: item.baseUnit,
      totalCost: 0,
      qualityRating: 0,
      notes: "",
    });
  }

  function downloadPurchases() {
    downloadCsv(
      "purchases.csv",
      ["Brand", "Ingredient", "Supplier", "Date bought", "Pack qty", "Unit", "Total PHP", "Unit cost", "Quality", "Notes"],
      labState.supplies.map((supply) => [
        supply.brandName,
        supply.ingredientName,
        supply.supplierName,
        supply.purchaseDate,
        supply.packQuantity,
        supply.unit,
        supply.totalCost,
        supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0,
        supply.qualityRating,
        supply.notes,
      ]),
    );
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
      <FormPanel ref={editorRef} title={supply ? "Edit purchase" : "Log purchase"} icon={<PackageCheck size={18} />}>
        {supply ? (
          <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">
            Editing: {supply.brandName ? `${supply.brandName} ` : ""}{supply.ingredientName}
          </p>
        ) : null}
        {isSuppliesTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Purchase database fields are not ready yet. Run the latest <strong>supabase-add-supplies.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveSupply} className="grid gap-3" key={supply?.id ?? "new-supply"}>
          <input name="id" type="hidden" value={supply?.id ?? ""} />
          <div className="grid gap-3 sm:grid-cols-3">
            <SupplyValuePicker name="brandName" label="Brand" options={brandOptions} placeholder="Beryl's / Callebaut / local" value={supply?.brandName} />
            <SupplyIngredientField ingredients={labState.ingredients} initialIngredientId={supply?.ingredientId} initialIngredientName={supply?.ingredientName ?? ""} isLocked={Boolean(supply?.ingredientId && !supply.id)} saveIngredient={saveIngredient} />
            <SupplyValuePicker name="supplierName" label="Supplier" options={supplierOptions} placeholder="SM / Shopee / local baking store" value={supply?.supplierName} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Input name="purchaseDate" label="Date bought" type="date" defaultValue={supply?.purchaseDate ?? getToday()} ref={fieldRef} />
            <Input name="packQuantity" label="Pack qty" type="number" step="0.01" placeholder="1000" defaultValue={supply?.packQuantity || undefined} />
            <SupplyValuePicker name="unit" label="Unit" options={unitOptions} placeholder="g" value={supply?.unit} />
            <Input name="totalCost" label="Total PHP" type="number" step="0.01" placeholder="100" defaultValue={supply?.totalCost || undefined} />
          </div>
          <Input name="qualityRating" label="Quality rating 1-5" type="number" min="1" max="5" defaultValue={supply?.qualityRating || undefined} helper="Rate the supply itself: aroma, texture, consistency, taste impact, packaging condition." />
          <Textarea name="notes" label="Supplier and quality notes" placeholder="Darker color, stronger aroma, cheaper but clumpy, better for brownies, delivery took 3 days." defaultValue={supply?.notes} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button>{supply ? "Update purchase" : "Save purchase"}</Button>
            {supply ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
          </div>
        </form>
      </FormPanel>

      <Panel title="Purchase Comparison" icon={<Sparkles size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          <p>Use this page only for actual purchases. Costing should use this information later, but purchases are the source of truth for supplier prices and quality.</p>
          <p><strong>Example:</strong> Cocoa powder, Supplier A, 1000g, PHP 100, quality 4/5.</p>
        </div>
      </Panel>

      <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Purchase Log</p>
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="text-xl font-semibold">Purchases</h3>
            <div className="flex flex-wrap gap-2">
              <button className={`h-9 rounded-md border px-3 text-sm font-semibold ${purchaseView === "by-item" ? "border-[#8f5632] bg-[#8f5632] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"}`} onClick={() => setPurchaseView("by-item")} type="button">By Item</button>
              <button className={`h-9 rounded-md border px-3 text-sm font-semibold ${purchaseView === "all" ? "border-[#8f5632] bg-[#8f5632] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"}`} onClick={() => setPurchaseView("all")} type="button">All Purchases</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("supplies-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadPurchases} type="button">Download CSV</button>
              <button
                className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]"
                onClick={() =>
                  window.confirm(
                    "Apply every Item's full purchase history to current stock and average cost, for any Item never touched by a purchase before? This can move stock quantities and costs -- check the result against physical stock afterward.",
                  )
                    ? repairSupplyInventoryEffects()
                    : undefined
                }
                type="button"
              >
                Repair missing purchase effects
              </button>
            </div>
          </div>
          {purchaseView === "all" ? <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Transaction log: each row is one purchase record, so repeated Item names are expected.</p> : null}
        </div>
        {purchaseView === "by-item" ? (
          <div className="divide-y divide-[#f0e4d8]">
            {labState.supplies.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No purchases logged yet.</p> : null}
            {purchaseGroups.map((group) => {
              const summary = getPurchaseGroupSummary(group);
              return (
                <article className="p-5" key={group.ingredient.id}>
                  <div className="grid gap-4 lg:grid-cols-[1fr_150px_150px_150px_130px]">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag tone="green">{summary.purchaseCount} purchase{summary.purchaseCount === 1 ? "" : "s"}</Tag>
                        {summary.latestBrand ? <Tag tone="warm">{summary.latestBrand}</Tag> : null}
                        {summary.latestSupplier ? <Tag tone="warm">{summary.latestSupplier}</Tag> : null}
                      </div>
                      <h4 className="mt-2 font-semibold">{group.ingredient.name}</h4>
                      <p className="mt-1 text-sm text-[#6f5a4c]">Last bought {summary.lastPurchaseDate || "date not set"}</p>
                    </div>
                    <div className="text-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Latest Pack</p>
                      <p className="mt-1 font-semibold">{summary.latestPackage || "--"}</p>
                      <p className="text-[#6f5a4c]">PHP {summary.latestUnitCost.toFixed(4)}/unit</p>
                    </div>
                    <div className="text-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Total Bought</p>
                      <p className="mt-1 font-semibold">{summary.totalPurchasedUnit ? `${summary.totalPurchasedQuantity} ${summary.totalPurchasedUnit}` : "Mixed units"}</p>
                      <p className="text-[#6f5a4c]">{summary.averageUnitCost ? `Avg PHP ${summary.averageUnitCost.toFixed(4)}/${summary.totalPurchasedUnit}` : "Average not available"}</p>
                    </div>
                    <div className="text-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">History</p>
                      <p className="mt-1 font-semibold">{summary.purchaseCount} record{summary.purchaseCount === 1 ? "" : "s"}</p>
                    </div>
                    <div className="flex gap-2 lg:flex-col">
                      <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => logPurchaseForIngredient(group.ingredient)} type="button">Log Purchase</button>
                    </div>
                  </div>
                  <details className="mt-4 rounded-md border border-[#ead9c8] bg-[#fffaf3]">
                    <summary className="cursor-pointer p-3 text-sm font-semibold text-[#5f4a3d]">Purchase history</summary>
                    <div className="divide-y divide-[#ead9c8] bg-white">
                      {group.purchases.map((purchase) => <PurchaseRecordRow deleteSupply={deleteSupply} editSupply={editSupply} isActive={purchase.id === editingSupplyId} key={purchase.id} supply={purchase} />)}
                    </div>
                  </details>
                </article>
              );
            })}
            {unlinkedPurchases.length > 0 ? (
              <section>
                <div className="p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Unlinked purchases</p>
                  <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">These purchase records do not resolve to a current Item. Records with unknown Item IDs are kept here and are not matched by name.</p>
                </div>
                <div className="divide-y divide-[#f0e4d8]">
                  {unlinkedPurchases.map((purchase) => <PurchaseRecordRow deleteSupply={deleteSupply} editSupply={editSupply} isActive={purchase.id === editingSupplyId} key={purchase.id} supply={purchase} />)}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
        <div className="divide-y divide-[#f0e4d8]">
          {labState.supplies.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No purchases logged yet.</p> : null}
          {chronologicalPurchases.map((purchase) => <PurchaseRecordRow deleteSupply={deleteSupply} editSupply={editSupply} isActive={purchase.id === editingSupplyId} key={purchase.id} supply={purchase} />)}
        </div>
        )}
      </div>
      <SuppliesPrintReport supplies={labState.supplies} />
    </section>
  );
}

function SuppliesPrintReport({ supplies }: { supplies: SupplyEntry[] }) {
  return (
    <div className="print-report" id="supplies-print-report">
      <h1>Aly & Shin Purchase Log</h1>
      <p>Generated {getToday()}</p>
      <table>
        <thead>
          <tr>
            <th>Brand</th>
            <th>Ingredient</th>
            <th>Supplier</th>
            <th>Date</th>
            <th>Pack</th>
            <th>Total PHP</th>
            <th>Unit Cost</th>
            <th>Quality</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {supplies.map((supply) => {
            const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;
            return (
              <tr key={supply.id}>
                <td>{supply.brandName || "Brand not set"}</td>
                <td>{supply.ingredientName}</td>
                <td>{supply.supplierName || "Supplier not set"}</td>
                <td>{supply.purchaseDate}</td>
                <td>{supply.packQuantity}{supply.unit ? ` ${supply.unit}` : ""}</td>
                <td>{supply.totalCost.toFixed(2)}</td>
                <td>{unitCost.toFixed(4)} / {supply.unit || "unit"}</td>
                <td>{supply.qualityRating || 0}/5</td>
                <td>{supply.notes}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EquipmentPage({
  cancelEdit,
  deleteEquipment,
  editEquipment,
  equipment,
  isEquipmentTableMissing,
  labState,
  saveEquipment,
}: {
  cancelEdit: () => void;
  deleteEquipment: (equipmentId: string) => void;
  editEquipment: (equipment: EquipmentEntry) => void;
  equipment: EquipmentEntry | null;
  isEquipmentTableMissing: boolean;
  labState: LabState;
  saveEquipment: (formData: FormData) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(equipment?.id ?? null);
  const [calculationMode, setCalculationMode] = useState<EquipmentCalculationMode>(equipment?.calculationMode ?? "depreciation");

  function downloadEquipment() {
    downloadCsv(
      "equipment.csv",
      ["Name", "Brand", "Model", "Purchase/refill price", "Residual %", "Useful life (yr)", "Batches/week", "Maintenance %", "Batches/unit", "Gas kg", "Gas use kg/hr", "Mode", "PHP/kg", "PHP/min", `Total/batch (at ${REFERENCE_COOKING_MINUTES}min if gas)`, "Active", "Notes"],
      labState.equipment.map((item) => {
        const totals = getEquipmentTotals(item);
        return [
          item.name,
          item.brand,
          item.model,
          item.purchasePrice,
          item.residualValuePercent,
          item.usefulLifeYears,
          item.batchesPerWeek,
          item.annualMaintenancePercent,
          item.batchesPerUnit,
          item.tankSizeKg,
          item.burnRateKgPerHour,
          item.calculationMode,
          totals.pricePerKg.toFixed(2),
          totals.costPerMinute.toFixed(4),
          totals.totalPerBatch.toFixed(2),
          item.isActive ? "Active" : "Inactive",
          item.notes,
        ];
      }),
    );
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
      <FormPanel ref={editorRef} title={equipment ? "Edit equipment" : "Add equipment"} icon={<PackageCheck size={18} />}>
        {equipment ? (
          <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {equipment.name}</p>
        ) : null}
        {isEquipmentTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Equipment database fields are not ready yet. Run <strong>supabase-add-equipment.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveEquipment} className="grid gap-3" key={equipment?.id ?? "new-equipment"}>
          <input name="id" type="hidden" value={equipment?.id ?? ""} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Input name="name" label={calculationMode === "gas-burn-rate" ? "Gas name" : "Equipment name"} placeholder={calculationMode === "gas-burn-rate" ? "Gas / LPG" : "Table Oven"} defaultValue={equipment?.name} ref={fieldRef} />
            <Input name="brand" label={calculationMode === "gas-burn-rate" ? "Gas supplier / brand" : "Brand"} placeholder={calculationMode === "gas-burn-rate" ? "Petron / Solane / local" : "La Germania"} defaultValue={equipment?.brand} />
            <Input name="model" label={calculationMode === "gas-burn-rate" ? "Gas note" : "Model"} placeholder={calculationMode === "gas-burn-rate" ? "11kg refill" : "SL-100-10W"} defaultValue={equipment?.model} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="purchasePrice" label={calculationMode === "gas-burn-rate" ? "Gas refill price PHP" : "Purchase price PHP"} type="number" step="0.01" placeholder={calculationMode === "gas-burn-rate" ? "950" : "8500"} defaultValue={equipment?.purchasePrice || undefined} helper={calculationMode === "gas-burn-rate" ? "Update this whenever gas price changes." : undefined} />
            <Input name="purchaseDate" label={calculationMode === "gas-burn-rate" ? "Price date" : "Purchase date"} type="date" defaultValue={equipment?.purchaseDate ?? getToday()} />
          </div>
          <label className="grid gap-1 text-sm font-medium">
            Calculation mode
            <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" name="calculationMode" onChange={(event) => setCalculationMode(event.target.value as EquipmentCalculationMode)} value={calculationMode}>
              <option value="depreciation">Standard depreciation + maintenance (ovens, mixers, durable equipment)</option>
              <option value="replacement-reserve">Simple constant: price ÷ batches per tank/unit (small tools, consumables)</option>
              <option value="gas-burn-rate">Gas: refill price ÷ kg = cost per minute</option>
            </select>
          </label>
          {calculationMode === "depreciation" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input name="residualValuePercent" label="Residual value %" type="number" step="0.01" placeholder="10" defaultValue={equipment?.residualValuePercent ?? 10} helper="What it's worth at end of useful life, as % of purchase price." />
                <Input name="usefulLifeYears" label="Useful life (years)" type="number" step="0.5" placeholder="5" defaultValue={equipment?.usefulLifeYears ?? 5} />
                <Input name="batchesPerWeek" label="Expected batches / week" type="number" step="0.1" placeholder="4" defaultValue={equipment?.batchesPerWeek ?? 4} />
              </div>
              <Input name="annualMaintenancePercent" label="Annual maintenance % of purchase price" type="number" step="0.01" placeholder="3" defaultValue={equipment?.annualMaintenancePercent ?? 3} />
              <input name="batchesPerUnit" type="hidden" value={equipment?.batchesPerUnit || 0} />
              <input name="tankSizeKg" type="hidden" value={equipment?.tankSizeKg || 0} />
              <input name="burnRateKgPerHour" type="hidden" value={equipment?.burnRateKgPerHour || 0} />
            </>
          ) : null}
          {calculationMode === "replacement-reserve" ? (
            <>
              <Input name="batchesPerUnit" label="Batches per tank/unit" type="number" step="1" placeholder="12" defaultValue={equipment?.batchesPerUnit || undefined} helper="How many batches one purchase lasts. Example: an 11kg LPG tank at PHP 950 that lasts about 12 baking sessions." />
              <input name="residualValuePercent" type="hidden" value={equipment?.residualValuePercent ?? 0} />
              <input name="usefulLifeYears" type="hidden" value={equipment?.usefulLifeYears ?? 0} />
              <input name="batchesPerWeek" type="hidden" value={equipment?.batchesPerWeek ?? 0} />
              <input name="annualMaintenancePercent" type="hidden" value={equipment?.annualMaintenancePercent ?? 0} />
              <input name="tankSizeKg" type="hidden" value={equipment?.tankSizeKg || 0} />
              <input name="burnRateKgPerHour" type="hidden" value={equipment?.burnRateKgPerHour || 0} />
            </>
          ) : null}
          {calculationMode === "gas-burn-rate" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input name="tankSizeKg" label="Gas kg" type="number" step="0.1" placeholder="11" defaultValue={equipment?.tankSizeKg || undefined} helper="How many kg the refill/tank has." />
                <Input name="burnRateKgPerHour" label="Gas use kg/hour" type="number" step="0.01" placeholder="0.20" defaultValue={equipment?.burnRateKgPerHour || undefined} helper="If unsure, start with 0.20 kg/hour for a table oven, then adjust from real use." />
              </div>
              <input name="residualValuePercent" type="hidden" value={equipment?.residualValuePercent ?? 0} />
              <input name="usefulLifeYears" type="hidden" value={equipment?.usefulLifeYears ?? 0} />
              <input name="batchesPerWeek" type="hidden" value={equipment?.batchesPerWeek ?? 0} />
              <input name="annualMaintenancePercent" type="hidden" value={equipment?.annualMaintenancePercent ?? 0} />
              <input name="batchesPerUnit" type="hidden" value={equipment?.batchesPerUnit || 0} />
            </>
          ) : null}
          <Textarea name="notes" label="Notes" placeholder="Condition, warranty, where it lives, replacement plan." defaultValue={equipment?.notes} />
          <label className="flex items-center gap-2 text-sm font-medium">
            <input defaultChecked={equipment ? equipment.isActive : true} name="isActive" type="checkbox" />
            Active (available to assign to recipes)
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button>{equipment ? "Update equipment" : "Save equipment"}</Button>
            {equipment ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
          </div>
        </form>
      </FormPanel>

      <Panel title="How the numbers are calculated" icon={<Sparkles size={18} />}>
        <div className="space-y-2 text-sm leading-6 text-[#5f4a3d]">
          <p><strong>Standard depreciation mode</strong> (ovens, mixers): Depreciation/batch = (Purchase price − Residual value) ÷ (Batches/week × 52 × Useful life). Maintenance/batch = (Purchase price × Maintenance %) ÷ (Batches/week × 52).</p>
          <p><strong>Simple constant mode</strong> (small tools, consumables): Cost/batch = Purchase price ÷ Batches per tank/unit.</p>
          <p><strong>Gas mode</strong>: PHP/kg = refill price ÷ gas kg. PHP/min = PHP/kg × gas use kg/hour ÷ 60. Recipe gas cost = PHP/min × cooking minutes. Update refill price whenever gas price changes.</p>
          <p>These are calculated live below from the fields on the left — never typed in manually. Assign equipment to a recipe from the Costing page&apos;s Equipment Usage section.</p>
        </div>
      </Panel>

      <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Equipment Database</p>
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="text-xl font-semibold">Saved equipment</h3>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("equipment-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadEquipment} type="button">Download CSV</button>
            </div>
          </div>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {labState.equipment.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No equipment saved yet.</p> : null}
          {labState.equipment.map((item) => {
            const totals = getEquipmentTotals(item);
            return (
              <article className={`grid gap-4 p-5 lg:grid-cols-[1fr_150px_150px_150px_70px] ${item.id === equipment?.id ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`} key={item.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={item.isActive ? "green" : "danger"}>{item.isActive ? "Active" : "Inactive"}</Tag>
                    <Tag tone="warm">{item.calculationMode === "gas-burn-rate" ? "Gas per minute" : item.calculationMode === "replacement-reserve" ? "Simple constant" : "Standard depreciation"}</Tag>
                  </div>
                  <h4 className="mt-2 font-semibold">{item.brand ? `${item.brand} ` : ""}{item.name}{item.model ? ` (${item.model})` : ""}</h4>
                  <p className="mt-1 text-sm text-[#6f5a4c]">
                    {item.calculationMode === "gas-burn-rate"
                      ? `PHP ${item.purchasePrice.toFixed(2)} / ${item.tankSizeKg}kg = PHP ${totals.pricePerKg.toFixed(2)}/kg · PHP ${totals.costPerMinute.toFixed(4)}/min · at ${REFERENCE_COOKING_MINUTES}min: PHP ${totals.totalPerBatch.toFixed(2)}`
                      : item.calculationMode === "replacement-reserve"
                        ? `PHP ${item.purchasePrice.toFixed(2)} ÷ ${item.batchesPerUnit} batches`
                        : `PHP ${item.purchasePrice.toFixed(2)} · ${item.batchesPerWeek}/week · ${item.usefulLifeYears}yr life`}
                  </p>
                  {item.notes ? <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">{item.notes}</p> : null}
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{item.calculationMode === "gas-burn-rate" ? "Gas PHP/kg" : "Depreciation (calc)"}</p>
                  <p className="mt-1 font-semibold">PHP {item.calculationMode === "gas-burn-rate" ? totals.pricePerKg.toFixed(2) : totals.depreciationPerBatch.toFixed(2)}</p>
                  <p className="text-[#6f5a4c]">{item.calculationMode === "gas-burn-rate" ? "per kg" : "per batch"}</p>
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{item.calculationMode === "gas-burn-rate" ? "Gas PHP/min" : "Maintenance (calc)"}</p>
                  <p className="mt-1 font-semibold">PHP {item.calculationMode === "gas-burn-rate" ? totals.costPerMinute.toFixed(4) : totals.maintenancePerBatch.toFixed(2)}</p>
                  <p className="text-[#6f5a4c]">{item.calculationMode === "gas-burn-rate" ? "per minute" : "per batch"}</p>
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Total (calc)</p>
                  <p className="mt-1 font-semibold">PHP {totals.totalPerBatch.toFixed(2)}</p>
                  <p className="text-[#6f5a4c]">per batch</p>
                </div>
                <div className="flex gap-2 lg:flex-col">
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editEquipment(item)} type="button">Edit</button>
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Delete ${item.name}?`) ? deleteEquipment(item.id) : undefined} type="button">Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <EquipmentPrintReport equipment={labState.equipment} />
    </section>
  );
}

function EquipmentPrintReport({ equipment }: { equipment: EquipmentEntry[] }) {
  return (
    <div className="print-report" id="equipment-print-report">
      <h1>Aly & Shin Equipment Database</h1>
      <p>Generated {getToday()}</p>
      <table>
        <thead>
          <tr>
            <th>Equipment</th>
            <th>Purchase PHP</th>
            <th>Gas kg</th>
            <th>Gas PHP/kg</th>
            <th>Gas PHP/min</th>
            <th>Mode details</th>
            <th>Total/batch</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {equipment.map((item) => {
            const totals = getEquipmentTotals(item);
            return (
              <tr key={item.id}>
                <td>{item.brand ? `${item.brand} ` : ""}{item.name}{item.model ? ` (${item.model})` : ""}</td>
                <td>{item.purchasePrice.toFixed(2)}</td>
                <td>{item.calculationMode === "gas-burn-rate" ? item.tankSizeKg : ""}</td>
                <td>{item.calculationMode === "gas-burn-rate" ? totals.pricePerKg.toFixed(2) : ""}</td>
                <td>{item.calculationMode === "gas-burn-rate" ? totals.costPerMinute.toFixed(4) : ""}</td>
                <td>{item.calculationMode === "gas-burn-rate" ? `${item.burnRateKgPerHour}kg/hr` : item.calculationMode === "replacement-reserve" ? `${item.batchesPerUnit} batches/unit` : `${item.usefulLifeYears}yr / ${item.batchesPerWeek} batches/wk / ${item.annualMaintenancePercent}% maint`}</td>
                <td>{totals.totalPerBatch.toFixed(2)}</td>
                <td>{item.isActive ? "Active" : "Inactive"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EquipmentNameField({
  formFieldName,
  label,
  onAdd,
  onChange,
  options,
  placeholder,
  value,
}: {
  formFieldName: string;
  label: string;
  onAdd: (name: string) => void;
  onChange: (name: string) => void;
  options: string[];
  placeholder: string;
  value: string;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState("");

  function confirmAdd() {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setIsAdding(false);
      return;
    }
    onAdd(trimmed);
    onChange(trimmed);
    setDraftName("");
    setIsAdding(false);
  }

  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={formFieldName} type="hidden" value={value} />
      {isAdding ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-normal"
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmAdd();
              }
              if (event.key === "Escape") {
                setIsAdding(false);
                setDraftName("");
              }
            }}
            placeholder={placeholder}
            value={draftName}
          />
          <button className="h-10 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={confirmAdd} type="button">Add</button>
          <button className="h-10 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => { setIsAdding(false); setDraftName(""); }} type="button">Cancel</button>
        </div>
      ) : (
        <select
          className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
          onChange={(event) => {
            if (event.target.value === "__add_new__") {
              setIsAdding(true);
              return;
            }
            onChange(event.target.value);
          }}
          value={value}
        >
          {options.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value="__add_new__">+ Add new...</option>
        </select>
      )}
    </label>
  );
}

function CostingForm({
  cancelEdit,
  batches,
  costing,
  equipment,
  ingredientEntries,
  ingredients,
  isSellingFormatsTableMissing,
  message,
  messageTone,
  products,
  saveCosting,
  sellingFormatPackagingLines,
  sellingFormats,
  supplies,
}: {
  batches: ProductBatch[];
  cancelEdit: () => void;
  costing: CostingSummary | null;
  equipment: EquipmentEntry[];
  ingredientEntries: CostingEntry[];
  ingredients: Ingredient[];
  isSellingFormatsTableMissing: boolean;
  message: string;
  messageTone: "good" | "bad" | "info";
  products: Product[];
  saveCosting: (formData: FormData) => void;
  sellingFormatPackagingLines: SellingFormatPackagingLine[];
  sellingFormats: SellingFormat[];
  supplies: SupplyEntry[];
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLSelectElement>(costing?.id ?? null);
  // Costing is scoped to a specific proof batch/version (e.g. "Brownies V3"), not just a
  // product -- so the same product can have separate costing per version instead of only ever
  // reflecting whichever batch happened to be "latest" when the costing was last saved.
  const batchesByProduct = products
    .map((product) => ({
      product,
      productBatches: batches.filter((item) => item.productId === product.id).sort((a, b) => (b.dateMade || "").localeCompare(a.dateMade || "")),
    }))
    .filter((group) => group.productBatches.length > 0);
  const [selectedBatchId, setSelectedBatchId] = useState(
    () => costing?.batchId || batches.find((item) => item.productId === costing?.productId)?.id || batchesByProduct[0]?.productBatches[0]?.id || "",
  );
  const selectedBatch = batches.find((item) => item.id === selectedBatchId);
  const selectedProductId = selectedBatch?.productId ?? costing?.productId ?? products[0]?.id ?? "";
  const savedIngredients = costing
    ? ingredientEntries.filter((entry) => (costing.batchId ? entry.batchId === costing.batchId : entry.productId === costing.productId && !entry.batchId))
    : [];
  const existingSellingFormats = costing ? sellingFormats.filter((format) => format.costingId === costing.id) : [];
  const existingSellingFormatIds = new Set(existingSellingFormats.map((format) => format.id));
  const existingSellingFormatPackagingLines = sellingFormatPackagingLines.filter((line) => existingSellingFormatIds.has(line.sellingFormatId));
  const structuredDetail = getCostingStructuredDetail(costing?.notes ?? "");
  // A brand-new costing has nothing saved yet to protect, so it starts pre-filled from the
  // selected batch's formula (auto-costed against purchase history) instead of a blank row -- the "Use
  // this batch's formula" button stays for switching batches or editing a saved costing, where
  // auto-importing would risk silently overwriting rows the user already priced/edited.
  const [ingredientRows, setIngredientRows] = useState<CostingIngredientRow[]>(() => {
    if (savedIngredients.length > 0) {
      return savedIngredients.map((entry) => ({ ...entry, rowId: entry.id }));
    }

    const formulaRows = parseBatchIngredients(selectedBatch?.ingredientsNotes ?? "")
      .filter((row) => row.ingredient.trim())
      .map((row) => ({
        batchId: selectedBatchId,
        cost: 0,
        id: "",
        brandName: row.brand,
        ingredientName: row.ingredient,
        productId: selectedProductId,
        quantityUsed: row.quantity,
        rowId: crypto.randomUUID(),
        supplierNote: row.change,
        unit: row.unit,
      }));

    return formulaRows.length > 0
      ? autoCostRows(formulaRows)
      : [{ batchId: costing?.batchId ?? "", brandName: "", cost: 0, id: "", ingredientName: "", productId: costing?.productId ?? products[0]?.id ?? "", quantityUsed: 0, rowId: crypto.randomUUID(), supplierNote: "", unit: "" }];
  });
  const [utilityRows, setUtilityRows] = useState<CostingUtilityRow[]>(() => {
    if (structuredDetail?.utilityRows?.length) {
      return structuredDetail.utilityRows.map((row) => ({ ...row, rowId: row.rowId || crypto.randomUUID() }));
    }

    if (!costing) {
      return [{ cost: 0, name: "", note: "", rowId: crypto.randomUUID() }];
    }

    const rows = [
      { cost: costing.waterCost, name: "Water", note: "", rowId: crypto.randomUUID() },
      { cost: costing.gasCost, name: "Gas", note: "", rowId: crypto.randomUUID() },
      { cost: costing.ovenElectricCost, name: "Oven/electric", note: "", rowId: crypto.randomUUID() },
      { cost: costing.refrigerationCost, name: "Refrigeration", note: "", rowId: crypto.randomUUID() },
      { cost: costing.coffeeEquipmentCost, name: "Coffee equipment", note: "", rowId: crypto.randomUUID() },
    ].filter((row) => row.cost > 0);

    return rows.length > 0 ? rows : [{ cost: 0, name: "", note: "", rowId: crypto.randomUUID() }];
  });
  // Only ever seed the 9 named defaults (Box, Sticker, Cup...) when there's real structured
  // detail to fill them from -- a brand-new costing renders 0 rows, and a legacy costing with
  // just a lump-sum packagingCost gets exactly 1 row carrying that amount, not 9 mostly-blank
  // ones. "Add packaging" (NamedCostSection) is the only way to add more either way.
  const [packagingRows, setPackagingRows] = useState<CostingNamedCostRow[]>(() => {
    if (structuredDetail?.packagingRows?.length) {
      return buildNamedCostRows(defaultPackagingComponents, structuredDetail.packagingRows, costing?.packagingCost ?? 0);
    }
    return costing?.packagingCost ? [{ cost: costing.packagingCost, name: "Packaging", note: "", rowId: crypto.randomUUID() }] : [];
  });
  const [overheadRows, setOverheadRows] = useState<CostingNamedCostRow[]>(() => buildNamedCostRows(defaultOverheadRows, structuredDetail?.overheadRows));
  const [equipmentUsage, setEquipmentUsage] = useState<EquipmentUsageRow[]>(() => structuredDetail?.equipmentUsage ?? []);
  const [wasteRows, setWasteRows] = useState<CostingNamedCostRow[]>(() => buildNamedCostRows(defaultWasteRows, structuredDetail?.wasteRows, costing?.wasteAllowance ?? 0));
  const [laborDetail, setLaborDetail] = useState<CostingLaborDetail>(() => structuredDetail?.laborDetail ?? {
    activeRate: 120,
    cleaningMinutes: 0,
    cookingMinutes: selectedBatch?.bakeTimeMinutes ?? 0,
    coolingMinutes: selectedBatch?.coolingTimeMinutes ?? 0,
    packagingMinutes: 0,
    prepMinutes: selectedBatch?.prepTimeMinutes ?? 0,
  });
  const [gasDetail, setGasDetail] = useState<CostingGasDetail>(() => ({
    equipmentName: structuredDetail?.gasDetail?.equipmentName ?? "Oven",
    gasKg: structuredDetail?.gasDetail?.gasKg ?? 0,
    gasPrice: structuredDetail?.gasDetail?.gasPrice ?? 0,
    gasUseKgPerHour: structuredDetail?.gasDetail?.gasUseKgPerHour ?? 0,
  }));
  const [electricityDetail, setElectricityDetail] = useState<CostingElectricityDetail>(() => ({
    applianceWatts: structuredDetail?.electricityDetail?.applianceWatts ?? 0,
    equipmentName: structuredDetail?.electricityDetail?.equipmentName ?? "Electric oven",
    minutes: structuredDetail?.electricityDetail?.minutes ?? selectedBatch?.bakeTimeMinutes ?? 0,
    ratePerKwh: structuredDetail?.electricityDetail?.ratePerKwh ?? 0,
  }));
  const [waterDetail, setWaterDetail] = useState<CostingWaterDetail>(() => structuredDetail?.waterDetail ?? {
    litersUsed: 0,
    ratePerCubicMeter: 0,
  });
  const [customGasEquipmentNames, setCustomGasEquipmentNames] = useState<string[]>(() =>
    structuredDetail?.gasDetail?.equipmentName ? [structuredDetail.gasDetail.equipmentName] : [],
  );
  const [customElectricEquipmentNames, setCustomElectricEquipmentNames] = useState<string[]>(() =>
    structuredDetail?.electricityDetail?.equipmentName ? [structuredDetail.electricityDetail.equipmentName] : [],
  );
  const [suggestedPrice, setSuggestedPrice] = useState(costing?.suggestedPrice ?? 0);
  const [targetFoodCost, setTargetFoodCost] = useState(structuredDetail?.targetFoodCost ?? 0.35);
  const [localMessage, setLocalMessage] = useState("");
  const [localMessageTone, setLocalMessageTone] = useState<"good" | "bad" | "info">("info");
  const [formatRows, setFormatRows] = useState<SellingFormat[]>(() => existingSellingFormats);
  const [packagingLineRows, setPackagingLineRows] = useState<SellingFormatPackagingLine[]>(() => existingSellingFormatPackagingLines);
  // Frozen once, at load -- never updated after -- so a catalog-linked line's current display can
  // compare "what was saved" against "what the catalog says now" without losing the saved number
  // the moment the operator starts editing something else on the same line.
  const [savedPackagingLineUnitCosts] = useState<Map<string, number>>(() => new Map(existingSellingFormatPackagingLines.map((line) => [line.id, line.unitCostSnapshot])));
  // "Move to Selling Format" in progress for at most one batch-wide row at a time -- null means
  // nothing pending, so packagingRows/packagingLineRows are provably untouched until Confirm is
  // clicked (see confirmMoveToSellingFormat below).
  const [pendingMove, setPendingMove] = useState<{ row: CostingNamedCostRow; formatId: string; interpretation: SellingFormatMoveInterpretation; manualAmount: number } | null>(null);

  const utilityRowsTotal = utilityRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const gasCostDetail = getGasCostDetail(gasDetail, laborDetail.cookingMinutes);
  const gasCost = gasCostDetail.cost;
  const electricityCostDetail = getElectricityCostDetail(electricityDetail);
  const electricityCost = electricityCostDetail.cost;
  const waterCostDetail = getWaterCostDetail(waterDetail);
  const waterCost = waterCostDetail.cost;
  const utilityTotal = utilityRowsTotal + gasCost + electricityCost + waterCost;
  const manualUtilityBuckets = bucketUtilityRows(utilityRows);
  const utilityBuckets = { ...manualUtilityBuckets, electricity: manualUtilityBuckets.electricity + electricityCost, gas: manualUtilityBuckets.gas + gasCost, water: manualUtilityBuckets.water + waterCost };
  const selectedBatchFormula = parseBatchIngredients(selectedBatch?.ingredientsNotes ?? "");
  const ingredientTotal = ingredientRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const [costingYield, setCostingYield] = useState(() => getCostingYieldFromNotes(costing?.notes ?? "") || selectedBatch?.usablePieces || 0);
  const packagingCost = packagingRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const overheadCost = overheadRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const equipmentAllocations = equipmentUsage.map((row) => {
    const equipmentItem = equipment.find((item) => item.id === row.equipmentId && item.calculationMode !== "gas-burn-rate");
    return {
      row,
      equipmentItem,
      ...(equipmentItem ? getAllocatedEquipmentCost(equipmentItem, row.sharedBatches, laborDetail.cookingMinutes) : { allocatedDepreciation: 0, allocatedMaintenance: 0, allocatedTotal: 0 }),
    };
  });
  const equipmentDepreciationCost = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedDepreciation, 0);
  const equipmentMaintenanceCost = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedMaintenance, 0);
  const wasteAllowance = wasteRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  // Proof Day already records imperfectPieces per batch -- use that real reject history instead of
  // asking for a cold-start guess. Averaged across this product's batches, not just the latest one,
  // since a single batch's reject count is too noisy to build a cost estimate on.
  const productBatchesForWaste = batches.filter((batch) => batch.productId === selectedProductId && batch.usablePieces + batch.imperfectPieces > 0);
  const historicalRejectRate = productBatchesForWaste.length > 0
    ? productBatchesForWaste.reduce((total, batch) => total + batch.imperfectPieces / (batch.usablePieces + batch.imperfectPieces), 0) / productBatchesForWaste.length
    : 0;
  const suggestedWasteCost = ingredientTotal * historicalRejectRate;
  const activeLaborMinutes = laborDetail.prepMinutes + laborDetail.packagingMinutes + laborDetail.cleaningMinutes;
  const passiveMinutes = laborDetail.cookingMinutes + laborDetail.coolingMinutes;
  const laborEstimate = (activeLaborMinutes / 60) * laborDetail.activeRate;
  const directCost = ingredientTotal + packagingCost + laborEstimate + utilityTotal + wasteAllowance;
  const indirectCost = overheadCost + equipmentDepreciationCost + equipmentMaintenanceCost;
  const totalBatchCost = directCost + indirectCost;
  // Break-even units: how many pieces of THIS batch need to sell to cover this batch's fixed-cost
  // allocation (overhead + equipment). Direct costs (ingredients/packaging/labor/utilities/waste)
  // scale per piece, so only indirectCost is "fixed" at the batch level here.
  const {
    costPerPiece,
    grossProfit,
    margin,
    foodCostPercent,
    markup,
    targetPrice: suggestedTargetPrice,
    contributionMarginPerPiece,
    breakEvenUnits,
  } = getCostingMetrics({ costingYield, directCost, indirectCost, suggestedPrice, targetFoodCost, totalBatchCost });
  // The live equivalent of getCostingTotals(costing).costPerPiece -- same value, recomputed on
  // every keystroke instead of read from a saved row. No second base-cost formula: Selling Format
  // math is built entirely on this one number, which already includes batch-wide packaging &
  // consumables (see the relabeled section below) since that field was never excluded from it.
  const baseProductionCostPerPiece = costPerPiece;
  const formatsWithMetrics = formatRows.map((format) => {
    const lines = packagingLineRows.filter((line) => line.sellingFormatId === format.id);
    const formatPackagingCost = getSellingFormatPackagingCost(lines);
    return {
      format,
      lines,
      packagingCost: formatPackagingCost,
      ...getSellingFormatMetrics({ baseProductionCostPerPiece, piecesPerUnit: format.piecesPerUnit, packagingCost: formatPackagingCost, sellingPrice: format.sellingPrice }),
    };
  });
  const appliedMessage = message || localMessage;
  const appliedMessageTone = message ? messageTone : localMessageTone;
  const gasEquipmentOptions = Array.from(new Set(["Oven", "Stove", ...customGasEquipmentNames, ...equipment.filter((item) => item.calculationMode === "gas-burn-rate").map((item) => `${item.brand ? `${item.brand} ` : ""}${item.name}`)])).filter(Boolean);
  const electricEquipmentOptions = Array.from(new Set(["Electric oven", "Mixer", "Blender", "Espresso machine", "Refrigerator", ...customElectricEquipmentNames, ...equipment.filter((item) => item.calculationMode !== "gas-burn-rate").map((item) => `${item.brand ? `${item.brand} ` : ""}${item.name}`)])).filter(Boolean);

  function changeBatch(batchId: string) {
    setSelectedBatchId(batchId);
    const newlySelectedBatch = batches.find((item) => item.id === batchId);
    setCostingYield(newlySelectedBatch?.usablePieces || 0);
  }

  function addSellingFormat() {
    setFormatRows((current) => [
      ...current,
      { id: crypto.randomUUID(), costingId: costing?.id ?? "", name: "", piecesPerUnit: 1, sellingPrice: 0, isActive: true, sortOrder: current.length, notes: "" },
    ]);
    setLocalMessage("Selling format added.");
    setLocalMessageTone("good");
  }

  function updateSellingFormat(formatId: string, changes: Partial<SellingFormat>) {
    setFormatRows((current) => current.map((format) => (format.id === formatId ? { ...format, ...changes } : format)));
  }

  function removeSellingFormat(formatId: string) {
    setFormatRows((current) => current.filter((format) => format.id !== formatId));
    setPackagingLineRows((current) => current.filter((line) => line.sellingFormatId !== formatId));
    setLocalMessage("Selling format removed.");
    setLocalMessageTone("good");
  }

  function addPackagingLine(formatId: string) {
    const lineCount = packagingLineRows.filter((line) => line.sellingFormatId === formatId).length;
    setPackagingLineRows((current) => [
      ...current,
      { id: crypto.randomUUID(), sellingFormatId: formatId, ingredientId: "", name: "", quantity: 1, unit: "", unitCostSnapshot: 0, isManualCost: false, note: "", sortOrder: lineCount },
    ]);
  }

  function updatePackagingLine(lineId: string, changes: Partial<SellingFormatPackagingLine>) {
    setPackagingLineRows((current) => current.map((line) => (line.id === lineId ? { ...line, ...changes } : line)));
  }

  function removePackagingLine(lineId: string) {
    setPackagingLineRows((current) => current.filter((line) => line.id !== lineId));
  }

  // Re-picking a catalog item already used elsewhere in the same format merges into that
  // existing line (quantity + 1) instead of creating a second line for the same ingredient --
  // matches the database's own partial unique index (selling_format_packaging_lines_catalog_
  // unique_idx), enforced here too so the operator sees the merge happen, not a save-time error.
  function selectPackagingLineIngredient(formatId: string, lineId: string, ingredientId: string) {
    const ingredient = ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      return;
    }

    const duplicateLine = packagingLineRows.find((line) => line.sellingFormatId === formatId && line.ingredientId === ingredientId && line.id !== lineId);
    if (duplicateLine) {
      setPackagingLineRows((current) =>
        current
          .map((line) => (line.id === duplicateLine.id ? { ...line, quantity: line.quantity + 1 } : line))
          .filter((line) => line.id !== lineId),
      );
      setLocalMessage(`"${ingredient.name}" is already used in this format -- increased its quantity instead of adding a duplicate line.`);
      setLocalMessageTone("good");
      return;
    }

    const currentUnitCost = resolvePackagingItemUnitCost(ingredientId, ingredients, supplies);
    setPackagingLineRows((current) =>
      current.map((line) =>
        line.id === lineId
          ? { ...line, ingredientId, name: ingredient.name, unit: ingredient.baseUnit, unitCostSnapshot: currentUnitCost, isManualCost: false }
          : line,
      ),
    );
  }

  function switchPackagingLineToManual(lineId: string) {
    setPackagingLineRows((current) => current.map((line) => (line.id === lineId ? { ...line, ingredientId: "", isManualCost: true } : line)));
  }

  function updatePackagingLineToCurrentCost(lineId: string) {
    const line = packagingLineRows.find((item) => item.id === lineId);
    if (!line?.ingredientId) {
      return;
    }
    const currentUnitCost = resolvePackagingItemUnitCost(line.ingredientId, ingredients, supplies);
    setPackagingLineRows((current) => current.map((item) => (item.id === lineId ? { ...item, unitCostSnapshot: currentUnitCost } : item)));
  }

  // Batch-wide packaging rows store a whole-batch total, never a per-unit cost (confirmed by this
  // section's own "Use per-batch costs" helper text) -- so starting a move never mutates
  // packagingRows/packagingLineRows itself. It only opens the inline confirmation panel; picking
  // an interpretation there is still just local pendingMove state until confirmMoveToSellingFormat
  // actually runs.
  function startMoveToSellingFormat(row: CostingNamedCostRow, formatId: string) {
    setPendingMove({ row, formatId, interpretation: costingYield > 0 ? "divide-across-yield" : "use-whole-amount", manualAmount: row.cost });
  }

  function cancelMoveToSellingFormat() {
    setPendingMove(null);
  }

  // The one place the move actually happens -- only ever called from the confirmation panel's
  // "Confirm move" button, never from selecting a target format or an interpretation.
  function confirmMoveToSellingFormat() {
    if (!pendingMove) {
      return;
    }

    const targetFormat = formatRows.find((format) => format.id === pendingMove.formatId);
    if (!targetFormat) {
      setPendingMove(null);
      return;
    }

    const confirmedAmount = calculateMoveToSellingFormatAmount(pendingMove.interpretation, {
      wholeBatchAmount: pendingMove.row.cost,
      costingYield,
      piecesPerUnit: targetFormat.piecesPerUnit,
      manualAmount: pendingMove.manualAmount,
    });
    if (confirmedAmount === null) {
      return;
    }

    const lineCount = packagingLineRows.filter((line) => line.sellingFormatId === pendingMove.formatId).length;
    setPackagingRows((current) => current.filter((item) => item.rowId !== pendingMove.row.rowId));
    setPackagingLineRows((current) => [...current, buildMovedManualPackagingLine(pendingMove.row, pendingMove.formatId, confirmedAmount, lineCount)]);

    const interpretationLabel =
      pendingMove.interpretation === "divide-across-yield"
        ? `divided across the batch yield (${costingYield}) and scaled to this format's ${targetFormat.piecesPerUnit} piece${targetFormat.piecesPerUnit === 1 ? "" : "s"}`
        : pendingMove.interpretation === "use-whole-amount"
          ? "used as-is for each selling unit"
          : "entered manually";
    setLocalMessage(`Moved "${pendingMove.row.name || "packaging item"}" into "${targetFormat.name || "this format"}" as PHP ${confirmedAmount.toFixed(2)} per unit (${interpretationLabel}). Double-check this reflects what you meant.`);
    setLocalMessageTone("good");
    setPendingMove(null);
  }

  function addIngredientRow() {
    setIngredientRows((current) => [...current, { batchId: selectedBatchId, brandName: "", cost: 0, id: "", ingredientName: "", productId: selectedProductId, quantityUsed: 0, rowId: crypto.randomUUID(), supplierNote: "", unit: "" }]);
    setLocalMessage("Ingredient row added.");
    setLocalMessageTone("good");
  }

  function addUtilityRow() {
    setUtilityRows((current) => [...current, { cost: 0, name: "", note: "", rowId: crypto.randomUUID() }]);
    setLocalMessage("Utility row added.");
    setLocalMessageTone("good");
  }

  function addNamedCostRow(setRows: Dispatch<SetStateAction<CostingNamedCostRow[]>>, name: string) {
    setRows((current) => [...current, { cost: 0, name, note: "", rowId: crypto.randomUUID() }]);
    setLocalMessage(`${name} row added.`);
    setLocalMessageTone("good");
  }

  function updateNamedCostRow(setRows: Dispatch<SetStateAction<CostingNamedCostRow[]>>, rowId: string, changes: Partial<CostingNamedCostRow>) {
    setRows((current) => current.map((row) => (row.rowId === rowId ? { ...row, ...changes } : row)));
  }

  function useSuggestedWasteCost() {
    setWasteRows((current) => [
      ...current,
      {
        cost: Number(suggestedWasteCost.toFixed(2)),
        name: "Historical reject rate",
        note: `${(historicalRejectRate * 100).toFixed(1)}% across ${productBatchesForWaste.length} batch${productBatchesForWaste.length === 1 ? "" : "es"}`,
        rowId: crypto.randomUUID(),
      },
    ]);
    setLocalMessage("Waste row added from batch reject history.");
    setLocalMessageTone("good");
  }

  function importBatchFormula() {
    const rows = selectedBatchFormula
      .filter((row) => row.ingredient.trim())
      .map((row) => ({
        batchId: selectedBatchId,
        cost: 0,
        id: "",
        brandName: row.brand,
        ingredientName: row.ingredient,
        productId: selectedProductId,
        quantityUsed: row.quantity,
        rowId: crypto.randomUUID(),
        supplierNote: row.change,
        unit: row.unit,
      }));

    if (rows.length > 0) {
      setIngredientRows(autoCostRows(rows));
      setLocalMessage(`${selectedBatch?.batchVersion ?? "This batch"}'s formula imported. Matching supply prices were applied automatically.`);
      setLocalMessageTone("good");
    } else {
      setLocalMessage("No proof formula found for this batch.");
      setLocalMessageTone("bad");
    }
  }

  function autoCostRows(rows: CostingIngredientRow[]) {
    return rows.map((row) => getAutoCostedIngredientRowForItems(row, supplies, ingredients));
  }

  function updateIngredientRow(rowId: string, changes: Partial<CostingIngredientRow>, isManualCost = false) {
    setIngredientRows((current) =>
      autoCostRows(current.map((row) => (row.rowId === rowId ? { ...row, ...changes, isManualCost } : row))),
    );
  }

  function downloadCosting() {
    const filenameBase = batchDisplayName(selectedProductId, selectedBatch?.batchVersion ?? "", products);
    const filename = `${filenameBase.toLowerCase().replaceAll(" ", "-")}-costing.csv`;
    downloadCsv(
      filename,
      ["Section", "Name", "Qty", "Unit", "PHP", "Note"],
      [
        ...ingredientRows.map((row) => ["Ingredient", `${row.brandName ? `${row.brandName} ` : ""}${row.ingredientName}`, row.quantityUsed, row.unit, row.cost, row.supplierNote]),
        ["Packaging", "Packaging", "", "", packagingCost, ""],
        ["Labor", "Labor", "", "", laborEstimate, "Pay for mixing, baking/cooking, cooling, packing, cleaning, and admin time"],
        ["Utility", gasDetail.equipmentName || "Gas equipment", laborDetail.cookingMinutes, "min", gasCost, `${gasDetail.gasKg}kg refill / PHP ${gasDetail.gasPrice} / ${gasDetail.gasUseKgPerHour}kg per hour / PHP ${gasCostDetail.costPerMinute.toFixed(4)} per min`],
        ["Utility", electricityDetail.equipmentName || "Electric equipment", electricityDetail.minutes, "min", electricityCost, `${electricityDetail.applianceWatts}W / ${electricityCostDetail.kwhUsed.toFixed(4)} kWh / PHP ${electricityDetail.ratePerKwh} per kWh`],
        ["Utility", "Water", waterDetail.litersUsed, "L", waterCost, `PHP ${waterDetail.ratePerCubicMeter} per cubic meter / PHP ${waterCostDetail.pricePerLiter.toFixed(4)} per L`],
        ...utilityRows.map((row) => ["Utility", row.name, "", "", row.cost, row.note]),
        ["Overhead", "Allocated overhead", "", "", overheadCost, ""],
        ...equipmentAllocations.map((allocation) => ["Equipment", allocation.equipmentItem ? `${allocation.equipmentItem.brand ? `${allocation.equipmentItem.brand} ` : ""}${allocation.equipmentItem.name}` : "Equipment not found", "", "", allocation.allocatedTotal, `dep ${allocation.allocatedDepreciation.toFixed(2)} + maint ${allocation.allocatedMaintenance.toFixed(2)}`]),
        ["Waste", "Waste allowance", "", "", wasteAllowance, ""],
        ["Summary", "Batch cost", "", "", totalBatchCost, ""],
        ["Summary", "Yield", costingYield, "pieces/units", "", ""],
        ["Summary", "Cost per piece", "", "", formatCostingMetric(costPerPiece, (value) => value.toFixed(2)), ""],
        ["Summary", "Selling price", "", "", suggestedPrice, ""],
        ["Summary", "Operating profit per unit", "", "", formatCostingMetric(grossProfit, (value) => value.toFixed(2)), ""],
        ["Summary", "Operating margin %", "", "", formatCostingMetric(margin, (value) => value.toFixed(1)), ""],
        ...formatsWithMetrics.flatMap(({ format, lines, packagingCost: formatPackagingCost, totalCost, profit, margin: formatMargin }) => [
          ["Selling Format", format.name, format.piecesPerUnit, format.isActive ? "active" : "archived", format.sellingPrice, `Cost ${formatCostingMetric(totalCost, (value) => value.toFixed(2))} / Profit ${formatCostingMetric(profit, (value) => value.toFixed(2))} / Margin ${formatCostingMetric(formatMargin, (value) => `${value.toFixed(1)}%`)}`],
          ...lines.map((line) => ["Selling Format Packaging", line.name, line.quantity, line.unit, line.quantity * line.unitCostSnapshot, `${format.name} / ${line.isManualCost ? "manual" : "catalog-linked"}`]),
          ["Selling Format Packaging Total", `${format.name} packaging`, "", "", formatPackagingCost, ""],
        ]),
      ],
    );
  }

  return (
    <FormPanel ref={editorRef} title={costing ? "Edit costing" : "Save costing summary"} icon={<Sparkles size={18} />}>
      {costing ? (
        <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">
          Editing: {costingDisplayName(costing, products, batches)}
        </p>
      ) : null}
      {appliedMessage ? <MessageBox message={appliedMessage} tone={appliedMessageTone} /> : null}
      <form action={saveCosting} className="grid gap-3">
        <input name="id" type="hidden" value={costing?.id ?? ""} />
        <input name="ingredientRowIds" type="hidden" value={ingredientRows.map((row) => row.rowId).join(",")} />
        <input name="utilityRowIds" type="hidden" value={utilityRows.map((row) => row.rowId).join(",")} />
        <input name="packagingRowIds" type="hidden" value={packagingRows.map((row) => row.rowId).join(",")} />
        <input name="overheadRowIds" type="hidden" value={overheadRows.map((row) => row.rowId).join(",")} />
        <input name="equipmentUsageRowIds" type="hidden" value={equipmentUsage.map((row) => row.rowId).join(",")} />
        <input name="wasteRowIds" type="hidden" value={wasteRows.map((row) => row.rowId).join(",")} />
        <input name="sellingFormatRowIds" type="hidden" value={formatRows.map((format) => format.id).join(",")} />
        <input name="productId" type="hidden" value={selectedProductId} />
        <input name="batchId" type="hidden" value={selectedBatchId} />
        <label className="grid gap-1 text-sm font-medium">
          Product batch
          {batchesByProduct.length > 0 ? (
            <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => changeBatch(event.target.value)} ref={fieldRef} value={selectedBatchId}>
              {batchesByProduct.map((group) => (
                <optgroup key={group.product.id} label={group.product.name}>
                  {group.productBatches.map((batch) => <option key={batch.id} value={batch.id}>{batch.batchVersion}</option>)}
                </optgroup>
              ))}
            </select>
          ) : (
            <p className="flex h-10 items-center rounded-md border border-[#ead9c8] bg-white px-3 text-sm text-[#6f5a4c]">No proof batches yet — record one on Proof Day first.</p>
          )}
        </label>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Ingredients used</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Cost the quantity used in this product batch. Use purchase history for prices and supplier comparison.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d] disabled:cursor-not-allowed disabled:opacity-50" disabled={selectedBatchFormula.length === 0} onClick={importBatchFormula} type="button">Use this batch&apos;s formula</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("costing-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadCosting} type="button">Download CSV</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addIngredientRow} type="button">Add ingredient</button>
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            {ingredientRows.map((row, index) => {
              const matches = getMatchingPurchaseHistoryForIngredient(supplies, ingredients, { ingredientName: row.ingredientName }, row.brandName, row.unit).slice(0, 3);
              return (
                <div className="rounded-md border border-[#ead9c8] bg-white p-3" key={row.rowId}>
                  <div className="grid gap-2 lg:grid-cols-[1fr_1fr_90px_80px_110px_1fr_70px]">
                    <input name={`ingredientId-${row.rowId}`} type="hidden" value={row.id} />
                    <Input name={`ingredientBrand-${row.rowId}`} label="Brand" placeholder="Beryl's" value={row.brandName} onChange={(event) => updateIngredientRow(row.rowId, { brandName: event.target.value })} />
                    <Input name={`ingredientName-${row.rowId}`} label={`Ingredient ${index + 1}`} placeholder="Butter" value={row.ingredientName} onChange={(event) => updateIngredientRow(row.rowId, { ingredientName: event.target.value })} />
                    <Input name={`quantityUsed-${row.rowId}`} label="Formula qty" type="number" step="0.01" placeholder="250" value={row.quantityUsed || ""} onChange={(event) => updateIngredientRow(row.rowId, { quantityUsed: Number(event.target.value || 0) })} />
                    <Input name={`unit-${row.rowId}`} label="Unit" placeholder="g" value={row.unit} onChange={(event) => updateIngredientRow(row.rowId, { unit: event.target.value })} />
                    <Input name={`ingredientCost-${row.rowId}`} label="Used PHP" type="number" step="0.01" placeholder="Auto-filled" value={row.cost || ""} onChange={(event) => updateIngredientRow(row.rowId, { cost: Number(event.target.value || 0) }, true)} />
                    <Input name={`supplierNote-${row.rowId}`} label="Cost note" placeholder="Auto supply match or manual note" value={row.supplierNote} onChange={(event) => updateIngredientRow(row.rowId, { supplierNote: event.target.value }, true)} />
                    <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => {
                      setIngredientRows((current) => current.filter((item) => item.rowId !== row.rowId));
                      setLocalMessage("Ingredient row removed.");
                      setLocalMessageTone("good");
                    }} type="button">Remove</button>
                  </div>
                  <div className="mt-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a5b2f]">Matching purchases</p>
                    {matches.length === 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">No exact purchase match yet. Brand, ingredient, and unit must match purchase history.</p> : null}
                    <div className="mt-2 grid gap-2">
                      {matches.map((supply, matchIndex) => {
                        const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;
                        const usedCost = getSupplyUsedCost(supply, row.quantityUsed, row.unit);
                        const conversionLabel = getConversionLabel(row.quantityUsed, row.unit, supply);
                        const isAutoSelected = matchIndex === 0 && !row.isManualCost;
                        return (
                          <div className="grid gap-2 rounded-md border border-[#ead9c8] bg-white p-2 text-sm md:grid-cols-[1fr_140px]" key={supply.id}>
                            <div className="text-[#5f4a3d]">
                              <p className="font-semibold">{getSupplyLabel(supply)}{isAutoSelected ? <span className="ml-2 rounded-full bg-[#231813] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Auto-selected</span> : null}</p>
                              <p>{supply.supplierName} · bought {supply.purchaseDate || "date unknown"}</p>
                              <p>PHP {supply.totalCost.toFixed(2)} total · PHP {unitCost.toFixed(4)} / {supply.unit || "unit"} · quality {supply.qualityRating || 0}/5</p>
                              {conversionLabel ? <p className="text-xs text-[#8a6a54]">{conversionLabel}</p> : null}
                            </div>
                            <p className="self-center font-semibold">Used: PHP {usedCost.toFixed(2)}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm font-semibold text-[#5f4a3d]">Ingredient total: PHP {ingredientTotal.toFixed(2)}</p>
        </div>
        <NamedCostSection
          addLabel="Add batch-wide item"
          helperNote={
            <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">
              Parchment, tray liners, and anything used once for the whole batch stay here. Wrappers, stickers, boxes, and other packaging used for a specific sale belong under Selling Formats below.
            </p>
          }
          namePrefix="packaging"
          onAdd={() => addNamedCostRow(setPackagingRows, "Packaging")}
          renderRowExtra={(row) =>
            formatRows.length > 0 ? (
              <div className="mt-1">
                <select
                  className="h-8 rounded-md border border-[#d8c7b7] bg-white px-2 text-xs"
                  onChange={(event) => {
                    if (event.target.value) {
                      startMoveToSellingFormat(row, event.target.value);
                    }
                  }}
                  value=""
                >
                  <option value="">Move to a selling format...</option>
                  {formatRows.map((format) => <option key={format.id} value={format.id}>{format.name || "Untitled format"}</option>)}
                </select>
                {pendingMove && pendingMove.row.rowId === row.rowId ? (
                  <MoveToSellingFormatConfirm
                    costingYield={costingYield}
                    formatRows={formatRows}
                    onCancel={cancelMoveToSellingFormat}
                    onChangeInterpretation={(interpretation) => setPendingMove((current) => (current ? { ...current, interpretation } : current))}
                    onChangeManualAmount={(manualAmount) => setPendingMove((current) => (current ? { ...current, manualAmount } : current))}
                    onConfirm={confirmMoveToSellingFormat}
                    pendingMove={pendingMove}
                  />
                ) : null}
              </div>
            ) : null
          }
          rows={packagingRows}
          setRows={setPackagingRows}
          title="Batch-wide packaging & consumables"
          total={packagingCost}
          updateNamedCostRow={updateNamedCostRow}
        />
        <Input
          name="costingYield"
          label="Batch yield used for costing"
          type="number"
          step="0.01"
          value={costingYield || ""}
          onChange={(event) => setCostingYield(Number(event.target.value || 0))}
          helper={selectedBatch?.usablePieces ? `${selectedBatch.batchVersion} has ${selectedBatch.usablePieces} sellable pieces. Override only if this costing uses a different yield.` : "Enter expected sellable pieces/units before trusting cost per piece."}
        />
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <p className="text-sm font-semibold">Labor timing</p>
          <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Active labor is paid work. Cooking and cooling are tracked separately as passive time.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Input name="prepMinutes" label="Preparation min" type="number" step="1" value={laborDetail.prepMinutes || ""} onChange={(event) => setLaborDetail((current) => ({ ...current, prepMinutes: Number(event.target.value || 0) }))} />
            <Input name="cookingMinutes" label="Cooking min" type="number" step="1" value={laborDetail.cookingMinutes || ""} onChange={(event) => {
              const minutes = Number(event.target.value || 0);
              setLaborDetail((current) => ({ ...current, cookingMinutes: minutes }));
              setElectricityDetail((current) => ({ ...current, minutes }));
            }} />
            <Input name="coolingMinutes" label="Cooling min" type="number" step="1" value={laborDetail.coolingMinutes || ""} onChange={(event) => setLaborDetail((current) => ({ ...current, coolingMinutes: Number(event.target.value || 0) }))} />
            <Input name="packagingMinutes" label="Packaging min" type="number" step="1" value={laborDetail.packagingMinutes || ""} onChange={(event) => setLaborDetail((current) => ({ ...current, packagingMinutes: Number(event.target.value || 0) }))} />
            <Input name="cleaningMinutes" label="Cleaning min" type="number" step="1" value={laborDetail.cleaningMinutes || ""} onChange={(event) => setLaborDetail((current) => ({ ...current, cleaningMinutes: Number(event.target.value || 0) }))} />
            <Input name="activeLaborRate" label="Active labor PHP/hr" type="number" step="0.01" value={laborDetail.activeRate || ""} onChange={(event) => setLaborDetail((current) => ({ ...current, activeRate: Number(event.target.value || 0) }))} />
          </div>
          <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-white p-3 text-sm text-[#5f4a3d] sm:grid-cols-3">
            <CostingBreakdown label="Active minutes" value={activeLaborMinutes} isCurrency={false} />
            <CostingBreakdown label="Passive minutes" value={passiveMinutes} isCurrency={false} />
            <CostingBreakdown label="Labor cost" value={laborEstimate} />
          </div>
        </div>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <p className="text-sm font-semibold">Utility calculators</p>
          <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Use these when the utility cost can be measured. They are added to the batch automatically; manual utility rows are only for one-off costs.</p>
          <div className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
            <p className="text-sm font-semibold">Gas cost per minute</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <EquipmentNameField
                formFieldName="gasEquipmentName"
                label="Gas equipment"
                onAdd={(name) => setCustomGasEquipmentNames((current) => Array.from(new Set([...current, name])))}
                onChange={(name) => setGasDetail((current) => ({ ...current, equipmentName: name }))}
                options={gasEquipmentOptions}
                placeholder="Turbo broiler"
                value={gasDetail.equipmentName || "Oven"}
              />
              <Input name="gasKg" label="Gas tank kg" type="number" step="0.01" placeholder="11" value={gasDetail.gasKg || ""} onChange={(event) => setGasDetail((current) => ({ ...current, gasKg: Number(event.target.value || 0) }))} />
              <Input name="gasPrice" label="Refill price PHP" type="number" step="0.01" placeholder="950" value={gasDetail.gasPrice || ""} onChange={(event) => setGasDetail((current) => ({ ...current, gasPrice: Number(event.target.value || 0) }))} />
              <Input name="gasUseKgPerHour" label="Gas use kg/hour" type="number" step="0.001" placeholder="0.20" value={gasDetail.gasUseKgPerHour || ""} onChange={(event) => setGasDetail((current) => ({ ...current, gasUseKgPerHour: Number(event.target.value || 0) }))} />
            </div>
            <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm text-[#5f4a3d] sm:grid-cols-4">
              <CostingBreakdown label={gasDetail.equipmentName || "Gas equipment"} value={gasCost} />
              <CostingBreakdown label="Gas PHP/min" value={gasCostDetail.costPerMinute} />
              <CostingBreakdown label="Cooking minutes" value={laborDetail.cookingMinutes} isCurrency={false} />
              <CostingBreakdown label="Gas PHP/kg" value={gasCostDetail.pricePerKg} />
            </div>
          </div>
          <div className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
            <p className="text-sm font-semibold">Electricity cost</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <EquipmentNameField
                formFieldName="electricityEquipmentName"
                label="Electric equipment"
                onAdd={(name) => setCustomElectricEquipmentNames((current) => Array.from(new Set([...current, name])))}
                onChange={(name) => setElectricityDetail((current) => ({ ...current, equipmentName: name }))}
                options={electricEquipmentOptions}
                placeholder="Air fryer"
                value={electricityDetail.equipmentName || "Electric oven"}
              />
              <Input name="electricityWatts" label="Appliance watts" type="number" step="1" placeholder="1500" value={electricityDetail.applianceWatts || ""} onChange={(event) => setElectricityDetail((current) => ({ ...current, applianceWatts: Number(event.target.value || 0) }))} />
              <Input name="electricityMinutes" label="Minutes used" type="number" step="1" value={electricityDetail.minutes || ""} onChange={(event) => setElectricityDetail((current) => ({ ...current, minutes: Number(event.target.value || 0) }))} />
              <Input name="electricityRatePerKwh" label="PHP per kWh" type="number" step="0.01" placeholder="12" value={electricityDetail.ratePerKwh || ""} onChange={(event) => setElectricityDetail((current) => ({ ...current, ratePerKwh: Number(event.target.value || 0) }))} />
            </div>
            <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm text-[#5f4a3d] sm:grid-cols-3">
              <CostingBreakdown label={electricityDetail.equipmentName || "Electric equipment"} value={electricityCost} />
              <CostingBreakdown label="kWh used" value={electricityCostDetail.kwhUsed} isCurrency={false} />
              <CostingBreakdown label="PHP/kWh" value={electricityDetail.ratePerKwh} />
            </div>
          </div>
          <div className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
            <p className="text-sm font-semibold">Water cost</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input name="waterLitersUsed" label="Liters used" type="number" step="0.01" placeholder="5" value={waterDetail.litersUsed || ""} onChange={(event) => setWaterDetail((current) => ({ ...current, litersUsed: Number(event.target.value || 0) }))} />
              <Input name="waterRatePerCubicMeter" label="PHP per cubic meter" type="number" step="0.01" placeholder="40" value={waterDetail.ratePerCubicMeter || ""} onChange={(event) => setWaterDetail((current) => ({ ...current, ratePerCubicMeter: Number(event.target.value || 0) }))} />
            </div>
            <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm text-[#5f4a3d] sm:grid-cols-3">
              <CostingBreakdown label="Water PHP/L" value={waterCostDetail.pricePerLiter} />
              <CostingBreakdown label="Liters used" value={waterDetail.litersUsed} isCurrency={false} />
              <CostingBreakdown label="Water cost" value={waterCost} />
            </div>
          </div>
        </div>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Other one-off utility costs</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Use this only for utility costs that do not fit the gas, electricity, or water calculators above, like ice or delivery cooling.</p>
            </div>
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addUtilityRow} type="button">Add utility</button>
          </div>
          <div className="mt-3 grid gap-3">
            {utilityRows.map((row, index) => (
              <div className="grid gap-2 lg:grid-cols-[1fr_120px_1fr_70px]" key={row.rowId}>
                <Input name={`utilityName-${row.rowId}`} label={`Utility ${index + 1}`} placeholder="Oven preheat" defaultValue={row.name} />
                <Input name={`utilityCost-${row.rowId}`} label="Cost PHP" type="number" step="0.01" placeholder="20" value={row.cost || ""} onChange={(event) => setUtilityRows((current) => current.map((item) => item.rowId === row.rowId ? { ...item, cost: Number(event.target.value || 0) } : item))} />
                <Input name={`utilityNote-${row.rowId}`} label="Note" placeholder="30 min electric oven" defaultValue={row.note} />
                <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => {
                  setUtilityRows((current) => current.filter((item) => item.rowId !== row.rowId));
                  setLocalMessage("Utility row removed.");
                  setLocalMessageTone("good");
                }} type="button">Remove</button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm font-semibold text-[#5f4a3d]">Utility total: PHP {utilityTotal.toFixed(2)}</p>
        </div>
        <NamedCostSection addLabel="Add overhead" namePrefix="overhead" onAdd={() => addNamedCostRow(setOverheadRows, "Overhead")} rows={overheadRows} setRows={setOverheadRows} title="Overhead allocation" total={overheadCost} updateNamedCostRow={updateNamedCostRow} />
        <EquipmentUsageSection equipmentAllocations={equipmentAllocations} equipmentList={equipment} setEquipmentUsage={setEquipmentUsage} />
        <NamedCostSection
          addLabel="Add waste"
          extra={
            productBatchesForWaste.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-[#ead9c8] bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[#6f5a4c]">
                  Batch history: {(historicalRejectRate * 100).toFixed(1)}% rejected across {productBatchesForWaste.length} batch{productBatchesForWaste.length === 1 ? "" : "es"} — suggests PHP {suggestedWasteCost.toFixed(2)} waste allowance.
                </p>
                <button className="h-9 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={useSuggestedWasteCost} type="button">Use suggested waste</button>
              </div>
            ) : null
          }
          namePrefix="waste"
          onAdd={() => addNamedCostRow(setWasteRows, "Waste")}
          rows={wasteRows}
          setRows={setWasteRows}
          title="Waste and loss"
          total={wasteAllowance}
          updateNamedCostRow={updateNamedCostRow}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="suggestedPrice" label="Selling price per piece/unit" type="number" step="0.01" value={suggestedPrice || ""} onChange={(event) => setSuggestedPrice(Number(event.target.value || 0))} helper="The price you may charge per piece, box, or bottle." />
          <Input name="targetFoodCost" label="Target food cost %" type="number" step="0.01" value={targetFoodCost || ""} onChange={(event) => setTargetFoodCost(Number(event.target.value || 0))} helper="Use 0.35 for 35%. Suggested target price updates below." />
        </div>
        <div className="grid gap-3 rounded-md border border-[#ead9c8] bg-[#231813] p-4 text-[#fff8ef] sm:grid-cols-4">
          <CostingMetric featured label="Batch cost" value={`PHP ${totalBatchCost.toFixed(2)}`} />
          <CostingMetric featured label="Cost per piece" value={formatCostingMetric(costPerPiece, (value) => `PHP ${value.toFixed(2)}`)} />
          <CostingMetric label="Operating profit/unit" value={formatCostingMetric(grossProfit, (value) => `PHP ${value.toFixed(2)}`)} />
          <CostingMetric label="Food cost" value={formatCostingMetric(foodCostPercent, (value) => `${value.toFixed(1)}%`)} />
          <CostingMetric featured label="Operating margin" value={formatCostingMetric(margin, (value) => `${value.toFixed(1)}%`)} />
          <CostingMetric label="Markup" value={formatCostingMetric(markup, (value) => `${value.toFixed(1)}%`)} />
          <CostingMetric label="Break-even" value={formatCostingMetric(breakEvenUnits, (value) => (contributionMarginPerPiece && contributionMarginPerPiece > 0 ? `${value} pcs` : "Price below cost"))} />
          <CostingMetric label="Target price" value={formatCostingMetric(suggestedTargetPrice, (value) => `PHP ${value.toFixed(2)}`)} />
        </div>
        <div className="grid gap-2 rounded-md border border-[#ead9c8] bg-white p-3 text-sm text-[#5f4a3d] sm:grid-cols-4">
          <CostingBreakdown label="Ingredients" value={ingredientTotal} />
          <CostingBreakdown label="Packaging" value={packagingCost} />
          <CostingBreakdown label="Direct labor" value={laborEstimate} />
          <CostingBreakdown label="Gas" value={utilityBuckets.gas} />
          <CostingBreakdown label="Electricity" value={utilityBuckets.electricity} />
          <CostingBreakdown label="Water" value={utilityBuckets.water} />
          <CostingBreakdown label="Other direct costs" value={utilityBuckets.other} />
          <CostingBreakdown label="Equipment depreciation" value={equipmentDepreciationCost} />
          <CostingBreakdown label="Equipment maintenance" value={equipmentMaintenanceCost} />
          <CostingBreakdown label="Waste" value={wasteAllowance} />
          <CostingBreakdown label="Allocated overhead" value={overheadCost} />
          <CostingBreakdown label="Direct cost" value={directCost} />
          <CostingBreakdown label="Indirect cost" value={indirectCost} />
          <CostingBreakdown label="Total batch cost" value={totalBatchCost} />
        </div>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Selling Formats</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">
                How this batch is actually sold -- a single piece, a box of 3, a box of 6 -- each with its own packaging and true margin, built on the base production cost above (PHP {formatCostingMetric(baseProductionCostPerPiece, (value) => value.toFixed(2))} per piece).
              </p>
            </div>
            {!isSellingFormatsTableMissing ? (
              <button className="h-9 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addSellingFormat} type="button">Add selling format</button>
            ) : null}
          </div>
          {isSellingFormatsTableMissing ? (
            <div className="mt-3 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
              Selling Formats database tables are not set up yet. Run <strong>supabase-add-selling-formats.sql</strong> once, then reload this page. The rest of Costing still works normally in the meantime, and this costing can still be saved.
            </div>
          ) : (
            <>
              {formatRows.length === 0 ? (
                <p className="mt-3 text-sm text-[#6f5a4c]">No selling formats yet. Add one to see the true cost, profit, and margin for how this batch is actually sold.</p>
              ) : null}
              {formatsWithMetrics.some(({ format }) => format.isActive) ? (
                <div className="mt-3 overflow-x-auto rounded-md border border-[#ead9c8] bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#ead9c8] text-left text-xs uppercase tracking-wide text-[#9a5b2f]">
                        <th className="px-3 py-2">Format</th>
                        <th className="px-3 py-2">Pieces</th>
                        <th className="px-3 py-2">Price</th>
                        <th className="px-3 py-2">Cost</th>
                        <th className="px-3 py-2">Profit</th>
                        <th className="px-3 py-2">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {formatsWithMetrics.filter(({ format }) => format.isActive).map(({ format, totalCost, profit, margin: formatMargin }) => (
                        <tr className="border-b border-[#ead9c8] last:border-0" key={format.id}>
                          <td className="px-3 py-2 font-semibold text-[#5f4a3d]">{format.name || "Untitled format"}</td>
                          <td className="px-3 py-2">{format.piecesPerUnit}</td>
                          <td className="px-3 py-2">PHP {format.sellingPrice.toFixed(2)}</td>
                          <td className="px-3 py-2">{formatCostingMetric(totalCost, (value) => `PHP ${value.toFixed(2)}`)}</td>
                          <td className="px-3 py-2">{formatCostingMetric(profit, (value) => `PHP ${value.toFixed(2)}`)}</td>
                          <td className="px-3 py-2">{formatCostingMetric(formatMargin, (value) => `${value.toFixed(1)}%`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div className="mt-3 grid gap-3">
                {formatsWithMetrics.map(({ format, lines, packagingCost: formatPackagingCost, totalCost, profit, margin: formatMargin }) => (
                  <SellingFormatCard
                    costingYield={costingYield}
                    format={format}
                    formatPackagingCost={formatPackagingCost}
                    ingredients={ingredients}
                    key={format.id}
                    lines={lines}
                    margin={formatMargin}
                    onAddLine={() => addPackagingLine(format.id)}
                    onRemove={() => removeSellingFormat(format.id)}
                    onRemoveLine={removePackagingLine}
                    onSelectLineIngredient={(lineId, ingredientId) => selectPackagingLineIngredient(format.id, lineId, ingredientId)}
                    onSwitchLineToManual={switchPackagingLineToManual}
                    onUpdate={(changes) => updateSellingFormat(format.id, changes)}
                    onUpdateLine={updatePackagingLine}
                    onUpdateLineToCurrentCost={updatePackagingLineToCurrentCost}
                    profit={profit}
                    savedPackagingLineUnitCosts={savedPackagingLineUnitCosts}
                    supplies={supplies}
                    totalCost={totalCost}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        <Textarea name="notes" label="Costing notes" placeholder="What is estimated? What supplier price needs confirmation? Is this per batch, per piece, or per box?" defaultValue={getCostingBaseNotes(costing?.notes ?? "")} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{costing ? "Update costing" : "Save costing"}</Button>
          {costing ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
      <CostingPrintReport
        breakEvenUnits={breakEvenUnits}
        contributionMarginPerPiece={contributionMarginPerPiece}
        costPerPiece={costPerPiece}
        costingYield={costingYield}
        directCost={directCost}
        electricityCost={electricityCost}
        electricityCostDetail={electricityCostDetail}
        electricityDetail={electricityDetail}
        equipmentAllocations={equipmentAllocations}
        equipmentDepreciationCost={equipmentDepreciationCost}
        equipmentMaintenanceCost={equipmentMaintenanceCost}
        foodCostPercent={foodCostPercent}
        gasCost={gasCost}
        gasCostDetail={gasCostDetail}
        gasDetail={gasDetail}
        grossProfit={grossProfit}
        indirectCost={indirectCost}
        ingredientRows={ingredientRows}
        ingredientTotal={ingredientTotal}
        laborDetail={laborDetail}
        laborEstimate={laborEstimate}
        margin={margin}
        markup={markup}
        notes={getCostingBaseNotes(costing?.notes ?? "")}
        overheadCost={overheadCost}
        overheadRows={overheadRows}
        packagingCost={packagingCost}
        packagingRows={packagingRows}
        batchVersion={selectedBatch?.batchVersion ?? ""}
        productId={selectedProductId}
        products={products}
        suggestedPrice={suggestedPrice}
        suggestedTargetPrice={suggestedTargetPrice}
        targetFoodCost={targetFoodCost}
        totalBatchCost={totalBatchCost}
        utilityBuckets={utilityBuckets}
        utilityRows={utilityRows}
        utilityTotal={utilityTotal}
        wasteAllowance={wasteAllowance}
        wasteRows={wasteRows}
        waterCost={waterCost}
        waterCostDetail={waterCostDetail}
        waterDetail={waterDetail}
        formatsWithMetrics={formatsWithMetrics}
      />
    </FormPanel>
  );
}

function SellingFormatCard({
  costingYield,
  format,
  formatPackagingCost,
  ingredients,
  lines,
  margin,
  onAddLine,
  onRemove,
  onRemoveLine,
  onSelectLineIngredient,
  onSwitchLineToManual,
  onUpdate,
  onUpdateLine,
  onUpdateLineToCurrentCost,
  profit,
  savedPackagingLineUnitCosts,
  supplies,
  totalCost,
}: {
  costingYield: number;
  format: SellingFormat;
  formatPackagingCost: number;
  ingredients: Ingredient[];
  lines: SellingFormatPackagingLine[];
  margin: number | null;
  onAddLine: () => void;
  onRemove: () => void;
  onRemoveLine: (lineId: string) => void;
  onSelectLineIngredient: (lineId: string, ingredientId: string) => void;
  onSwitchLineToManual: (lineId: string) => void;
  onUpdate: (changes: Partial<SellingFormat>) => void;
  onUpdateLine: (lineId: string, changes: Partial<SellingFormatPackagingLine>) => void;
  onUpdateLineToCurrentCost: (lineId: string) => void;
  profit: number | null;
  savedPackagingLineUnitCosts: Map<string, number>;
  supplies: SupplyEntry[];
  totalCost: number | null;
}) {
  const overYield = costingYield > 0 && format.piecesPerUnit > costingYield;

  return (
    <div className={`rounded-md border p-3 ${format.isActive ? "border-[#ead9c8] bg-white" : "border-[#ead9c8] bg-[#f5efe6] opacity-80"}`}>
      <input name={`sellingFormatPackagingLineRowIds-${format.id}`} type="hidden" value={lines.map((line) => line.id).join(",")} />
      <input name={`sellingFormatIsActive-${format.id}`} type="hidden" value={format.isActive ? "true" : "false"} />
      <input name={`sellingFormatSortOrder-${format.id}`} type="hidden" value={format.sortOrder} />
      <input name={`sellingFormatNotes-${format.id}`} type="hidden" value={format.notes} />
      <div className="grid gap-2 lg:grid-cols-[1.5fr_110px_130px_auto_70px]">
        <Input label="Format name" name={`sellingFormatName-${format.id}`} placeholder="Single Brownie / Box of 6" value={format.name} onChange={(event) => onUpdate({ name: event.target.value })} />
        <Input
          helper={overYield ? `Batch yields ${costingYield} -- this uses more than that.` : undefined}
          label="Pieces per unit"
          name={`sellingFormatPiecesPerUnit-${format.id}`}
          step="0.01"
          type="number"
          value={format.piecesPerUnit || ""}
          onChange={(event) => onUpdate({ piecesPerUnit: Number(event.target.value || 0) })}
        />
        <Input label="Selling price PHP" name={`sellingFormatSellingPrice-${format.id}`} step="0.01" type="number" value={format.sellingPrice || ""} onChange={(event) => onUpdate({ sellingPrice: Number(event.target.value || 0) })} />
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input checked={format.isActive} onChange={(event) => onUpdate({ isActive: event.target.checked })} type="checkbox" />
          Active
        </label>
        <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={onRemove} type="button">Remove</button>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Packaging for this format</p>
        <button className="h-8 rounded-md border border-[#d8c7b7] bg-white px-2 text-xs font-semibold text-[#5f4a3d]" onClick={onAddLine} type="button">Add packaging line</button>
      </div>
      <div className="mt-2 grid gap-2">
        {lines.length === 0 ? <p className="text-sm text-[#6f5a4c]">No packaging lines yet. Some products legitimately sell with none.</p> : null}
        {lines.map((line) => {
          const isCatalogLinked = Boolean(line.ingredientId);
          const savedUnitCost = savedPackagingLineUnitCosts.get(line.id);
          const currentUnitCost = isCatalogLinked ? resolvePackagingItemUnitCost(line.ingredientId, ingredients, supplies) : 0;
          const costsDiffer = isCatalogLinked && savedUnitCost !== undefined && Math.abs(currentUnitCost - savedUnitCost) > 0.001;

          return (
            <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-2" key={line.id}>
              <input name={`sellingFormatPackagingLineIngredientId-${line.id}`} type="hidden" value={line.ingredientId} />
              <input name={`sellingFormatPackagingLineIsManualCost-${line.id}`} type="hidden" value={line.isManualCost ? "true" : "false"} />
              <input name={`sellingFormatPackagingLineSortOrder-${line.id}`} type="hidden" value={line.sortOrder} />
              <input name={`sellingFormatPackagingLineNote-${line.id}`} type="hidden" value={line.note} />
              {line.isManualCost || !isCatalogLinked ? (
                <div className="grid gap-2 lg:grid-cols-[1fr_90px_110px_100px_70px]">
                  <Input label="Name" name={`sellingFormatPackagingLineName-${line.id}`} placeholder="Kraft box" value={line.name} onChange={(event) => onUpdateLine(line.id, { name: event.target.value })} />
                  <Input label="Qty" name={`sellingFormatPackagingLineQuantity-${line.id}`} step="0.01" type="number" value={line.quantity || ""} onChange={(event) => onUpdateLine(line.id, { quantity: Number(event.target.value || 0) })} />
                  <Input label="Unit" name={`sellingFormatPackagingLineUnit-${line.id}`} placeholder="pcs" value={line.unit} onChange={(event) => onUpdateLine(line.id, { unit: event.target.value })} />
                  <Input label="Cost PHP" name={`sellingFormatPackagingLineUnitCostSnapshot-${line.id}`} step="0.0001" type="number" value={line.unitCostSnapshot || ""} onChange={(event) => onUpdateLine(line.id, { unitCostSnapshot: Number(event.target.value || 0) })} />
                  <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => onRemoveLine(line.id)} type="button">Remove</button>
                </div>
              ) : (
                <>
                  <input name={`sellingFormatPackagingLineName-${line.id}`} type="hidden" value={line.name} />
                  <input name={`sellingFormatPackagingLineUnit-${line.id}`} type="hidden" value={line.unit} />
                  <input name={`sellingFormatPackagingLineUnitCostSnapshot-${line.id}`} type="hidden" value={line.unitCostSnapshot} />
                  <div className="grid gap-2 lg:grid-cols-[1fr_90px_70px]">
                    <div>
                      <p className="text-xs font-semibold text-[#5f4a3d]">Catalog item</p>
                      <p className="text-sm">{line.name} <span className="text-[#9a5b2f]">({line.unit || "unit"})</span></p>
                    </div>
                    <Input label="Qty" name={`sellingFormatPackagingLineQuantity-${line.id}`} step="0.01" type="number" value={line.quantity || ""} onChange={(event) => onUpdateLine(line.id, { quantity: Number(event.target.value || 0) })} />
                    <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => onRemoveLine(line.id)} type="button">Remove</button>
                  </div>
                </>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6f5a4c]">
                {isCatalogLinked && !line.isManualCost ? (
                  <>
                    <span>Saved PHP {line.unitCostSnapshot.toFixed(2)}/{line.unit || "unit"}{costsDiffer ? ` (current PHP ${currentUnitCost.toFixed(2)})` : ""}</span>
                    {costsDiffer ? (
                      <button className="rounded border border-[#d8c7b7] bg-white px-2 py-0.5 font-semibold text-[#5f4a3d]" onClick={() => onUpdateLineToCurrentCost(line.id)} type="button">Update to current cost</button>
                    ) : null}
                    <button className="rounded border border-[#d8c7b7] bg-white px-2 py-0.5 font-semibold text-[#5f4a3d]" onClick={() => onSwitchLineToManual(line.id)} type="button">Enter manually instead</button>
                  </>
                ) : (
                  <div className="w-full">
                    <IngredientPicker
                      defaultCategory="packaging"
                      ingredients={ingredients}
                      onSelect={(ingredientId) => onSelectLineIngredient(line.id, ingredientId)}
                      placeholder="Search packaging supplies..."
                      selectedIngredientId={line.ingredientId}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-white p-2 text-sm text-[#5f4a3d] sm:grid-cols-4">
        <CostingBreakdown label="Packaging" value={formatPackagingCost} />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Total cost/unit</p>
          <p className="mt-1 font-semibold">{formatCostingMetric(totalCost, (value) => `PHP ${value.toFixed(2)}`)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Profit/unit</p>
          <p className="mt-1 font-semibold">{formatCostingMetric(profit, (value) => `PHP ${value.toFixed(2)}`)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Margin</p>
          <p className="mt-1 font-semibold">{formatCostingMetric(margin, (value) => `${value.toFixed(1)}%`)}</p>
        </div>
      </div>
    </div>
  );
}

function MoveToSellingFormatConfirm({
  costingYield,
  formatRows,
  onCancel,
  onChangeInterpretation,
  onChangeManualAmount,
  onConfirm,
  pendingMove,
}: {
  costingYield: number;
  formatRows: SellingFormat[];
  onCancel: () => void;
  onChangeInterpretation: (interpretation: SellingFormatMoveInterpretation) => void;
  onChangeManualAmount: (amount: number) => void;
  onConfirm: () => void;
  pendingMove: { row: CostingNamedCostRow; formatId: string; interpretation: SellingFormatMoveInterpretation; manualAmount: number };
}) {
  const targetFormat = formatRows.find((format) => format.id === pendingMove.formatId);
  if (!targetFormat) {
    return null;
  }

  const canDivideAcrossYield = costingYield > 0;
  const previewAmount = calculateMoveToSellingFormatAmount(pendingMove.interpretation, {
    wholeBatchAmount: pendingMove.row.cost,
    costingYield,
    piecesPerUnit: targetFormat.piecesPerUnit,
    manualAmount: pendingMove.manualAmount,
  });

  return (
    <div className="mt-2 rounded-md border border-[#d8c7b7] bg-white p-2 text-xs text-[#5f4a3d]">
      <p className="font-semibold">
        &quot;{pendingMove.row.name || "This item"}&quot; is PHP {pendingMove.row.cost.toFixed(2)} for the whole batch. How should that become a per-unit cost in &quot;{targetFormat.name || "this format"}&quot;?
      </p>
      <div className="mt-2 grid gap-2">
        <label className="flex flex-wrap items-center gap-2">
          <input
            checked={pendingMove.interpretation === "divide-across-yield"}
            disabled={!canDivideAcrossYield}
            onChange={() => onChangeInterpretation("divide-across-yield")}
            type="radio"
          />
          <span>
            Divide across the batch yield ({canDivideAcrossYield ? costingYield : "not set"}), scaled to {targetFormat.piecesPerUnit} piece{targetFormat.piecesPerUnit === 1 ? "" : "s"}
            {canDivideAcrossYield ? ` -- PHP ${((pendingMove.row.cost / costingYield) * targetFormat.piecesPerUnit).toFixed(2)}` : " (needs a real batch yield first)"}
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input checked={pendingMove.interpretation === "use-whole-amount"} onChange={() => onChangeInterpretation("use-whole-amount")} type="radio" />
          <span>Use the whole PHP {pendingMove.row.cost.toFixed(2)} for each selling unit</span>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input checked={pendingMove.interpretation === "manual"} onChange={() => onChangeInterpretation("manual")} type="radio" />
          <span>Enter the correct amount manually:</span>
          <input
            className="h-7 w-24 rounded border border-[#d8c7b7] px-1"
            onChange={(event) => onChangeManualAmount(Number(event.target.value || 0))}
            step="0.01"
            type="number"
            value={pendingMove.manualAmount || ""}
          />
        </label>
      </div>
      <p className="mt-2 font-semibold">{previewAmount === null ? "Choose a valid option before confirming." : `Result: PHP ${previewAmount.toFixed(2)} per unit`}</p>
      <div className="mt-2 flex gap-2">
        <button
          className="h-7 rounded-md border border-[#d8c7b7] bg-[#231813] px-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={previewAmount === null}
          onClick={onConfirm}
          type="button"
        >
          Confirm move
        </button>
        <button className="h-7 rounded-md border border-[#d8c7b7] bg-white px-2 font-semibold text-[#5f4a3d]" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

function NamedCostTable({ emptyLabel, rows, title, total }: { emptyLabel: string; rows: CostingNamedCostRow[]; title: string; total: number }) {
  const meaningfulRows = compactNamedCostRows(rows);
  return (
    <>
      <h2>{title}</h2>
      <table>
        <thead>
          <tr><th>Item</th><th>PHP</th><th>Note</th></tr>
        </thead>
        <tbody>
          {meaningfulRows.length === 0 ? <tr><td colSpan={3}>{emptyLabel}</td></tr> : null}
          {meaningfulRows.map((row) => (
            <tr key={row.rowId}>
              <td>{row.name || title}</td>
              <td>{row.cost.toFixed(2)}</td>
              <td>{row.note}</td>
            </tr>
          ))}
          <tr><th>{title} total</th><td colSpan={2}>PHP {total.toFixed(2)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function CostingPrintReport({
  batchVersion,
  breakEvenUnits,
  contributionMarginPerPiece,
  costPerPiece,
  costingYield,
  directCost,
  electricityCost,
  electricityCostDetail,
  electricityDetail,
  equipmentAllocations,
  equipmentDepreciationCost,
  equipmentMaintenanceCost,
  foodCostPercent,
  formatsWithMetrics,
  gasCost,
  gasCostDetail,
  gasDetail,
  grossProfit,
  indirectCost,
  ingredientRows,
  ingredientTotal,
  laborDetail,
  laborEstimate,
  margin,
  markup,
  notes,
  overheadCost,
  overheadRows,
  packagingCost,
  packagingRows,
  productId,
  products,
  suggestedPrice,
  suggestedTargetPrice,
  targetFoodCost,
  totalBatchCost,
  utilityBuckets,
  utilityRows,
  utilityTotal,
  wasteAllowance,
  wasteRows,
  waterCost,
  waterCostDetail,
  waterDetail,
}: {
  batchVersion: string;
  breakEvenUnits: number | null;
  contributionMarginPerPiece: number | null;
  costPerPiece: number | null;
  costingYield: number;
  directCost: number;
  electricityCost: number;
  electricityCostDetail: { cost: number; kwhUsed: number };
  electricityDetail: CostingElectricityDetail;
  equipmentAllocations: EquipmentAllocation[];
  equipmentDepreciationCost: number;
  equipmentMaintenanceCost: number;
  foodCostPercent: number | null;
  formatsWithMetrics: SellingFormatWithMetrics[];
  gasCost: number;
  gasCostDetail: { cost: number; costPerMinute: number; pricePerKg: number };
  gasDetail: CostingGasDetail;
  grossProfit: number | null;
  indirectCost: number;
  ingredientRows: CostingIngredientRow[];
  ingredientTotal: number;
  laborDetail: CostingLaborDetail;
  laborEstimate: number;
  margin: number | null;
  markup: number | null;
  notes: string;
  overheadCost: number;
  overheadRows: CostingNamedCostRow[];
  packagingCost: number;
  packagingRows: CostingNamedCostRow[];
  productId: string;
  products: Product[];
  suggestedPrice: number;
  suggestedTargetPrice: number | null;
  targetFoodCost: number;
  totalBatchCost: number;
  utilityBuckets: { electricity: number; gas: number; other: number; water: number };
  utilityRows: CostingUtilityRow[];
  utilityTotal: number;
  wasteAllowance: number;
  wasteRows: CostingNamedCostRow[];
  waterCost: number;
  waterCostDetail: { cost: number; pricePerLiter: number };
  waterDetail: CostingWaterDetail;
}) {
  const activeLaborMinutes = laborDetail.prepMinutes + laborDetail.packagingMinutes + laborDetail.cleaningMinutes;
  const passiveMinutes = laborDetail.cookingMinutes + laborDetail.coolingMinutes;

  return (
    <div className="print-report" id="costing-print-report">
      <h1>Aly & Shin Costing Sheet</h1>
      <p>{batchDisplayName(productId, batchVersion, products)} / Generated {getToday()}</p>

      <h2>Summary</h2>
      <table>
        <tbody>
          <tr><th>Batch cost</th><td>PHP {totalBatchCost.toFixed(2)}</td><th>Yield</th><td>{costingYield || 0} pieces/units</td></tr>
          <tr><th>Cost per piece</th><td>{formatCostingMetric(costPerPiece, (value) => `PHP ${value.toFixed(2)}`)}</td><th>Selling price</th><td>PHP {suggestedPrice.toFixed(2)}</td></tr>
          <tr><th>Operating profit/unit</th><td>{formatCostingMetric(grossProfit, (value) => `PHP ${value.toFixed(2)}`)}</td><th>Operating margin</th><td>{formatCostingMetric(margin, (value) => `${value.toFixed(1)}%`)}</td></tr>
          <tr><th>Food cost</th><td>{formatCostingMetric(foodCostPercent, (value) => `${value.toFixed(1)}%`)}</td><th>Markup</th><td>{formatCostingMetric(markup, (value) => `${value.toFixed(1)}%`)}</td></tr>
          <tr><th>Target food cost</th><td>{(targetFoodCost * 100).toFixed(1)}%</td><th>Target price</th><td>{formatCostingMetric(suggestedTargetPrice, (value) => `PHP ${value.toFixed(2)}`)}</td></tr>
          <tr><th>Break-even</th><td>{formatCostingMetric(breakEvenUnits, (value) => (contributionMarginPerPiece && contributionMarginPerPiece > 0 ? `${value} pieces to cover overhead + equipment` : "Not achievable at this price"))}</td><th>Contribution margin/unit</th><td>{formatCostingMetric(contributionMarginPerPiece, (value) => `PHP ${value.toFixed(2)}`)}</td></tr>
        </tbody>
      </table>

      <h2>Ingredients</h2>
      <table>
        <thead>
          <tr><th>Brand</th><th>Ingredient</th><th>Qty</th><th>Unit</th><th>Used PHP</th><th>Cost Note</th></tr>
        </thead>
        <tbody>
          {ingredientRows.map((row) => (
            <tr key={row.rowId}>
              <td>{row.brandName}</td>
              <td>{row.ingredientName}</td>
              <td>{row.quantityUsed}</td>
              <td>{row.unit}</td>
              <td>{row.cost.toFixed(2)}</td>
              <td>{row.supplierNote}</td>
            </tr>
          ))}
          <tr><th>Ingredients total</th><td colSpan={5}>PHP {ingredientTotal.toFixed(2)}</td></tr>
        </tbody>
      </table>

      <NamedCostTable emptyLabel="No packaging cost entered" rows={packagingRows} title="Packaging" total={packagingCost} />

      <h2>Labor</h2>
      <table>
        <tbody>
          <tr><th>Prep min</th><td>{laborDetail.prepMinutes}</td><th>Cooking min</th><td>{laborDetail.cookingMinutes}</td></tr>
          <tr><th>Cooling min</th><td>{laborDetail.coolingMinutes}</td><th>Packaging min</th><td>{laborDetail.packagingMinutes}</td></tr>
          <tr><th>Cleaning min</th><td>{laborDetail.cleaningMinutes}</td><th>Active rate</th><td>PHP {laborDetail.activeRate.toFixed(2)}/hr</td></tr>
          <tr><th>Active minutes (paid)</th><td>{activeLaborMinutes}</td><th>Passive minutes</th><td>{passiveMinutes}</td></tr>
          <tr><th>Labor cost</th><td colSpan={3}>PHP {laborEstimate.toFixed(2)}</td></tr>
        </tbody>
      </table>

      <NamedCostTable emptyLabel="No utility cost entered" rows={utilityRows} title="Utilities" total={utilityTotal} />
      <h2>Utility Calculations</h2>
      <table>
        <tbody>
          <tr><th>Gas equipment</th><td>{gasDetail.equipmentName || "Gas equipment"}</td><th>Gas refill</th><td>PHP {gasDetail.gasPrice.toFixed(2)}</td></tr>
          <tr><th>Gas tank</th><td>{gasDetail.gasKg || 0} kg</td><th>Gas use</th><td>{gasDetail.gasUseKgPerHour || 0} kg/hour</td></tr>
          <tr><th>Gas PHP/min</th><td>PHP {gasCostDetail.costPerMinute.toFixed(4)}</td><th>Gas batch cost</th><td>PHP {gasCost.toFixed(2)}</td></tr>
          <tr><th>Electric equipment</th><td>{electricityDetail.equipmentName || "Electric equipment"}</td><th>Use</th><td>{electricityDetail.applianceWatts || 0}W / {electricityDetail.minutes || 0} min</td></tr>
          <tr><th>kWh used</th><td>{electricityCostDetail.kwhUsed.toFixed(4)}</td><th>Rate</th><td>PHP {electricityDetail.ratePerKwh.toFixed(2)}/kWh</td></tr>
          <tr><th>Electricity batch cost</th><td>PHP {electricityCost.toFixed(2)}</td><th /><td /></tr>
          <tr><th>Water used</th><td>{waterDetail.litersUsed || 0} L</td><th>Water PHP/L</th><td>PHP {waterCostDetail.pricePerLiter.toFixed(4)}</td></tr>
          <tr><th>Water batch cost</th><td>PHP {waterCost.toFixed(2)}</td><th>Water rate</th><td>PHP {waterDetail.ratePerCubicMeter.toFixed(2)}/m3</td></tr>
        </tbody>
      </table>
      <NamedCostTable emptyLabel="No overhead allocated" rows={overheadRows} title="Overhead" total={overheadCost} />

      <h2>Equipment Usage</h2>
      <table>
        <thead>
          <tr><th>Equipment</th><th>Shared batches</th><th>Depreciation</th><th>Maintenance</th><th>Total</th></tr>
        </thead>
        <tbody>
          {equipmentAllocations.length === 0 ? <tr><td colSpan={5}>No equipment assigned to this recipe</td></tr> : null}
          {equipmentAllocations.map((allocation) => (
            <tr key={allocation.row.rowId}>
              <td>{allocation.equipmentItem ? `${allocation.equipmentItem.brand ? `${allocation.equipmentItem.brand} ` : ""}${allocation.equipmentItem.name}` : "Equipment not found"}</td>
              <td>{allocation.row.sharedBatches}</td>
              <td>{allocation.allocatedDepreciation.toFixed(2)}</td>
              <td>{allocation.allocatedMaintenance.toFixed(2)}</td>
              <td>{allocation.allocatedTotal.toFixed(2)}</td>
            </tr>
          ))}
          <tr><th>Equipment total</th><td colSpan={2} /><td colSpan={2}>PHP {(equipmentDepreciationCost + equipmentMaintenanceCost).toFixed(2)}</td></tr>
        </tbody>
      </table>

      <NamedCostTable emptyLabel="No waste allowance entered" rows={wasteRows} title="Waste" total={wasteAllowance} />

      <h2>Cost Recap</h2>
      <table>
        <tbody>
          <tr><th>Ingredients</th><td>PHP {ingredientTotal.toFixed(2)}</td><th>Packaging</th><td>PHP {packagingCost.toFixed(2)}</td></tr>
          <tr><th>Direct labor</th><td>PHP {laborEstimate.toFixed(2)}</td><th>Waste</th><td>PHP {wasteAllowance.toFixed(2)}</td></tr>
          <tr><th>Gas</th><td>PHP {utilityBuckets.gas.toFixed(2)}</td><th>Electricity</th><td>PHP {utilityBuckets.electricity.toFixed(2)}</td></tr>
          <tr><th>Water</th><td>PHP {utilityBuckets.water.toFixed(2)}</td><th>Other direct costs</th><td>PHP {utilityBuckets.other.toFixed(2)}</td></tr>
          <tr><th>Equipment depreciation</th><td>PHP {equipmentDepreciationCost.toFixed(2)}</td><th>Equipment maintenance</th><td>PHP {equipmentMaintenanceCost.toFixed(2)}</td></tr>
          <tr><th>Allocated overhead</th><td>PHP {overheadCost.toFixed(2)}</td><th /><td /></tr>
          <tr><th>Direct cost</th><td>PHP {directCost.toFixed(2)}</td><th>Indirect cost</th><td>PHP {indirectCost.toFixed(2)}</td></tr>
          <tr><th>Total batch cost</th><td colSpan={3}>PHP {totalBatchCost.toFixed(2)}</td></tr>
        </tbody>
      </table>

      {formatsWithMetrics.length > 0 ? (
        <>
          <h2>Selling Formats</h2>
          <table>
            <thead>
              <tr><th>Format</th><th>Status</th><th>Pieces</th><th>Price</th><th>Cost</th><th>Profit</th><th>Margin</th></tr>
            </thead>
            <tbody>
              {formatsWithMetrics.map(({ format, totalCost, profit, margin: formatMargin }) => (
                <tr key={format.id}>
                  <td>{format.name}</td>
                  <td>{format.isActive ? "Active" : "Archived"}</td>
                  <td>{format.piecesPerUnit}</td>
                  <td>PHP {format.sellingPrice.toFixed(2)}</td>
                  <td>{formatCostingMetric(totalCost, (value) => `PHP ${value.toFixed(2)}`)}</td>
                  <td>{formatCostingMetric(profit, (value) => `PHP ${value.toFixed(2)}`)}</td>
                  <td>{formatCostingMetric(formatMargin, (value) => `${value.toFixed(1)}%`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {formatsWithMetrics.map(({ format, lines, packagingCost: formatPackagingCost }) => (
            <NamedCostTable
              emptyLabel={`No packaging lines for ${format.name || "this format"}`}
              key={format.id}
              rows={lines.map((line) => ({ cost: line.quantity * line.unitCostSnapshot, name: line.name, note: line.isManualCost ? "manual" : "catalog-linked", rowId: line.id }))}
              title={`${format.name || "Untitled format"} packaging`}
              total={formatPackagingCost}
            />
          ))}
        </>
      ) : null}

      {notes ? (
        <>
          <h2>Notes</h2>
          <p>{notes}</p>
        </>
      ) : null}
    </div>
  );
}

function CostingMetric({ label, value, featured = false }: { label: string; value: string; featured?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#ddb778]">{label}</p>
      <p className={`mt-2 font-semibold ${featured ? "text-2xl" : "text-lg"}`}>{value}</p>
    </div>
  );
}

type EquipmentAllocation = {
  allocatedDepreciation: number;
  allocatedMaintenance: number;
  allocatedTotal: number;
  equipmentItem: EquipmentEntry | undefined;
  row: EquipmentUsageRow;
};

type SellingFormatWithMetrics = {
  format: SellingFormat;
  lines: SellingFormatPackagingLine[];
  packagingCost: number;
  totalCost: number | null;
  profit: number | null;
  margin: number | null;
};

function EquipmentUsageSection({
  equipmentAllocations,
  equipmentList,
  setEquipmentUsage,
}: {
  equipmentAllocations: EquipmentAllocation[];
  equipmentList: EquipmentEntry[];
  setEquipmentUsage: Dispatch<SetStateAction<EquipmentUsageRow[]>>;
}) {
  const activeEquipment = equipmentList.filter((item) => item.isActive && item.calculationMode !== "gas-burn-rate");
  const totalDepreciation = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedDepreciation, 0);
  const totalMaintenance = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedMaintenance, 0);
  const totalAllocated = equipmentAllocations.reduce((total, allocation) => total + allocation.allocatedTotal, 0);

  function addUsageRow() {
    const usedIds = new Set(equipmentAllocations.map((allocation) => allocation.row.equipmentId));
    const firstAvailable = activeEquipment.find((item) => !usedIds.has(item.id));
    setEquipmentUsage((current) => [...current, { equipmentId: firstAvailable?.id ?? "", rowId: crypto.randomUUID(), sharedBatches: 1 }]);
  }

  function updateUsageRow(rowId: string, changes: Partial<EquipmentUsageRow>) {
    setEquipmentUsage((current) => current.map((row) => (row.rowId === rowId ? { ...row, ...changes } : row)));
  }

  function removeUsageRow(rowId: string) {
    setEquipmentUsage((current) => current.filter((row) => row.rowId !== rowId));
  }

  return (
    <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Equipment depreciation + maintenance</p>
          <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Use this card for ownership cost: appliance purchase price, useful life, and maintenance from the Equipment page. Gas and electricity usage stay in the utility cards above.</p>
        </div>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d] disabled:cursor-not-allowed disabled:opacity-50" disabled={activeEquipment.length === 0} onClick={addUsageRow} type="button">Add equipment</button>
      </div>
      {activeEquipment.length === 0 ? <p className="mt-3 text-sm text-[#6f5a4c]">No depreciation equipment yet. Add an appliance on the Equipment page with depreciation or replacement-reserve mode first.</p> : null}
      <div className="mt-3 grid gap-2">
        {equipmentAllocations.map((allocation) => (
          <div className="grid items-start gap-2 lg:grid-cols-[1fr_120px_140px_70px]" key={allocation.row.rowId}>
            <label className="grid gap-1 text-sm font-medium">
              Equipment
              <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" name={`equipmentUsageEquipmentId-${allocation.row.rowId}`} onChange={(event) => updateUsageRow(allocation.row.rowId, { equipmentId: event.target.value })} value={allocation.row.equipmentId}>
                <option value="">Select equipment</option>
                {activeEquipment.map((item) => <option key={item.id} value={item.id}>{item.brand ? `${item.brand} ` : ""}{item.name}</option>)}
              </select>
            </label>
            <Input label="Shared batches" min="1" name={`equipmentUsageSharedBatches-${allocation.row.rowId}`} step="1" type="number" value={allocation.row.sharedBatches || ""} onChange={(event) => updateUsageRow(allocation.row.rowId, { sharedBatches: Number(event.target.value || 1) })} />
            <div className="mt-6 text-sm">
              <p className="font-semibold text-[#5f4a3d]">PHP {allocation.allocatedTotal.toFixed(2)}</p>
              <p className="text-xs text-[#6f5a4c]">
                dep {allocation.allocatedDepreciation.toFixed(2)} + maint {allocation.allocatedMaintenance.toFixed(2)}
              </p>
            </div>
            <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => removeUsageRow(allocation.row.rowId)} type="button">Remove</button>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 rounded-md border border-[#ead9c8] bg-white p-3 text-sm text-[#5f4a3d] sm:grid-cols-3">
        <CostingBreakdown label="Depreciation" value={totalDepreciation} />
        <CostingBreakdown label="Maintenance" value={totalMaintenance} />
        <CostingBreakdown label="Dep + maintenance" value={totalAllocated} />
      </div>
    </div>
  );
}

function NamedCostSection({
  addLabel,
  extra,
  helperNote,
  namePrefix,
  onAdd,
  renderRowExtra,
  rows,
  setRows,
  title,
  total,
  updateNamedCostRow,
}: {
  addLabel: string;
  extra?: ReactNode;
  helperNote?: ReactNode;
  namePrefix: string;
  onAdd: () => void;
  renderRowExtra?: (row: CostingNamedCostRow) => ReactNode;
  rows: CostingNamedCostRow[];
  setRows: Dispatch<SetStateAction<CostingNamedCostRow[]>>;
  title: string;
  total: number;
  updateNamedCostRow: (setRows: Dispatch<SetStateAction<CostingNamedCostRow[]>>, rowId: string, changes: Partial<CostingNamedCostRow>) => void;
}) {
  return (
    <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Use per-batch costs so the dashboard stays comparable across products.</p>
          {helperNote}
        </div>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={onAdd} type="button">{addLabel}</button>
      </div>
      {extra}
      <div className="mt-3 grid gap-2">
        {rows.map((row) => (
          <div key={row.rowId}>
            <div className="grid gap-2 lg:grid-cols-[1fr_120px_1fr_70px]">
              <Input name={`${namePrefix}Name-${row.rowId}`} label="Name" value={row.name} onChange={(event) => updateNamedCostRow(setRows, row.rowId, { name: event.target.value })} />
              <Input name={`${namePrefix}Cost-${row.rowId}`} label="Cost PHP" type="number" step="0.01" value={row.cost || ""} onChange={(event) => updateNamedCostRow(setRows, row.rowId, { cost: Number(event.target.value || 0) })} />
              <Input name={`${namePrefix}Note-${row.rowId}`} label="Note" value={row.note} onChange={(event) => updateNamedCostRow(setRows, row.rowId, { note: event.target.value })} />
              <button className="mt-6 h-10 rounded-md border border-[#d8c7b7] bg-white text-sm font-semibold text-[#8a3827]" onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))} type="button">Remove</button>
            </div>
            {renderRowExtra?.(row)}
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm font-semibold text-[#5f4a3d]">Total: PHP {total.toFixed(2)}</p>
    </div>
  );
}

function CostingBreakdown({ isCurrency = true, label, value }: { isCurrency?: boolean; label: string; value: number }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{label}</p>
      <p className="mt-1 font-semibold">{isCurrency ? `PHP ${Number(value || 0).toFixed(2)}` : Number(value || 0).toFixed(0)}</p>
    </div>
  );
}

function CostingGuide() {
  return (
    <Panel title="Costing Rules" icon={<Sparkles size={18} />}>
      <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
        <p>Cost one real product batch. Do not average guesses across different recipes.</p>
        <ul className="space-y-2">
          <li><strong>Ingredients:</strong> enter the quantity used and the peso cost of that used amount.</li>
          <li><strong>Vague units:</strong> tsp, tbsp, and cup can match g/ml supply prices when the ingredient has a known density. Gram conversions are estimates.</li>
          <li><strong>Packaging:</strong> box, cup, bottle, label, bag, seal, and insert.</li>
          <li><strong>Utilities:</strong> add only meaningful costs for this test.</li>
          <li><strong>Labor:</strong> owner&apos;s wage for mixing, baking/cooking, cooling, packing, cleaning, and admin time. Profit comes after labor is paid.</li>
        </ul>
      </div>
    </Panel>
  );
}

function BatchTastingSection({
  batchId,
  deleteTasting,
  productId,
  saveTasting,
  tastings,
}: {
  batchId: string;
  deleteTasting: (tastingId: string) => void;
  productId: string;
  saveTasting: (formData: FormData) => void;
  tastings: TastingFeedback[];
}) {
  const [isAdding, setIsAdding] = useState(false);

  function submitCheckpoint(formData: FormData) {
    saveTasting(formData);
    setIsAdding(false);
  }

  return (
    <div className="mt-4 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold">Tasting checkpoints</p>
        <button className="h-9 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setIsAdding((current) => !current)} type="button">
          {isAdding ? "Cancel" : "Add tasting checkpoint"}
        </button>
      </div>
      {tastings.length === 0 && !isAdding ? <p className="mt-2 text-sm text-[#6f5a4c]">No tasting checkpoints yet — add one anytime, like 2 hours or 24 hours after baking.</p> : null}
      {tastings.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {tastings.map((tasting) => (
            <div className="flex items-start justify-between gap-3 rounded-md border border-[#ead9c8] bg-white p-3 text-sm" key={tasting.id}>
              <div>
                <p className="font-semibold">{tasting.timeLabel || "No timing noted"} — {tasting.tasterName}: {tasting.rating}/10</p>
                <p className="mt-1 leading-5 text-[#6f5a4c]">
                  Would buy: {tasting.wouldBuy}. Reorder: {tasting.wouldReorder}. Pay: PHP {tasting.willingToPay || 0}.
                  {tasting.liked ? ` Liked: ${tasting.liked}.` : ""}
                  {tasting.improve ? ` Improve: ${tasting.improve}.` : ""}
                  {tasting.packagingReaction ? ` Packaging: ${tasting.packagingReaction}.` : ""}
                </p>
              </div>
              <button className="shrink-0 text-xs font-semibold text-[#8a3827] underline" onClick={() => window.confirm("Delete this tasting checkpoint?") ? deleteTasting(tasting.id) : undefined} type="button">Delete</button>
            </div>
          ))}
        </div>
      ) : null}
      {isAdding ? (
        <form action={submitCheckpoint} className="mt-3 grid gap-3 rounded-md border border-[#ead9c8] bg-white p-3">
          <input name="productId" type="hidden" value={productId} />
          <input name="batchId" type="hidden" value={batchId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="timeLabel" label="Checkpoint timing" placeholder="2 hours post-bake" helper="Whatever timing fits — 2 hours, 24 hours, Day 3." />
            <Input name="tasterName" label="Taster name" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="rating" label="Rating 1-10" type="number" min="1" max="10" />
            <Input name="willingToPay" label="Willing to pay" type="number" />
          </div>
          <Textarea name="liked" label="What they liked" />
          <Textarea name="improve" label="What should improve" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="wouldBuy" label="Would buy" options={["yes", "maybe", "no"]} defaultValue="maybe" />
            <Select name="wouldReorder" label="Would reorder" options={["yes", "maybe", "no"]} defaultValue="maybe" />
          </div>
          <Textarea name="packagingReaction" label="Packaging reaction" />
          <Button>Save checkpoint</Button>
        </form>
      ) : null}
    </div>
  );
}

function JournalForm({
  cancelEdit,
  entry,
  products,
  saveJournal,
}: {
  cancelEdit: () => void;
  entry: ContentJournalEntry | null;
  products: Product[];
  saveJournal: (formData: FormData) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(entry?.id ?? null);
  const mediaOnly = entry?.mediaCaptured.split(". Link: ")[0] ?? "";
  const mediaLink = entry?.mediaCaptured.split(". Link: ")[1] ?? "";

  return (
    <FormPanel ref={editorRef} title={entry ? "Edit Journey entry" : "New Journey entry"} icon={<NotebookPen size={18} />}>
      {entry ? (
        <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">
          Editing: {productName(entry.productId, products)}: {entry.postIdeas || "uncategorized"}
        </p>
      ) : null}
      <form action={saveJournal} className="grid gap-3" key={entry?.id ?? "new-journal"}>
        <input name="id" type="hidden" value={entry?.id ?? ""} />
        <ProductSelect includeNoProductOption products={products} selectedProductId={entry?.productId} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input name="entryDate" label="Capture date" type="date" defaultValue={entry?.entryDate ?? getToday()} ref={fieldRef} />
          <JourneyTypeSelect selectedType={entry?.entryType} />
          <Select name="contentAngle" label="Best use" options={["product proof", "behind the scenes", "packaging test", "tasting feedback", "lesson learned", "launch teaser", "not content-worthy"]} defaultValue={entry?.postIdeas ?? "product proof"} />
        </div>
        <Textarea name="whatWasMade" label="Moment captured" placeholder="Example: Brownies V2 cooling and cutting test. One clean top shot, one slicing clip, one texture close-up." defaultValue={entry?.whatWasMade} />
        <MediaChecklist selectedMedia={mediaOnly} />
        <Input name="mediaLink" label="Media folder/link (optional)" placeholder="Google Drive folder, phone album name, or local folder path" defaultValue={mediaLink} helper="Only add this if the files are already organized somewhere." />
        <Textarea name="lessonLearned" label="Useful note for content or product" placeholder="Example: The pull-apart texture looked strong on video, but the box shot looked messy." defaultValue={entry?.lessonLearned} />
        <Textarea name="nextAction" label="Next content action" placeholder="Example: Turn texture clip into reel; reshoot packaging with cleaner liner; skip posting this batch." defaultValue={entry?.nextAction} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{entry ? "Update Journey entry" : "Save Journey entry"}</Button>
          {entry ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
    </FormPanel>
  );
}

function ContentJournalGuide() {
  return (
    <Panel title="Keep It Low Friction" icon={<NotebookPen size={18} />}>
      <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
        <p>Save only the evidence that helps future content. No caption writing here unless the idea is obvious.</p>
        <ul className="space-y-2">
          <li><strong>Capture:</strong> proof, process, packaging, reaction, final product.</li>
          <li><strong>Decide:</strong> usable, reshoot, or not content-worthy.</li>
          <li><strong>Next:</strong> one clear action for the next post or product test.</li>
        </ul>
      </div>
    </Panel>
  );
}

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f2ea] px-4 text-[#211713]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Aly & Shin</p>
        <h1 className="mt-2 text-2xl font-semibold">Loading Product Lab</h1>
        <p className="mt-2 text-sm text-[#6f5a4c]">Connecting to Supabase.</p>
      </div>
    </main>
  );
}

function LoginScreen({
  message,
  signIn,
}: {
  message: string;
  signIn: (formData: FormData) => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f2ea] px-4 text-[#211713]">
      <section className="w-full max-w-md rounded-lg border border-[#e1d4c4] bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Aly & Shin</p>
        <h1 className="mt-2 text-2xl font-semibold">Product Lab Login</h1>
        <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">
          Private workspace for product proof, costing, tasting, and content notes.
        </p>
        <form action={signIn} className="mt-6 grid gap-4">
          <Input label="Email" name="email" type="email" required />
          <Input label="Password" name="password" type="password" required />
          <Button>Sign in</Button>
        </form>
        {message ? <p className="mt-4 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]">{message}</p> : null}
      </section>
    </main>
  );
}

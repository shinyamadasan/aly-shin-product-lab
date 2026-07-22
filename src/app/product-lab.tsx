"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Beaker,
  BookOpenText,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FlaskConical,
  NotebookPen,
  PackageCheck,
  ShieldAlert,
  Sparkles,
  Star,
} from "lucide-react";
import { products, readinessRules, recentJournal } from "@/lib/sample-data";
import { getProductPriority, getProductStats, getReadinessScore } from "@/lib/readiness";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { ContentJournalEntry, CostingEntry, CostingSummary, ProductBatch, SupplyEntry, TastingFeedback } from "@/lib/product-lab-types";
import { Button, FormPanel, Input, MessageBox, MetricCard, Panel, SecondaryButton, Select, StatusPill, Tag, Textarea } from "@/components/ui";
import { emptyState, storageKey, today, type LabState, type LabView } from "@/lib/lab-state";
import { AppShell } from "@/components/app-shell";
import { MediaChecklist, ProductSelect, productName } from "@/components/product-controls";
import { RecentEntries } from "@/components/recent-entries";
import { getCostingTotals } from "@/lib/costing";

export default function ProductLab({ view = "dashboard" }: { view?: LabView }) {
  const [labState, setLabState] = useState<LabState>(() => {
    if (typeof window === "undefined") {
      return emptyState;
    }

    const saved = window.localStorage.getItem(storageKey);
    return saved ? { ...emptyState, ...(JSON.parse(saved) as LabState) } : emptyState;
  });
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "bad" | "info">("info");
  const [isSuppliesTableMissing, setIsSuppliesTableMissing] = useState(false);
  const [editingBatch, setEditingBatch] = useState<ProductBatch | null>(null);
  const [editingCosting, setEditingCosting] = useState<CostingSummary | null>(null);
  const [editingSupply, setEditingSupply] = useState<SupplyEntry | null>(null);
  const [editingTasting, setEditingTasting] = useState<TastingFeedback | null>(null);
  const [editingJournal, setEditingJournal] = useState<ContentJournalEntry | null>(null);

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

    const [batchResult, costingEntryResult, costingResult, supplyResult, tastingResult, journalResult] = await Promise.all([
      supabase.from("product_batches").select("*").order("created_at", { ascending: false }),
      supabase.from("costing_entries").select("*").order("created_at", { ascending: false }),
      supabase.from("costing_summaries").select("*").order("created_at", { ascending: false }),
      supabase.from("supply_entries").select("*").order("created_at", { ascending: false }),
      supabase.from("tasting_feedback").select("*").order("created_at", { ascending: false }),
      supabase.from("content_journal").select("*").order("created_at", { ascending: false }),
    ]);

    const supplyMissing = supplyResult.error?.message.includes("supply_entries");
    setIsSuppliesTableMissing(Boolean(supplyMissing));
    if (batchResult.error || costingEntryResult.error || costingResult.error || (!supplyMissing && supplyResult.error) || tastingResult.error || journalResult.error) {
      const error =
        batchResult.error?.message ||
        costingEntryResult.error?.message ||
        costingResult.error?.message ||
        supplyResult.error?.message ||
        tastingResult.error?.message ||
        journalResult.error?.message;
      setMessage(`Could not load Supabase data: ${error}`);
      setMessageTone("bad");
      return;
    }

    setLabState({
      batches: (batchResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        batchVersion: row.batch_version,
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
      costingEntries: (costingEntryResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
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
        ingredientCost: Number(row.ingredient_cost ?? 0),
        packagingCost: Number(row.packaging_cost ?? 0),
        laborEstimate: Number(row.labor_estimate ?? 0),
        waterCost: Number(row.water_cost ?? row.utilities_estimate ?? 0),
        gasCost: Number(row.gas_cost ?? 0),
        ovenElectricCost: Number(row.oven_electric_cost ?? 0),
        refrigerationCost: Number(row.refrigeration_cost ?? 0),
        coffeeEquipmentCost: Number(row.coffee_equipment_cost ?? 0),
        wasteAllowance: Number(row.waste_allowance ?? 0),
        suggestedPrice: Number(row.suggested_price ?? 0),
        notes: row.notes ?? "",
      })),
      supplies: supplyMissing ? [] : (supplyResult.data ?? []).map((row) => ({
        id: row.id,
        ingredientName: row.ingredient_name,
        brandName: row.brand_name ?? "",
        supplierName: row.supplier_name,
        purchaseDate: row.purchase_date,
        packQuantity: Number(row.pack_quantity ?? 0),
        unit: row.unit ?? "",
        totalCost: Number(row.total_cost ?? 0),
        qualityRating: Number(row.quality_rating ?? 0),
        notes: row.notes ?? "",
      })),
      tastings: (tastingResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        tasterName: row.taster_name,
        rating: row.rating ?? 0,
        liked: row.liked ?? "",
        improve: row.improve ?? "",
        wouldBuy: row.would_buy,
        willingToPay: Number(row.willing_to_pay ?? 0),
        wouldReorder: row.would_reorder,
        packagingReaction: row.packaging_reaction ?? "",
      })),
      journal: (journalResult.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        entryDate: row.entry_date,
        whatWasMade: row.what_was_made ?? "",
        mediaCaptured: row.media_captured ?? "",
        lessonLearned: row.lesson_learned ?? "",
        postIdeas: row.post_ideas ?? "",
        nextAction: row.next_action ?? "",
      })),
    });
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
    const launchCandidates = products.filter((product) => {
      const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings);
      return readiness.percent >= 100;
    }).length;

    return {
      productCount: products.length,
      launchCandidates,
      needsProof: products.filter((product) => getProductStats(product, labState.batches, labState.costings, labState.tastings).proofBatches === 0).length,
      tastingEntries: labState.tastings.length,
    };
  }, [labState]);

  async function saveBatch(formData: FormData) {
    const batchId = String(formData.get("id") || "");
    const batch: ProductBatch = {
      id: batchId || crypto.randomUUID(),
      productId: String(formData.get("productId")),
      batchVersion: String(formData.get("batchVersion") || "V1"),
      dateMade: String(formData.get("dateMade") || today),
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
      };
      const query = batchId
        ? supabase.from("product_batches").update(payload).eq("id", batchId)
        : supabase.from("product_batches").insert(payload);
      const { error } = await query;
      setMessage(error ? `Batch save failed: ${error.message}` : batchId ? "Batch updated." : "Batch saved.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        setEditingBatch(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      batches: batchId ? current.batches.map((item) => (item.id === batchId ? batch : item)) : [batch, ...current.batches],
    }));
    setEditingBatch(null);
    setMessage(batchId ? "Batch updated locally." : "Batch saved locally.");
    setMessageTone("good");
  }

  async function deleteBatch(batchId: string) {
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

  async function saveCosting(formData: FormData) {
    const costingId = String(formData.get("id") || "");
    const productId = String(formData.get("productId"));
    const ingredientRowIds = String(formData.get("ingredientRowIds") || "")
      .split(",")
      .filter(Boolean);
    const utilityRowIds = String(formData.get("utilityRowIds") || "")
      .split(",")
      .filter(Boolean);
    const ingredientRows: CostingEntry[] = ingredientRowIds
      .map((rowId) => {
        const brandName = String(formData.get(`ingredientBrand-${rowId}`) || "").trim();
        return {
          id: String(formData.get(`ingredientId-${rowId}`) || crypto.randomUUID()),
          productId,
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
    const utilityNotes = utilityRows.length
      ? `Utilities: ${utilityRows.map((row) => `${row.name || "Unnamed"} ${row.cost}${row.note ? ` (${row.note})` : ""}`).join("; ")}`
      : "";
    const yieldNotes = Number(formData.get("costingYield") || 0) > 0 ? `Costing yield: ${Number(formData.get("costingYield") || 0)}` : "";
    const baseNotes = getCostingBaseNotes(String(formData.get("notes") || "").trim());
    const costing: CostingSummary = {
      id: costingId || crypto.randomUUID(),
      productId,
      ingredientCost,
      packagingCost: Number(formData.get("packagingCost") || 0),
      laborEstimate: Number(formData.get("laborEstimate") || 0),
      waterCost: utilityBuckets.waterCost,
      gasCost: utilityBuckets.gasCost,
      ovenElectricCost: utilityBuckets.ovenElectricCost,
      refrigerationCost: utilityBuckets.refrigerationCost,
      coffeeEquipmentCost: utilityBuckets.coffeeEquipmentCost,
      wasteAllowance: Number(formData.get("wasteAllowance") || 0),
      suggestedPrice: Number(formData.get("suggestedPrice") || 0),
      notes: [baseNotes, yieldNotes, utilityNotes].filter(Boolean).join("\n"),
    };
    if (supabase && session) {
      const { error: deleteError } = await supabase.from("costing_entries").delete().eq("product_id", productId);
      if (deleteError) {
        setMessage(`Costing save failed: ${deleteError.message}`);
        setMessageTone("bad");
        return;
      }

      if (ingredientRows.length > 0) {
        const { error: ingredientError } = await supabase.from("costing_entries").insert(
          ingredientRows.map((row) => ({
            product_id: row.productId,
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

      const payload = {
        product_id: costing.productId,
        ingredient_cost: costing.ingredientCost,
        packaging_cost: costing.packagingCost,
        labor_estimate: costing.laborEstimate,
        utilities_estimate:
          costing.waterCost +
          costing.gasCost +
          costing.ovenElectricCost +
          costing.refrigerationCost +
          costing.coffeeEquipmentCost,
        waste_allowance: costing.wasteAllowance,
        suggested_price: costing.suggestedPrice,
        notes: costing.notes,
      };
      const query = costingId
        ? supabase.from("costing_summaries").update(payload).eq("id", costingId)
        : supabase.from("costing_summaries").insert(payload);
      const { error } = await query;
      setMessage(error ? `Costing save failed: ${error.message}` : costingId ? "Costing updated." : "Costing saved.");
      setMessageTone(error ? "bad" : "good");
      if (!error) {
        setEditingCosting(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      costingEntries: [...ingredientRows, ...current.costingEntries.filter((entry) => entry.productId !== productId)],
      costings: costingId ? current.costings.map((entry) => (entry.id === costingId ? costing : entry)) : [costing, ...current.costings.filter((entry) => entry.productId !== productId)],
    }));
    setEditingCosting(null);
    setMessage(costingId ? "Costing updated locally." : "Costing saved locally.");
    setMessageTone("good");
  }

  async function deleteCosting(costing: CostingSummary) {
    if (supabase && session) {
      const { error: entryError } = await supabase.from("costing_entries").delete().eq("product_id", costing.productId);
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
    setLabState((current) => ({
      ...current,
      costingEntries: current.costingEntries.filter((entry) => entry.productId !== costing.productId),
      costings: current.costings.filter((entry) => entry.id !== costing.id),
    }));
    if (editingCosting?.id === costing.id) {
      setEditingCosting(null);
    }
    setMessage("Costing deleted locally.");
    setMessageTone("good");
  }

  async function saveSupply(formData: FormData) {
    const supplyId = String(formData.get("id") || "");
    const supply: SupplyEntry = {
      id: supplyId || crypto.randomUUID(),
      ingredientName: String(formData.get("ingredientName") || "").trim(),
      brandName: String(formData.get("brandName") || "").trim(),
      supplierName: String(formData.get("supplierName") || "").trim(),
      purchaseDate: String(formData.get("purchaseDate") || today),
      packQuantity: Number(formData.get("packQuantity") || 0),
      unit: String(formData.get("unit") || "").trim(),
      totalCost: Number(formData.get("totalCost") || 0),
      qualityRating: Number(formData.get("qualityRating") || 0),
      notes: String(formData.get("notes") || "").trim(),
    };

    if (supabase && session) {
      const payload = {
        ingredient_name: supply.ingredientName,
        brand_name: supply.brandName,
        supplier_name: supply.supplierName,
        purchase_date: supply.purchaseDate,
        pack_quantity: supply.packQuantity,
        unit: supply.unit,
        total_cost: supply.totalCost,
        quality_rating: supply.qualityRating,
        notes: supply.notes,
      };
      const query = supplyId
        ? supabase.from("supply_entries").update(payload).eq("id", supplyId)
        : supabase.from("supply_entries").insert(payload);
      const { error } = await query;
      setMessage(error ? `Supply save failed. Run the latest supplies SQL first if this is your first time: ${error.message}` : "Supply saved.");
      setMessageTone(error ? "bad" : "good");
      setIsSuppliesTableMissing(Boolean(error?.message.includes("supply_entries") || error?.message.includes("brand_name")));
      if (!error) {
        setEditingSupply(null);
        await loadSupabaseData();
      }
      return;
    }

    setLabState((current) => ({
      ...current,
      supplies: supplyId ? current.supplies.map((entry) => (entry.id === supplyId ? supply : entry)) : [supply, ...current.supplies],
    }));
    setEditingSupply(null);
    setMessage("Supply saved locally.");
    setMessageTone("good");
  }

  async function deleteSupply(supplyId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("supply_entries").delete().eq("id", supplyId);
      setMessage(error ? `Supply delete failed: ${error.message}` : "Supply deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingSupply?.id === supplyId) {
        setEditingSupply(null);
      }
      await loadSupabaseData();
      return;
    }

    setLabState((current) => ({ ...current, supplies: current.supplies.filter((entry) => entry.id !== supplyId) }));
    if (editingSupply?.id === supplyId) {
      setEditingSupply(null);
    }
    setMessage("Supply deleted locally.");
    setMessageTone("good");
  }

  async function saveTasting(formData: FormData) {
    const tastingId = String(formData.get("id") || "");
    const tasting: TastingFeedback = {
      id: tastingId || crypto.randomUUID(),
      productId: String(formData.get("productId")),
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
      if (!error) {
        setEditingTasting(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({
      ...current,
      tastings: tastingId ? current.tastings.map((entry) => (entry.id === tastingId ? tasting : entry)) : [tasting, ...current.tastings],
    }));
    setEditingTasting(null);
    setMessage(tastingId ? "Feedback updated locally." : "Feedback saved locally.");
    setMessageTone("good");
  }

  async function deleteTasting(tastingId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("tasting_feedback").delete().eq("id", tastingId);
      setMessage(error ? `Feedback delete failed: ${error.message}` : "Feedback deleted.");
      setMessageTone(error ? "bad" : "good");
      if (!error && editingTasting?.id === tastingId) {
        setEditingTasting(null);
      }
      await loadSupabaseData();
      return;
    }
    setLabState((current) => ({ ...current, tastings: current.tastings.filter((entry) => entry.id !== tastingId) }));
    if (editingTasting?.id === tastingId) {
      setEditingTasting(null);
    }
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
      productId: String(formData.get("productId")),
      entryDate: String(formData.get("entryDate") || today),
      whatWasMade: String(formData.get("whatWasMade") || ""),
      mediaCaptured: mediaLink ? `${mediaCaptured}. Link: ${mediaLink}` : mediaCaptured,
      lessonLearned: String(formData.get("lessonLearned") || ""),
      postIdeas: contentAngle,
      nextAction: String(formData.get("nextAction") || ""),
    };
    if (supabase && session) {
      const payload = {
        product_id: entry.productId,
        entry_date: entry.entryDate,
        what_was_made: entry.whatWasMade,
        media_captured: entry.mediaCaptured,
        lesson_learned: entry.lessonLearned,
        post_ideas: entry.postIdeas,
        next_action: entry.nextAction,
      };
      const query = journalId
        ? supabase.from("content_journal").update(payload).eq("id", journalId)
        : supabase.from("content_journal").insert(payload);
      const { error } = await query;
      setMessage(error ? `Journal save failed: ${error.message}` : journalId ? "Journal updated." : "Journal saved.");
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
    setMessage(journalId ? "Journal updated locally." : "Journal saved locally.");
    setMessageTone("good");
  }

  async function deleteJournal(journalId: string) {
    if (supabase && session) {
      const { error } = await supabase.from("content_journal").delete().eq("id", journalId);
      setMessage(error ? `Journal delete failed: ${error.message}` : "Journal deleted.");
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
    setMessage("Journal deleted locally.");
    setMessageTone("good");
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
              <DecisionSidebar />
            </section>
          ) : null}

          {view === "product-detail" ? <ProductDetailPage labState={labState} /> : null}

          {view === "proof-day" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="proof-day-mode">
              <BatchForm batch={editingBatch} batches={labState.batches} cancelEdit={() => setEditingBatch(null)} saveBatch={saveBatch} supplies={labState.supplies} />
              <div className="space-y-5">
                <ProofDayModeGuide />
                <JournalForm cancelEdit={() => setEditingJournal(null)} entry={editingJournal} saveJournal={saveJournal} />
              </div>
            </section>
          ) : null}

          {view === "batches" ? (
            <BatchHistoryPage batch={editingBatch} cancelEdit={() => setEditingBatch(null)} deleteBatch={deleteBatch} editBatch={setEditingBatch} labState={labState} saveBatch={saveBatch} />
          ) : null}

          {view === "costing" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="costing">
              <CostingForm batches={labState.batches} cancelEdit={() => setEditingCosting(null)} costing={editingCosting} ingredientEntries={labState.costingEntries} key={editingCosting?.id ?? "new-costing"} message={message} messageTone={messageTone} saveCosting={saveCosting} supplies={labState.supplies} />
              <div className="space-y-5">
                <CostingGuide />
                <RecentEntries deleteCosting={deleteCosting} editCosting={setEditingCosting} labState={labState} only="costing" />
              </div>
            </section>
          ) : null}

          {view === "supplies" ? <SuppliesPage cancelEdit={() => setEditingSupply(null)} deleteSupply={deleteSupply} editSupply={setEditingSupply} isSuppliesTableMissing={isSuppliesTableMissing} labState={labState} saveSupply={saveSupply} supply={editingSupply} /> : null}

          {view === "tasting" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="tasting">
              <TastingForm cancelEdit={() => setEditingTasting(null)} saveTasting={saveTasting} tasting={editingTasting} />
              <RecentEntries deleteTasting={deleteTasting} editTasting={setEditingTasting} labState={labState} only="tasting" />
            </section>
          ) : null}

          {view === "journal" ? (
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]" id="journal">
              <JournalForm cancelEdit={() => setEditingJournal(null)} entry={editingJournal} saveJournal={saveJournal} />
              <div className="space-y-5">
                <ContentJournalGuide />
                <RecentEntries deleteJournal={deleteJournal} editJournal={setEditingJournal} labState={labState} only="journal" />
              </div>
            </section>
          ) : null}

          {view === "admin" ? <ProductAdminPage labState={labState} /> : null}

          {view === "launch" ? <LaunchOfferBuilder labState={labState} /> : null}

          {view === "content-studio" ? <ContentStudio labState={labState} /> : null}

          {view === "guide" ? <OperatingGuide /> : null}
    </AppShell>
  );
}

type BatchFormulaRow = {
  brand: string;
  ingredient: string;
  previousQuantity?: number;
  quantity: number;
  unit: string;
  change: string;
  rowId: string;
};

function buildBatchIngredientsNotes(formData: FormData) {
  const rowIds = String(formData.get("batchIngredientRowIds") || "")
    .split(",")
    .filter(Boolean);
  const rows = rowIds
    .map((rowId) => ({
      brand: String(formData.get(`batchBrand-${rowId}`) || "").trim(),
      ingredient: String(formData.get(`batchIngredient-${rowId}`) || "").trim(),
      quantity: Number(formData.get(`batchQuantity-${rowId}`) || 0),
      unit: String(formData.get(`batchUnit-${rowId}`) || "").trim(),
      change: String(formData.get(`batchChange-${rowId}`) || "").trim(),
    }))
    .filter((row) => row.brand || row.ingredient || row.quantity > 0 || row.change);

  return JSON.stringify(rows);
}

function parseBatchIngredients(notes: string): BatchFormulaRow[] {
  if (!notes) {
    return [];
  }

  try {
    const parsed = JSON.parse(notes) as Array<Omit<BatchFormulaRow, "rowId">>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((row) => ({ ...row, brand: row.brand ?? "", rowId: crypto.randomUUID() }));
  } catch {
    return [];
  }
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
    return [{ brand: "", change: "", ingredient: "", previousQuantity: undefined, quantity: 0, rowId: crypto.randomUUID(), unit: "" }];
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
    .map((row) => `${row.brand ? `${row.brand.trim()} ` : ""}${row.ingredient.trim()} - ${row.quantity || ""}${row.unit ? ` ${row.unit}` : ""}${row.change ? ` - ${row.change}` : ""}`.trim())
    .join("\n");
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

function ProductDetailPage({ labState }: { labState: LabState }) {
  const [selectedProductId, setSelectedProductId] = useState(products[0].id);
  const product = products.find((item) => item.id === selectedProductId) ?? products[0];
  const batches = labState.batches.filter((batch) => batch.productId === product.id);
  const latestBatch = batches[0];
  const costing = labState.costings.find((entry) => entry.productId === product.id);
  const tastings = labState.tastings.filter((entry) => entry.productId === product.id);
  const journal = labState.journal.filter((entry) => entry.productId === product.id);
  const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings);
  const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings);
  const averageRating = stats.averageRating ? stats.averageRating.toFixed(1) : "None";
  const costingTotals = costing ? getCostingTotals(costing) : null;

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        <div className="border-b border-[#eaded2] p-5">
          <label className="grid max-w-sm gap-1 text-sm font-medium">
            Product
            <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
              {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <h3 className="mt-4 text-2xl font-semibold">{product.name}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#6f5a4c]">{product.description}</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<FlaskConical size={20} />} label="Batches" value={batches.length} detail={latestBatch ? latestBatch.launchDecision : "No proof yet"} />
          <MetricCard icon={<Sparkles size={20} />} label="Batch cost" value={costingTotals ? Math.round(costingTotals.totalBatchCost) : 0} detail={costing ? "PHP total" : "No costing"} />
          <MetricCard icon={<Star size={20} />} label="Tastings" value={tastings.length} detail={`Avg: ${averageRating}`} />
          <MetricCard icon={<NotebookPen size={20} />} label="Content" value={journal.length} detail="Journal entries" />
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

function OperatingGuide() {
  const dailyFlow = [
    { title: "1. Record the kitchen test", page: "/proof-day", detail: "Use Proof Day every time a product is made. Select the product, adjust the auto-filled formula, record timing, sellable yield, issues, freshness, packaging behavior, and the next test only." },
    { title: "2. Capture useful content", page: "/proof-day", detail: "Use the content journal only when real media or a real lesson exists. Log texture close-ups, process clips, packaging photos, reactions, content angle, and next action." },
    { title: "3. Review the experiment history", page: "/batches", detail: "Use Batches after the kitchen work. Compare formulas, see automatic ingredient adjustments, review what failed, and decide whether to retest, pause, launch, or remove." },
    { title: "4. Add tasting feedback", page: "/tasting", detail: "Use Tasting when someone tries the product. Record rating, what they liked, what should improve, willingness to pay, reorder signal, and packaging reaction." },
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
            <p><strong>Your wife:</strong> Proof Day, Tasting, Content Journal.</p>
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
  );
}

function BatchHistoryPage({
  batch,
  cancelEdit,
  deleteBatch,
  editBatch,
  labState,
  saveBatch,
}: {
  batch: ProductBatch | null;
  cancelEdit: () => void;
  deleteBatch: (batchId: string) => void;
  editBatch: (batch: ProductBatch) => void;
  labState: LabState;
  saveBatch: (formData: FormData) => void;
}) {
  const [copiedBatchId, setCopiedBatchId] = useState("");

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
      ["Product", "Batch", "Date", "Decision", "Formula", "Taste notes", "Texture notes", "Issue", "Next test", "Sellable", "Rejects"],
      labState.batches.map((batch) => [
        productName(batch.productId),
        batch.batchVersion,
        batch.dateMade,
        batch.launchDecision,
        formatBatchFormula(parseBatchIngredients(batch.ingredientsNotes)),
        batch.tasteNotes,
        batch.textureNotes,
        batch.wentWrong,
        batch.improveNext,
        batch.usablePieces,
        batch.imperfectPieces,
      ]),
    );
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        {batch ? (
          <div className="border-b border-[#eaded2] p-5">
            <BatchForm batch={batch} batches={labState.batches} cancelEdit={cancelEdit} saveBatch={saveBatch} supplies={labState.supplies} />
          </div>
        ) : null}
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Experiment History</p>
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="text-xl font-semibold">Proof batch records</h3>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("proof-batches-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadBatches} type="button">Download CSV</button>
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Review formulas, adjustments, issues, and next tests. Create new experiments from Proof Day.</p>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {labState.batches.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No proof batches yet.</p> : null}
          {labState.batches.map((batch) => {
            const formula = parseBatchIngredients(batch.ingredientsNotes);
            return (
              <article className="p-5" key={batch.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="font-semibold">{productName(batch.productId)} {batch.batchVersion}</h4>
                    <p className="mt-1 text-sm text-[#6f5a4c]">{batch.dateMade} / {batch.launchDecision}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="text-sm font-semibold text-[#8f5632] underline" onClick={() => copyFormula(batch.id, formula)} type="button">{copiedBatchId === batch.id ? "Copied" : "Copy formula"}</button>
                    <button className="text-sm font-semibold text-[#8f5632] underline" onClick={() => editBatch(batch)} type="button">Edit</button>
                    <button className="text-sm font-semibold text-[#8a3827] underline" onClick={() => window.confirm(`Delete ${batch.batchVersion}?`) ? deleteBatch(batch.id) : undefined} type="button">Delete</button>
                  </div>
                </div>
                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  <DetailCard title="Formula" lines={formula.length ? formula.map((row) => `${row.brand ? `${row.brand} ` : ""}${row.ingredient || "Ingredient"}: ${row.quantity || ""}${row.unit ? ` ${row.unit}` : ""}${row.change ? ` / ${row.change}` : ""}`) : ["No formula rows saved"]} />
                  <DetailCard title="Learning" lines={[batch.tasteNotes || "No process/quality notes", batch.wentWrong ? `Issue: ${batch.wentWrong}` : "Issue: none logged", batch.improveNext ? `Next: ${batch.improveNext}` : "Next: not set"]} />
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <Panel title="Page Split" icon={<ClipboardCheck size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          <p><strong>Proof Day:</strong> record today&apos;s live experiment.</p>
          <p><strong>Batches:</strong> review and compare past experiments.</p>
          <a className="inline-flex rounded-md bg-[#8f5632] px-3 py-2 text-sm font-semibold text-white" href="/proof-day">Start Proof Day</a>
        </div>
      </Panel>
      <ProofBatchesPrintReport batches={labState.batches} />
    </section>
  );
}

function ProofBatchesPrintReport({ batches }: { batches: ProductBatch[] }) {
  return (
    <div className="print-report" id="proof-batches-print-report">
      <h1>Aly & Shin Proof Batch Records</h1>
      <p>Generated {today}</p>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch</th>
            <th>Date</th>
            <th>Formula</th>
            <th>Yield</th>
            <th>Decision</th>
            <th>Learning / Next Test</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>{productName(batch.productId)}</td>
              <td>{batch.batchVersion}</td>
              <td>{batch.dateMade}</td>
              <td>{formatBatchFormula(parseBatchIngredients(batch.ingredientsNotes)) || "No formula saved"}</td>
              <td>{batch.usablePieces} sellable / {batch.imperfectPieces} reject</td>
              <td>{batch.launchDecision}</td>
              <td>{[batch.tasteNotes, batch.textureNotes, batch.wentWrong ? `Issue: ${batch.wentWrong}` : "", batch.improveNext ? `Next: ${batch.improveNext}` : ""].filter(Boolean).join(" / ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductAdminPage({ labState }: { labState: LabState }) {
  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Backend Control</p>
          <h3 className="mt-1 text-xl font-semibold">Product Admin Board</h3>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Use this as your backend checklist for what each product needs before your wife spends more kitchen time.</p>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {products.map((product) => {
            const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings);
            return (
              <article className="grid gap-3 p-4 md:grid-cols-[1fr_240px]" key={product.id}>
                <div>
                  <h4 className="font-semibold">{product.name}</h4>
                  <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">{product.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill label={`${stats.proofBatches} proof`} done={stats.proofBatches > 0} />
                    <StatusPill label="Costing" done={stats.costingDone} />
                    <StatusPill label={`${stats.tastingCount}/5 tastings`} done={stats.tastingCount >= 5} />
                  </div>
                </div>
                <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm leading-6 text-[#5f4a3d]">
                  <p className="font-semibold">Admin decision</p>
                  <p>{stats.proofBatches === 0 ? "Needs first proof batch" : `Latest: ${stats.latestDecision}`}</p>
                  <p>{product.category === "Coffee" ? "Keep as later add-on test." : "Eligible for proof cycle."}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <Panel title="Admin Limits" icon={<ShieldAlert size={18} />}>
        <p className="text-sm leading-6 text-[#5f4a3d]">This board controls priorities for now. Full product create/edit should be a dedicated database change later, because products are still seeded from the app and Supabase together.</p>
      </Panel>
    </section>
  );
}

function LaunchOfferBuilder({ labState }: { labState: LabState }) {
  const candidates = products.filter((product) => {
    const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings);
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

function ContentStudio({ labState }: { labState: LabState }) {
  const latest = labState.journal[0];
  const product = latest ? productName(latest.productId) : "Selected product";
  const angle = latest?.postIdeas || "product proof";
  const lesson = latest?.lessonLearned || "Show what changed and what you learned from the test.";
  const next = latest?.nextAction || "Pick the strongest clip and draft one simple post.";

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="rounded-lg border border-[#e1d4c4] bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Repurpose Real Proof</p>
        <h3 className="mt-1 text-xl font-semibold">Content Draft From Latest Journal</h3>
        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <DetailCard title="Reel" lines={[`Hook: Testing ${product} again today.`, `Middle: ${lesson}`, `Close: ${next}`]} />
          <DetailCard title="Carousel" lines={[`Slide 1: ${product} test`, `Slide 2: What changed`, `Slide 3: Texture/result`, `Slide 4: What we fix next`, `Slide 5: Follow the proof process`]} />
          <DetailCard title="Caption" lines={[`Today we tested ${product}.`, lesson, `Next step: ${next}`, `Angle: ${angle}`]} />
        </div>
      </div>
      <Panel title="Source Journal" icon={<NotebookPen size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          {latest ? (
            <>
              <p>{product}</p>
              <p>Captured: {latest.mediaCaptured || "No media logged"}</p>
              <p>Use: {angle}</p>
            </>
          ) : (
            <p>No journal entries yet. Save a real content capture first.</p>
          )}
        </div>
      </Panel>
    </section>
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
  return (
    <>
      <section className="grid gap-4 xl:grid-cols-[1.5fr_0.8fr]" id="dashboard">
            <div className="rounded-lg border border-[#e1d4c4] bg-[#fffaf3] p-5">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard icon={<Beaker size={20} />} label="Products" value={metrics.productCount} detail="Starter candidates" />
                <MetricCard icon={<ClipboardCheck size={20} />} label="Launch-ready" value={metrics.launchCandidates} detail="Target after proof" />
                <MetricCard icon={<FlaskConical size={20} />} label="Need batches" value={metrics.needsProof} detail="Proof logs missing" />
                <MetricCard icon={<Star size={20} />} label="Taste entries" value={metrics.tastingEntries} detail="Target: 5 each" />
              </div>
              <div className="mt-5 rounded-md border border-[#e7d8c9] bg-white p-4">
                <div className="flex items-start gap-3">
                  <span className="rounded-md bg-[#f8ead9] p-2 text-[#9a5b2f]"><CalendarDays size={20} /></span>
                  <div>
                    <h3 className="font-semibold">Next Product Proof Day</h3>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-[#6f5a4c]">
                      Test Brownies, Revel Bars, and Cookies. Capture yield, timing, texture, packaging behavior, freshness after 12/24 hours, and willingness to pay.
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

          <section className="grid gap-5 xl:grid-cols-[1fr_360px]" id="products">
            <ProductReadiness labState={labState} />
            <DecisionSidebar />
          </section>
    </>
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
        {products.map((product) => {
          const readiness = getReadinessScore(product, labState.batches, labState.costings, labState.tastings);
          const stats = getProductStats(product, labState.batches, labState.costings, labState.tastings);
          return (
            <article className="grid gap-4 p-4 md:grid-cols-[92px_1fr_170px]" key={product.id}>
              <div className="relative h-24 overflow-hidden rounded-md border border-[#eaded2] bg-[#fbf2e8]"><Image src={product.image} alt={product.name} fill sizes="92px" className="object-contain p-2" /></div>
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

function DecisionSidebar() {
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
      <Panel title="Journal signals" icon={<NotebookPen size={18} />}>
        <div className="space-y-3">
          {recentJournal.map((entry) => (
            <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3" key={entry.title}>
              <p className="text-sm font-semibold">{entry.title}</p>
              <p className="mt-1 text-sm leading-5 text-[#6f5a4c]">{entry.detail}</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{entry.status}</p>
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
  cancelEdit,
  saveBatch,
  supplies,
}: {
  batch: ProductBatch | null;
  batches: ProductBatch[];
  cancelEdit: () => void;
  saveBatch: (formData: FormData) => void;
  supplies: SupplyEntry[];
}) {
  const [selectedProductId, setSelectedProductId] = useState(batch?.productId ?? products[0].id);
  const [formulaRows, setFormulaRows] = useState<BatchFormulaRow[]>(() => {
    const savedRows = parseBatchIngredients(batch?.ingredientsNotes ?? "");
    if (savedRows.length > 0) {
      return savedRows;
    }

    return buildFormulaRowsFromPreviousBatch(batches.find((item) => item.productId === (batch?.productId ?? products[0].id)));
  });

  function addFormulaRow() {
    setFormulaRows((current) => [...current, { brand: "", change: "", ingredient: "", previousQuantity: 0, quantity: 0, rowId: crypto.randomUUID(), unit: "" }]);
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

  return (
    <FormPanel title={batch ? "Edit proof batch" : "Proof batch record"} icon={<FlaskConical size={18} />}>
      <form action={saveBatch} className="grid gap-3" key={batch?.id ?? "new-batch"}>
        <input name="id" type="hidden" value={batch?.id ?? ""} />
        <input name="batchIngredientRowIds" type="hidden" value={formulaRows.map((row) => row.rowId).join(",")} />
        <ProductSelect onChange={(event) => changeProduct(event.target.value)} value={selectedProductId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="batchVersion" label="Batch/version tested" placeholder="Brownies V2 - less sugar" defaultValue={batch?.batchVersion} helper="Name the exact test, not just V1/V2." />
          <Input name="dateMade" label="Date made" type="date" defaultValue={batch?.dateMade ?? today} />
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
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Record the actual formula. Use change notes for +10g sugar, less butter, new cocoa, etc.</p>
            </div>
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addFormulaRow} type="button">Add ingredient</button>
          </div>
          <div className="mt-3 grid gap-3">
            {formulaRows.map((row, index) => (
              <div className="grid gap-2 lg:grid-cols-[minmax(220px,2fr)_100px_80px_150px_170px_70px]" key={row.rowId}>
                <SupplyItemPicker row={row} rowIndex={index} supplies={supplies} updateFormulaRow={updateFormulaRow} />
                <Input name={`batchQuantity-${row.rowId}`} label="Qty" type="number" step="0.01" placeholder="50" value={row.quantity || ""} onChange={(event) => updateFormulaRow(row.rowId, { quantity: Number(event.target.value || 0) })} />
                <Input name={`batchUnit-${row.rowId}`} label="Unit used" placeholder="g / ml / tbsp" value={row.unit} onChange={(event) => updateFormulaRow(row.rowId, { unit: event.target.value })} />
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
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{batch ? "Update batch" : "Save batch"}</Button>
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

type CostingIngredientRow = CostingEntry & { brandName: string; isManualCost?: boolean; rowId: string };
type CostingUtilityRow = { cost: number; name: string; note: string; rowId: string };

function normalizeSupplyText(value: string) {
  return value.trim().toLowerCase();
}

function normalizeUnit(value: string) {
  const unit = normalizeSupplyText(value);
  if (unit === "gram" || unit === "grams") {
    return "g";
  }
  if (unit === "milliliter" || unit === "milliliters") {
    return "ml";
  }
  if (unit === "tablespoon" || unit === "tablespoons") {
    return "tbsp";
  }
  if (unit === "teaspoon" || unit === "teaspoons") {
    return "tsp";
  }
  return unit;
}

function getMatchingSupplies(supplies: SupplyEntry[], brandName: string, ingredientName: string, unit: string) {
  return supplies
    .filter((supply) => {
      const brandMatches = !brandName.trim() || normalizeSupplyText(supply.brandName) === normalizeSupplyText(brandName);
      const ingredientMatches = normalizeSupplyText(supply.ingredientName) === normalizeSupplyText(ingredientName);
      const exactUnitMatch = normalizeUnit(supply.unit) === normalizeUnit(unit);
      const convertibleUnitMatch = Boolean(getConvertedQuantityForSupply(1, unit, supply));
      return brandMatches && ingredientMatches && (exactUnitMatch || convertibleUnitMatch);
    })
    .sort((a, b) => {
      const aUnitCost = a.packQuantity > 0 ? a.totalCost / a.packQuantity : Number.MAX_SAFE_INTEGER;
      const bUnitCost = b.packQuantity > 0 ? b.totalCost / b.packQuantity : Number.MAX_SAFE_INTEGER;
      return aUnitCost - bUnitCost;
    });
}

function getSupplyUsedCost(supply: SupplyEntry, quantityUsed: number, usedUnit = supply.unit) {
  const convertedQuantity = getConvertedQuantityForSupply(quantityUsed, usedUnit, supply);
  if (supply.packQuantity <= 0 || supply.totalCost <= 0 || convertedQuantity <= 0) {
    return 0;
  }

  return (supply.totalCost / supply.packQuantity) * convertedQuantity;
}

const volumeUnitMl: Record<string, number> = {
  cup: 240,
  cups: 240,
  tbsp: 15,
  tablespoon: 15,
  tablespoons: 15,
  tsp: 5,
  teaspoon: 5,
  teaspoons: 5,
};

const gramPerMlByIngredient: Array<{ keywords: string[]; gramPerMl: number }> = [
  { keywords: ["water", "milk", "coffee", "espresso", "cream"], gramPerMl: 1 },
  { keywords: ["oil"], gramPerMl: 0.92 },
  { keywords: ["honey", "syrup"], gramPerMl: 1.4 },
  { keywords: ["butter"], gramPerMl: 0.96 },
  { keywords: ["sugar"], gramPerMl: 0.85 },
  { keywords: ["flour"], gramPerMl: 0.53 },
  { keywords: ["cocoa", "cacao"], gramPerMl: 0.42 },
  { keywords: ["powder"], gramPerMl: 0.5 },
  { keywords: ["salt"], gramPerMl: 1.2 },
];

function getIngredientGramPerMl(ingredientName: string) {
  const normalizedIngredient = normalizeSupplyText(ingredientName);
  return gramPerMlByIngredient.find((entry) => entry.keywords.some((keyword) => normalizedIngredient.includes(keyword)))?.gramPerMl;
}

function getConvertedQuantity(quantity: number, fromUnit: string, toUnit: string, ingredientName: string) {
  const normalizedFrom = normalizeUnit(fromUnit);
  const normalizedTo = normalizeUnit(toUnit);
  if (!quantity || normalizedFrom === normalizedTo) {
    return quantity;
  }

  const ml = volumeUnitMl[normalizedFrom] ? quantity * volumeUnitMl[normalizedFrom] : 0;
  if (!ml) {
    return 0;
  }

  if (normalizedTo === "ml") {
    return ml;
  }

  if (normalizedTo === "g" || normalizedTo === "gram" || normalizedTo === "grams") {
    const gramPerMl = getIngredientGramPerMl(ingredientName);
    return gramPerMl ? ml * gramPerMl : 0;
  }

  return 0;
}

function getConvertedQuantityForSupply(quantity: number, usedUnit: string, supply: SupplyEntry) {
  return getConvertedQuantity(quantity, usedUnit, supply.unit, supply.ingredientName);
}

function getConversionLabel(quantity: number, fromUnit: string, supply: SupplyEntry) {
  const convertedQuantity = getConvertedQuantityForSupply(quantity, fromUnit, supply);
  if (!convertedQuantity || normalizeUnit(fromUnit) === normalizeUnit(supply.unit)) {
    return "";
  }

  const isEstimate = normalizeUnit(supply.unit) !== "ml";
  return `${quantity}${fromUnit} = ${convertedQuantity.toFixed(1)}${supply.unit}${isEstimate ? " estimate" : ""}`;
}

function getSupplyLabel(supply: Pick<SupplyEntry, "brandName" | "ingredientName" | "unit">) {
  return `${supply.brandName ? `${supply.brandName} - ` : ""}${supply.ingredientName}${supply.unit ? ` (${supply.unit})` : ""}`;
}

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
    .filter((line) => !line.startsWith("Costing yield:") && !line.startsWith("Utilities:"))
    .join("\n")
    .trim();
}

function getUniqueSupplyValues(supplies: SupplyEntry[], key: "brandName" | "ingredientName" | "supplierName" | "unit") {
  return Array.from(new Set(supplies.map((supply) => supply[key].trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
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
  row,
  rowIndex,
  supplies,
  updateFormulaRow,
}: {
  row: BatchFormulaRow;
  rowIndex: number;
  supplies: SupplyEntry[];
  updateFormulaRow: (rowId: string, changes: Partial<BatchFormulaRow>) => void;
}) {
  const [inputValue, setInputValue] = useState(row.ingredient ? getSupplyLabel({ brandName: row.brand, ingredientName: row.ingredient, unit: row.unit }) : "");
  const [isOpen, setIsOpen] = useState(false);
  const filteredSupplies = supplies.filter((supply) => getSupplyLabel(supply).toLowerCase().includes(inputValue.trim().toLowerCase()));

  return (
    <label className="relative grid gap-1 text-sm font-medium">
      Supply item {rowIndex + 1}
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
          aria-label="Show saved supply items"
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
          {filteredSupplies.length === 0 ? <p className="px-3 py-2 text-sm font-normal text-[#6f5a4c]">No saved supply match. Add it in Supplies first, or type a custom ingredient.</p> : null}
          {filteredSupplies.map((supply) => (
            <button
              className="block w-full px-3 py-2 text-left text-sm font-normal text-[#211713] hover:bg-[#fffaf3]"
              key={supply.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const label = getSupplyLabel(supply);
                setInputValue(label);
                updateFormulaRow(row.rowId, { brand: supply.brandName, ingredient: supply.ingredientName, unit: supply.unit });
                setIsOpen(false);
              }}
              type="button"
            >
              <span className="font-semibold">{getSupplyLabel(supply)}</span>
              <span className="ml-2 text-[#6f5a4c]">{supply.supplierName || "Supplier not set"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}

function SuppliesPage({
  cancelEdit,
  deleteSupply,
  editSupply,
  isSuppliesTableMissing,
  labState,
  saveSupply,
  supply,
}: {
  cancelEdit: () => void;
  deleteSupply: (supplyId: string) => void;
  editSupply: (supply: SupplyEntry) => void;
  isSuppliesTableMissing: boolean;
  labState: LabState;
  saveSupply: (formData: FormData) => void;
  supply: SupplyEntry | null;
}) {
  const brandOptions = getUniqueSupplyValues(labState.supplies, "brandName");
  const supplierOptions = getUniqueSupplyValues(labState.supplies, "supplierName");
  const unitOptions = getUniqueSupplyValues(labState.supplies, "unit");

  function downloadSupplies() {
    downloadCsv(
      "supplies.csv",
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
      <FormPanel title={supply ? "Edit supply purchase" : "Log supply purchase"} icon={<PackageCheck size={18} />}>
        {isSuppliesTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Supplies database fields are not ready yet. Run the latest <strong>supabase-add-supplies.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveSupply} className="grid gap-3" key={supply?.id ?? "new-supply"}>
          <input name="id" type="hidden" value={supply?.id ?? ""} />
          <div className="grid gap-3 sm:grid-cols-3">
            <SupplyValuePicker name="brandName" label="Brand" options={brandOptions} placeholder="Beryl's / Callebaut / local" value={supply?.brandName} />
            <Input name="ingredientName" label="Ingredient" placeholder="Cocoa powder" defaultValue={supply?.ingredientName} />
            <SupplyValuePicker name="supplierName" label="Supplier" options={supplierOptions} placeholder="SM / Shopee / local baking store" value={supply?.supplierName} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Input name="purchaseDate" label="Date bought" type="date" defaultValue={supply?.purchaseDate ?? today} />
            <Input name="packQuantity" label="Pack qty" type="number" step="0.01" placeholder="1000" defaultValue={supply?.packQuantity || undefined} />
            <SupplyValuePicker name="unit" label="Unit" options={unitOptions} placeholder="g" value={supply?.unit} />
            <Input name="totalCost" label="Total PHP" type="number" step="0.01" placeholder="100" defaultValue={supply?.totalCost || undefined} />
          </div>
          <Input name="qualityRating" label="Quality rating 1-5" type="number" min="1" max="5" defaultValue={supply?.qualityRating || undefined} helper="Rate the supply itself: aroma, texture, consistency, taste impact, packaging condition." />
          <Textarea name="notes" label="Supplier and quality notes" placeholder="Darker color, stronger aroma, cheaper but clumpy, better for brownies, delivery took 3 days." defaultValue={supply?.notes} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button>{supply ? "Update supply" : "Save supply"}</Button>
            {supply ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
          </div>
        </form>
      </FormPanel>

      <Panel title="Supplier Comparison" icon={<Sparkles size={18} />}>
        <div className="space-y-3 text-sm leading-6 text-[#5f4a3d]">
          <p>Use this page only for actual purchases. Costing should use this information later, but this page is the source of truth for supplier prices and quality.</p>
          <p><strong>Example:</strong> Cocoa powder, Supplier A, 1000g, PHP 100, quality 4/5.</p>
        </div>
      </Panel>

      <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Purchase Log</p>
          <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="text-xl font-semibold">Saved supplies</h3>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("supplies-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadSupplies} type="button">Download CSV</button>
            </div>
          </div>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {labState.supplies.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No supplies logged yet.</p> : null}
          {labState.supplies.map((supply) => {
            const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;
            const supplierLabel = supply.supplierName || "Supplier not set";
            const brandLabel = supply.brandName || "Brand not set";
            return (
              <article className="grid gap-4 p-5 lg:grid-cols-[1fr_160px_160px_120px_70px]" key={supply.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone="green">{brandLabel}</Tag>
                    <Tag tone="warm">{supplierLabel}</Tag>
                  </div>
                  <h4 className="mt-2 font-semibold">{supply.ingredientName}</h4>
                  <p className="mt-1 text-sm text-[#6f5a4c]">Bought {supply.purchaseDate}</p>
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
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Delete ${supply.ingredientName} from ${supplierLabel}?`) ? deleteSupply(supply.id) : undefined} type="button">Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <SuppliesPrintReport supplies={labState.supplies} />
    </section>
  );
}

function SuppliesPrintReport({ supplies }: { supplies: SupplyEntry[] }) {
  return (
    <div className="print-report" id="supplies-print-report">
      <h1>Aly & Shin Supply Purchase Log</h1>
      <p>Generated {today}</p>
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

function CostingForm({
  cancelEdit,
  batches,
  costing,
  ingredientEntries,
  message,
  messageTone,
  saveCosting,
  supplies,
}: {
  batches: ProductBatch[];
  cancelEdit: () => void;
  costing: CostingSummary | null;
  ingredientEntries: CostingEntry[];
  message: string;
  messageTone: "good" | "bad" | "info";
  saveCosting: (formData: FormData) => void;
  supplies: SupplyEntry[];
}) {
  const [selectedProductId, setSelectedProductId] = useState(costing?.productId ?? products[0].id);
  const savedIngredients = costing ? ingredientEntries.filter((entry) => entry.productId === costing.productId) : [];
  const [ingredientRows, setIngredientRows] = useState<CostingIngredientRow[]>(() =>
    savedIngredients.length > 0
      ? savedIngredients.map((entry) => ({ ...entry, rowId: entry.id }))
      : [{ brandName: "", cost: 0, id: "", ingredientName: "", productId: costing?.productId ?? products[0].id, quantityUsed: 0, rowId: crypto.randomUUID(), supplierNote: "", unit: "" }],
  );
  const [utilityRows, setUtilityRows] = useState<CostingUtilityRow[]>(() => {
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
  const [packagingCost, setPackagingCost] = useState(costing?.packagingCost ?? 0);
  const [laborEstimate, setLaborEstimate] = useState(costing?.laborEstimate ?? 0);
  const [wasteAllowance, setWasteAllowance] = useState(costing?.wasteAllowance ?? 0);
  const [suggestedPrice, setSuggestedPrice] = useState(costing?.suggestedPrice ?? 0);
  const [localMessage, setLocalMessage] = useState("");
  const [localMessageTone, setLocalMessageTone] = useState<"good" | "bad" | "info">("info");

  const utilityTotal = utilityRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const latestBatch = batches.find((batch) => batch.productId === selectedProductId);
  const latestFormula = parseBatchIngredients(latestBatch?.ingredientsNotes ?? "");
  const ingredientTotal = ingredientRows.reduce((total, row) => total + Number(row.cost || 0), 0);
  const [costingYield, setCostingYield] = useState(() => getCostingYieldFromNotes(costing?.notes ?? "") || latestBatch?.usablePieces || 0);
  const totalBatchCost = ingredientTotal + utilityTotal + packagingCost + laborEstimate + wasteAllowance;
  const costPerPiece = costingYield > 0 ? totalBatchCost / costingYield : 0;
  const grossProfit = suggestedPrice - costPerPiece;
  const margin = suggestedPrice > 0 ? (grossProfit / suggestedPrice) * 100 : 0;
  const appliedMessage = message || localMessage;
  const appliedMessageTone = message ? messageTone : localMessageTone;

  function changeProduct(productId: string) {
    setSelectedProductId(productId);
    const productLatestBatch = batches.find((batch) => batch.productId === productId);
    setCostingYield(getCostingYieldFromNotes(costing?.notes ?? "") || productLatestBatch?.usablePieces || 0);
  }

  function addIngredientRow() {
    setIngredientRows((current) => [...current, { brandName: "", cost: 0, id: "", ingredientName: "", productId: selectedProductId, quantityUsed: 0, rowId: crypto.randomUUID(), supplierNote: "", unit: "" }]);
    setLocalMessage("Ingredient row added.");
    setLocalMessageTone("good");
  }

  function addUtilityRow() {
    setUtilityRows((current) => [...current, { cost: 0, name: "", note: "", rowId: crypto.randomUUID() }]);
    setLocalMessage("Utility row added.");
    setLocalMessageTone("good");
  }

  function importLatestFormula() {
    const rows = latestFormula
      .filter((row) => row.ingredient.trim())
      .map((row) => ({
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
      setLocalMessage("Latest proof formula imported. Matching supply prices were applied automatically.");
      setLocalMessageTone("good");
    } else {
      setLocalMessage("No proof formula found for this product yet.");
      setLocalMessageTone("bad");
    }
  }

  function getBestSupplyMatch(row: CostingIngredientRow) {
    return getMatchingSupplies(supplies, row.brandName, row.ingredientName, row.unit)[0];
  }

  function getAutoCostedRow(row: CostingIngredientRow) {
    if (row.isManualCost) {
      return row;
    }

    const supply = getBestSupplyMatch(row);
    if (!supply) {
      return row;
    }

    return {
      ...row,
      brandName: supply.brandName,
      cost: Number(getSupplyUsedCost(supply, row.quantityUsed, row.unit).toFixed(2)),
      ingredientName: supply.ingredientName,
      supplierNote: [supply.supplierName, supply.purchaseDate, `quality ${supply.qualityRating || 0}/5`, getConversionLabel(row.quantityUsed, row.unit, supply)].filter(Boolean).join(" / "),
    };
  }

  function autoCostRows(rows: CostingIngredientRow[]) {
    return rows.map((row) => getAutoCostedRow(row));
  }

  function updateIngredientRow(rowId: string, changes: Partial<CostingIngredientRow>, isManualCost = false) {
    setIngredientRows((current) =>
      autoCostRows(current.map((row) => (row.rowId === rowId ? { ...row, ...changes, isManualCost } : row))),
    );
  }

  function downloadCosting() {
    const filename = `${productName(selectedProductId).toLowerCase().replaceAll(" ", "-")}-costing.csv`;
    downloadCsv(
      filename,
      ["Section", "Name", "Qty", "Unit", "PHP", "Note"],
      [
        ...ingredientRows.map((row) => ["Ingredient", `${row.brandName ? `${row.brandName} ` : ""}${row.ingredientName}`, row.quantityUsed, row.unit, row.cost, row.supplierNote]),
        ["Packaging", "Packaging", "", "", packagingCost, ""],
        ["Labor", "Labor", "", "", laborEstimate, "Pay for mixing, baking/cooking, cooling, packing, cleaning, and admin time"],
        ...utilityRows.map((row) => ["Utility", row.name, "", "", row.cost, row.note]),
        ["Waste", "Waste allowance", "", "", wasteAllowance, ""],
        ["Summary", "Batch cost", "", "", totalBatchCost, ""],
        ["Summary", "Yield", costingYield, "pieces/units", "", ""],
        ["Summary", "Cost per piece", "", "", costPerPiece, ""],
        ["Summary", "Selling price", "", "", suggestedPrice, ""],
        ["Summary", "Gross profit per unit", "", "", grossProfit, ""],
        ["Summary", "Margin %", "", "", margin.toFixed(1), ""],
      ],
    );
  }

  return (
    <FormPanel title={costing ? "Edit costing" : "Save costing summary"} icon={<Sparkles size={18} />}>
      {appliedMessage ? <MessageBox message={appliedMessage} tone={appliedMessageTone} /> : null}
      <form action={saveCosting} className="grid gap-3">
        <input name="id" type="hidden" value={costing?.id ?? ""} />
        <input name="ingredientRowIds" type="hidden" value={ingredientRows.map((row) => row.rowId).join(",")} />
        <input name="utilityRowIds" type="hidden" value={utilityRows.map((row) => row.rowId).join(",")} />
        <ProductSelect onChange={(event) => changeProduct(event.target.value)} value={selectedProductId} />
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Ingredients used</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Cost the quantity used in this product batch. Use Supplies for purchase prices and supplier comparison.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d] disabled:cursor-not-allowed disabled:opacity-50" disabled={latestFormula.length === 0} onClick={importLatestFormula} type="button">Use latest proof formula</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => printPage("costing-print-report")} type="button">Print</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={downloadCosting} type="button">Download CSV</button>
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={addIngredientRow} type="button">Add ingredient</button>
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            {ingredientRows.map((row, index) => {
              const matches = getMatchingSupplies(supplies, row.brandName, row.ingredientName, row.unit).slice(0, 3);
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
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a5b2f]">Matching supplies</p>
                    {matches.length === 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">No exact supply match yet. Brand, ingredient, and unit must match Supplies.</p> : null}
                    <div className="mt-2 grid gap-2">
                      {matches.map((supply) => {
                        const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;
                        const usedCost = getSupplyUsedCost(supply, row.quantityUsed, row.unit);
                        const conversionLabel = getConversionLabel(row.quantityUsed, row.unit, supply);
                        return (
                          <div className="grid gap-2 rounded-md border border-[#ead9c8] bg-white p-2 text-sm md:grid-cols-[1fr_140px]" key={supply.id}>
                            <div className="text-[#5f4a3d]">
                              <p className="font-semibold">{getSupplyLabel(supply)}</p>
                              <p>{supply.supplierName}</p>
                              <p>PHP {unitCost.toFixed(4)} / {supply.unit || "unit"} · quality {supply.qualityRating || 0}/5</p>
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="packagingCost" label="Packaging cost per batch/unit" type="number" step="0.01" value={packagingCost || ""} onChange={(event) => setPackagingCost(Number(event.target.value || 0))} helper="Boxes, cups, bottles, labels, stickers, bags, seals." />
          <Input name="suggestedPrice" label="Selling price per piece/unit" type="number" step="0.01" value={suggestedPrice || ""} onChange={(event) => setSuggestedPrice(Number(event.target.value || 0))} helper="The price you may charge per piece, box, or bottle." />
        </div>
        <Input
          name="costingYield"
          label="Batch yield used for costing"
          type="number"
          step="0.01"
          value={costingYield || ""}
          onChange={(event) => setCostingYield(Number(event.target.value || 0))}
          helper={latestBatch?.usablePieces ? `Latest proof batch has ${latestBatch.usablePieces} sellable pieces. Override only if this costing uses a different yield.` : "Enter expected sellable pieces/units before trusting cost per piece."}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input name="laborEstimate" label="Labor cost / owner's wage" type="number" step="0.01" value={laborEstimate || ""} onChange={(event) => setLaborEstimate(Number(event.target.value || 0))} helper="Not profit. This pays the person doing the work, even if that person is you." />
          <Input name="wasteAllowance" label="Waste allowance" type="number" step="0.01" value={wasteAllowance || ""} onChange={(event) => setWasteAllowance(Number(event.target.value || 0))} helper="Allowance for broken pieces, test cuts, spills, rejects, or spoilage." />
        </div>
        <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Utilities / equipment used</p>
              <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">Add only what matters for this batch: oven, water, gas, refrigeration, ice, espresso machine, delivery cooling.</p>
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
        <div className="grid gap-3 rounded-md border border-[#ead9c8] bg-[#231813] p-4 text-[#fff8ef] sm:grid-cols-4">
          <CostingMetric label="Batch cost" value={`PHP ${totalBatchCost.toFixed(2)}`} />
          <CostingMetric label="Cost per piece" value={costingYield > 0 ? `PHP ${costPerPiece.toFixed(2)}` : "Need yield"} />
          <CostingMetric label="Gross profit/unit" value={costingYield > 0 ? `PHP ${grossProfit.toFixed(2)}` : "Need yield"} />
          <CostingMetric label="Margin" value={costingYield > 0 ? `${margin.toFixed(1)}%` : "Need yield"} />
        </div>
        <div className="grid gap-2 rounded-md border border-[#ead9c8] bg-white p-3 text-sm text-[#5f4a3d] sm:grid-cols-5">
          <CostingBreakdown label="Ingredients" value={ingredientTotal} />
          <CostingBreakdown label="Packaging" value={packagingCost} />
          <CostingBreakdown label="Labor" value={laborEstimate} />
          <CostingBreakdown label="Utilities" value={utilityTotal} />
          <CostingBreakdown label="Waste" value={wasteAllowance} />
        </div>
        <Textarea name="notes" label="Costing notes" placeholder="What is estimated? What supplier price needs confirmation? Is this per batch, per piece, or per box?" defaultValue={getCostingBaseNotes(costing?.notes ?? "")} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{costing ? "Update costing" : "Save costing"}</Button>
          {costing ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
      <CostingPrintReport
        costPerPiece={costPerPiece}
        costingYield={costingYield}
        grossProfit={grossProfit}
        ingredientRows={ingredientRows}
        laborEstimate={laborEstimate}
        margin={margin}
        packagingCost={packagingCost}
        productId={selectedProductId}
        suggestedPrice={suggestedPrice}
        totalBatchCost={totalBatchCost}
        utilityRows={utilityRows}
        utilityTotal={utilityTotal}
        wasteAllowance={wasteAllowance}
      />
    </FormPanel>
  );
}

function CostingPrintReport({
  costPerPiece,
  costingYield,
  grossProfit,
  ingredientRows,
  laborEstimate,
  margin,
  packagingCost,
  productId,
  suggestedPrice,
  totalBatchCost,
  utilityRows,
  utilityTotal,
  wasteAllowance,
}: {
  costPerPiece: number;
  costingYield: number;
  grossProfit: number;
  ingredientRows: CostingIngredientRow[];
  laborEstimate: number;
  margin: number;
  packagingCost: number;
  productId: string;
  suggestedPrice: number;
  totalBatchCost: number;
  utilityRows: CostingUtilityRow[];
  utilityTotal: number;
  wasteAllowance: number;
}) {
  return (
    <div className="print-report" id="costing-print-report">
      <h1>Aly & Shin Costing Sheet</h1>
      <p>{productName(productId)} / Generated {today}</p>

      <h2>Summary</h2>
      <table>
        <tbody>
          <tr><th>Batch cost</th><td>PHP {totalBatchCost.toFixed(2)}</td><th>Yield</th><td>{costingYield || 0} pieces/units</td></tr>
          <tr><th>Cost per piece</th><td>PHP {costPerPiece.toFixed(2)}</td><th>Selling price</th><td>PHP {suggestedPrice.toFixed(2)}</td></tr>
          <tr><th>Gross profit/unit</th><td>PHP {grossProfit.toFixed(2)}</td><th>Margin</th><td>{margin.toFixed(1)}%</td></tr>
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
        </tbody>
      </table>

      <h2>Batch Costs</h2>
      <table>
        <tbody>
          <tr><th>Packaging</th><td>PHP {packagingCost.toFixed(2)}</td></tr>
          <tr><th>Labor / owner&apos;s wage</th><td>PHP {laborEstimate.toFixed(2)}</td></tr>
          <tr><th>Utilities total</th><td>PHP {utilityTotal.toFixed(2)}</td></tr>
          {utilityRows.map((row) => <tr key={row.rowId}><th>{row.name || "Utility"}</th><td>PHP {row.cost.toFixed(2)} {row.note ? `/ ${row.note}` : ""}</td></tr>)}
          <tr><th>Waste allowance</th><td>PHP {wasteAllowance.toFixed(2)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function CostingMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#ddb778]">{label}</p>
      <p className="mt-2 text-lg font-semibold">{value}</p>
    </div>
  );
}

function CostingBreakdown({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{label}</p>
      <p className="mt-1 font-semibold">PHP {Number(value || 0).toFixed(2)}</p>
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

function TastingForm({
  cancelEdit,
  saveTasting,
  tasting,
}: {
  cancelEdit: () => void;
  saveTasting: (formData: FormData) => void;
  tasting: TastingFeedback | null;
}) {
  return (
    <FormPanel title={tasting ? "Edit tasting feedback" : "Add tasting feedback"} icon={<BookOpenText size={18} />}>
      <form action={saveTasting} className="grid gap-3" key={tasting?.id ?? "new-tasting"}>
        <input name="id" type="hidden" value={tasting?.id ?? ""} />
        <ProductSelect selectedProductId={tasting?.productId} />
        <div className="grid gap-3 sm:grid-cols-2"><Input name="tasterName" label="Taster name" defaultValue={tasting?.tasterName} /><Input name="rating" label="Rating 1-10" type="number" min="1" max="10" defaultValue={tasting?.rating || undefined} /></div>
        <Textarea name="liked" label="What they liked" defaultValue={tasting?.liked} />
        <Textarea name="improve" label="What should improve" defaultValue={tasting?.improve} />
        <div className="grid gap-3 sm:grid-cols-3"><Select name="wouldBuy" label="Would buy" options={["yes", "maybe", "no"]} defaultValue={tasting?.wouldBuy ?? "maybe"} /><Input name="willingToPay" label="Willing to pay" type="number" defaultValue={tasting?.willingToPay || undefined} /><Select name="wouldReorder" label="Would reorder" options={["yes", "maybe", "no"]} defaultValue={tasting?.wouldReorder ?? "maybe"} /></div>
        <Textarea name="packagingReaction" label="Packaging reaction" defaultValue={tasting?.packagingReaction} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{tasting ? "Update feedback" : "Save feedback"}</Button>
          {tasting ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
        </div>
      </form>
    </FormPanel>
  );
}

function JournalForm({
  cancelEdit,
  entry,
  saveJournal,
}: {
  cancelEdit: () => void;
  entry: ContentJournalEntry | null;
  saveJournal: (formData: FormData) => void;
}) {
  const mediaOnly = entry?.mediaCaptured.split(". Link: ")[0] ?? "";
  const mediaLink = entry?.mediaCaptured.split(". Link: ")[1] ?? "";

  return (
    <FormPanel title={entry ? "Edit content capture" : "Content capture record"} icon={<NotebookPen size={18} />}>
      <form action={saveJournal} className="grid gap-3" key={entry?.id ?? "new-journal"}>
        <input name="id" type="hidden" value={entry?.id ?? ""} />
        <ProductSelect selectedProductId={entry?.productId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="entryDate" label="Capture date" type="date" defaultValue={entry?.entryDate ?? today} />
          <Select name="contentAngle" label="Best use" options={["product proof", "behind the scenes", "packaging test", "tasting feedback", "lesson learned", "launch teaser", "not content-worthy"]} defaultValue={entry?.postIdeas ?? "product proof"} />
        </div>
        <Textarea name="whatWasMade" label="Moment captured" placeholder="Example: Brownies V2 cooling and cutting test. One clean top shot, one slicing clip, one texture close-up." defaultValue={entry?.whatWasMade} />
        <MediaChecklist selectedMedia={mediaOnly} />
        <Input name="mediaLink" label="Media folder/link (optional)" placeholder="Google Drive folder, phone album name, or local folder path" defaultValue={mediaLink} helper="Only add this if the files are already organized somewhere." />
        <Textarea name="lessonLearned" label="Useful note for content or product" placeholder="Example: The pull-apart texture looked strong on video, but the box shot looked messy." defaultValue={entry?.lessonLearned} />
        <Textarea name="nextAction" label="Next content action" placeholder="Example: Turn texture clip into reel; reshoot packaging with cleaner liner; skip posting this batch." defaultValue={entry?.nextAction} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{entry ? "Update journal" : "Save journal"}</Button>
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

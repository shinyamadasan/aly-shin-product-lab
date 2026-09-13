import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertPreviewApproved,
  batchRpcArgs,
  buildCountPreview,
  reconciliationSnapshotMismatches,
  type CountPreview,
  type PhysicalCountIntent,
} from "../inventory-operator/core.ts";
import { authenticatedProductLabClient, ProductLabError } from "./auth.ts";
import { createProductLabReadService, type ProductLabReadService } from "./read-service.ts";

export type InventoryCountApplyRow = {
  ingredient_id: string;
  ingredient_name: string;
  base_unit: string;
  quantity_before: number | string;
  quantity_after: number | string;
  quantity_change: number | string;
  transaction_id: string;
  inventory_reconciled_at: string;
  cost_reconciled_at: string | null;
};

export type InventoryCountApplyResult = {
  operation_id: string;
  payload_hash: string;
  applied_reconciliation_events: number;
  rows: InventoryCountApplyRow[];
};

export type InventoryCountApplied = InventoryCountApplyResult & {
  status: "applied_unverified";
  preview_id: string;
};

export type InventoryCountVerificationRow = {
  ingredient: string;
  before: number;
  after: number;
  delta: number;
  unit: string;
  transaction_id: string;
  inventory_reconciled_at: string;
  cost_reconciled_at: string | null;
  cost_certification_effect: "cleared" | "existing_certification_preserved" | "remained_uncertified";
};

export type InventoryCountVerified = {
  status: "verified";
  preview_id: string;
  source: string;
  operation_id: string;
  payload_hash: string;
  rows: number;
  applied_reconciliation_events: number;
  quantity_increased: number;
  quantity_decreased: number;
  exact_recounts_no_quantity_change: number;
  cost_certifications_cleared: number;
  existing_cost_certifications_preserved: number;
  remained_uncertified: number;
  failures: 0;
  reconciliation_rows: InventoryCountVerificationRow[];
};

export type InventoryCountPreviewArtifact = {
  preview: CountPreview;
  apply_result?: InventoryCountApplyResult;
  verified_at?: string;
};

export type InventoryCountArtifactStore = {
  read(previewId: string): Promise<InventoryCountPreviewArtifact>;
  save(artifact: InventoryCountPreviewArtifact): Promise<void>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PREVIEW_DIR = path.join(ROOT, ".inventory-operator", "previews");

function artifactPath(previewDirectory: string, previewId: string): string {
  if (!/^pc_[a-f0-9]{20}$/.test(previewId)) {
    throw new ProductLabError("preview_error", "Invalid preview id");
  }
  return path.join(previewDirectory, `${previewId}.json`);
}

export function createInventoryCountArtifactStore(
  previewDirectory = DEFAULT_PREVIEW_DIR,
): InventoryCountArtifactStore {
  return {
    async read(previewId) {
      try {
        return JSON.parse(await readFile(artifactPath(previewDirectory, previewId), "utf8")) as InventoryCountPreviewArtifact;
      } catch (error) {
        if (error instanceof ProductLabError) throw error;
        throw new ProductLabError(
          "preview_error",
          `Unable to load preview artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async save(artifact) {
      await mkdir(previewDirectory, { recursive: true });
      const target = artifactPath(previewDirectory, artifact.preview.preview_id);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    },
  };
}

function validationError(error: unknown): ProductLabError {
  return error instanceof ProductLabError
    ? error
    : new ProductLabError("preview_error", error instanceof Error ? error.message : String(error));
}

export class InventoryCountService {
  private readonly readService: Pick<ProductLabReadService, "loadState">;
  private readonly authenticatedClient: () => Promise<SupabaseClient>;
  private readonly artifacts: InventoryCountArtifactStore;

  constructor(
    readService: Pick<ProductLabReadService, "loadState">,
    authenticatedClient: () => Promise<SupabaseClient>,
    artifacts: InventoryCountArtifactStore,
  ) {
    this.readService = readService;
    this.authenticatedClient = authenticatedClient;
    this.artifacts = artifacts;
  }

  async preview(intent: PhysicalCountIntent): Promise<CountPreview> {
    const state = await this.readService.loadState();
    const preview = buildCountPreview({ intent, ...state });
    await this.artifacts.save({ preview });
    return preview;
  }

  async apply(previewId: string, approvalCode: string): Promise<InventoryCountApplied> {
    // A fresh client performs auth.getUser again for every apply. Never reuse preview-time auth.
    const client = await this.authenticatedClient();
    const artifact = await this.artifacts.read(previewId);
    try {
      assertPreviewApproved(artifact.preview, approvalCode);
    } catch (error) {
      throw validationError(error);
    }
    const { data, error } = await client.rpc(
      "apply_inventory_physical_count_batch",
      batchRpcArgs(artifact.preview),
    );
    if (error) {
      throw new ProductLabError("apply_failed", `Physical-count batch failed atomically: ${error.message}`);
    }
    const applyResult = data as InventoryCountApplyResult;
    if (!applyResult
      || applyResult.operation_id !== artifact.preview.operation_id
      || applyResult.payload_hash !== artifact.preview.payload_hash) {
      throw new ProductLabError("apply_failed", "Database returned a result for a different operation");
    }
    await this.artifacts.save({ ...artifact, apply_result: applyResult });
    return {
      status: "applied_unverified",
      preview_id: previewId,
      ...applyResult,
    };
  }

  async verify(previewId: string): Promise<InventoryCountVerified> {
    const artifact = await this.artifacts.read(previewId);
    try {
      assertPreviewApproved(artifact.preview, artifact.preview.approval_code);
    } catch (error) {
      throw validationError(error);
    }
    if (!artifact.apply_result) {
      throw new ProductLabError("verification_failed", "No apply result exists for this preview");
    }
    const client = await this.authenticatedClient();
    const ingredientIds = artifact.preview.rows.map((row) => row.canonical_ingredient_id!);
    const transactionIds = artifact.apply_result.rows.map((row) => row.transaction_id);
    const [ingredientsResult, transactionsResult] = await Promise.all([
      client.from("ingredients")
        .select("id,name,current_quantity,base_unit,inventory_reconciled_at,cost_reconciled_at")
        .in("id", ingredientIds),
      client.from("inventory_transactions")
        .select("id,ingredient_id,transaction_type,source_type,quantity_before,quantity_change,quantity_after,reconciliation_snapshot,note")
        .in("id", transactionIds),
    ]);
    if (ingredientsResult.error) {
      throw new ProductLabError("verification_failed", `Verification inventory read failed: ${ingredientsResult.error.message}`);
    }
    if (transactionsResult.error) {
      throw new ProductLabError("verification_failed", `Verification ledger read failed: ${transactionsResult.error.message}`);
    }

    const failures: string[] = [];
    const expectedRows = artifact.preview.rows.length;
    if (artifact.apply_result.applied_reconciliation_events !== expectedRows
      || artifact.apply_result.rows.length !== expectedRows) {
      failures.push("Applied result row count does not match the approved preview");
    }
    if ((ingredientsResult.data ?? []).length !== expectedRows) {
      failures.push("Inventory read-back row count does not match the approved preview");
    }
    if ((transactionsResult.data ?? []).length !== expectedRows) {
      failures.push("Ledger read-back row count does not match the approved preview");
    }

    for (const previewRow of artifact.preview.rows) {
      const ingredient = (ingredientsResult.data ?? []).find((row) => row.id === previewRow.canonical_ingredient_id);
      const applied = artifact.apply_result.rows.find((row) => row.ingredient_id === previewRow.canonical_ingredient_id);
      const transaction = (transactionsResult.data ?? []).find((row) => row.id === applied?.transaction_id);
      if (!ingredient
        || ingredient.name !== previewRow.canonical_ingredient_name
        || Number(ingredient.current_quantity) !== previewRow.normalized_counted_quantity
        || ingredient.base_unit !== previewRow.base_unit) {
        failures.push(`Ingredient read-back mismatch for ${previewRow.canonical_ingredient_name}`);
      }
      if (!applied
        || applied.ingredient_name !== previewRow.canonical_ingredient_name
        || applied.base_unit !== previewRow.base_unit
        || Number(applied.quantity_before) !== previewRow.current_quantity
        || Number(applied.quantity_after) !== previewRow.normalized_counted_quantity
        || Number(applied.quantity_change) !== previewRow.delta) {
        failures.push(`Applied result mismatch for ${previewRow.canonical_ingredient_name}`);
      }
      if (!transaction
        || transaction.ingredient_id !== previewRow.canonical_ingredient_id
        || Number(transaction.quantity_before) !== previewRow.current_quantity
        || Number(transaction.quantity_change) !== previewRow.delta
        || Number(transaction.quantity_after) !== previewRow.normalized_counted_quantity
        || transaction.transaction_type !== "adjustment"
        || transaction.source_type !== "manual") {
        failures.push(`Ledger read-back mismatch for ${previewRow.canonical_ingredient_name}`);
      }
      if (!transaction?.note?.includes(artifact.preview.operation_id)) {
        failures.push(`Reconciliation operation audit mismatch for ${previewRow.canonical_ingredient_name}`);
      }
      const snapshotMismatches = reconciliationSnapshotMismatches(previewRow, transaction?.reconciliation_snapshot);
      if (snapshotMismatches.length > 0) {
        failures.push(`Reconciliation snapshot mismatch for ${previewRow.canonical_ingredient_name}: ${snapshotMismatches.join(", ")}`);
      }
      if ((previewRow.expected_cost_certification_effect === "cleared"
        || previewRow.expected_cost_certification_effect === "remained_uncertified")
        && ingredient?.cost_reconciled_at !== null) {
        failures.push(`Cost certification is unexpectedly present for ${previewRow.canonical_ingredient_name}`);
      }
      if (previewRow.expected_cost_certification_effect === "existing_certification_preserved"
        && ingredient?.cost_reconciled_at !== previewRow.current_cost_reconciled_at) {
        failures.push(`Existing cost certification was not preserved for ${previewRow.canonical_ingredient_name}`);
      }
      if (!ingredient?.inventory_reconciled_at
        || ingredient.inventory_reconciled_at !== applied?.inventory_reconciled_at) {
        failures.push(`Inventory reconciliation timestamp mismatch for ${previewRow.canonical_ingredient_name}`);
      }
    }

    if (failures.length > 0) {
      throw new ProductLabError("verification_failed", `Read-back verification failed:\n${failures.join("\n")}`);
    }

    const reconciliationRows = artifact.apply_result.rows.map((row) => {
      const previewRow = artifact.preview.rows.find((item) => item.canonical_ingredient_id === row.ingredient_id)!;
      const ingredient = (ingredientsResult.data ?? []).find((item) => item.id === row.ingredient_id)!;
      return {
        ingredient: row.ingredient_name,
        before: Number(row.quantity_before),
        after: Number(row.quantity_after),
        delta: Number(row.quantity_change),
        unit: row.base_unit,
        transaction_id: row.transaction_id,
        inventory_reconciled_at: row.inventory_reconciled_at,
        cost_reconciled_at: ingredient.cost_reconciled_at,
        cost_certification_effect: previewRow.expected_cost_certification_effect!,
      };
    });
    const report: InventoryCountVerified = {
      status: "verified",
      preview_id: previewId,
      source: artifact.preview.source.name,
      operation_id: artifact.preview.operation_id,
      payload_hash: artifact.preview.payload_hash,
      rows: reconciliationRows.length,
      applied_reconciliation_events: reconciliationRows.length,
      quantity_increased: reconciliationRows.filter((row) => row.delta > 0).length,
      quantity_decreased: reconciliationRows.filter((row) => row.delta < 0).length,
      exact_recounts_no_quantity_change: reconciliationRows.filter((row) => row.delta === 0).length,
      cost_certifications_cleared: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "cleared").length,
      existing_cost_certifications_preserved: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "existing_certification_preserved").length,
      remained_uncertified: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "remained_uncertified").length,
      failures: 0,
      reconciliation_rows: reconciliationRows,
    };
    await this.artifacts.save({ ...artifact, verified_at: new Date().toISOString() });
    return report;
  }
}

export function createInventoryCountService(
  env: NodeJS.ProcessEnv = process.env,
  previewDirectory = DEFAULT_PREVIEW_DIR,
): InventoryCountService {
  return new InventoryCountService(
    createProductLabReadService(env),
    () => authenticatedProductLabClient(env),
    createInventoryCountArtifactStore(previewDirectory),
  );
}

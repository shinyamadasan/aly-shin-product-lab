// Product Lab MCP -- Daily Bakery Ops V2, Slice 1 Purchases. Owns preview-artifact persistence and
// the preview -> apply -> verify orchestration, mirroring inventory-count-service.ts's V1A
// pattern exactly. The apply bridge writes deterministic purchase_imports/purchase_import_rows
// rows under those tables' EXISTING owner-only RLS (see the migration's header) and then calls the
// existing, unmodified inventory_private.confirm_purchase_import_v2 RPC -- no new RPC, no
// reimplementation of its weighted-average-cost or atomicity guarantees in TypeScript.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertPurchasePreviewApproved,
  buildPurchasePreview,
  deterministicUuid,
  type PurchaseIntent,
  type PurchasePreview,
} from "../purchase-operator/core.ts";
import { authenticatedProductLabClient, ProductLabError } from "./auth.ts";
import {
  createProductLabReadService,
  createProductLabReadServiceForClient,
  type ProductLabReadService,
} from "./read-service.ts";

export type PurchaseApplyRow = {
  ingredient_id: string;
  ingredient_name: string;
  base_unit: string;
  quantity_before: number | string;
  quantity_after: number | string;
  quantity_change: number | string;
  transaction_id: string;
};

export type PurchaseApplyResult = {
  operation_id: string;
  payload_hash: string;
  import_id: string;
  transaction_ids: string[];
  rows: PurchaseApplyRow[];
};

export type PurchaseApplied = PurchaseApplyResult & {
  status: "applied_unverified";
  preview_id: string;
};

export type PurchaseVerificationRow = {
  ingredient: string;
  before: number;
  after: number;
  delta: number;
  unit: string;
  transaction_id: string;
  total_price_added: number;
};

export type PurchaseVerified = {
  status: "verified";
  preview_id: string;
  occasion_id: string;
  operation_id: string;
  payload_hash: string;
  import_id: string;
  ingredients_touched: number;
  total_spent: number;
  failures: 0;
  purchase_rows: PurchaseVerificationRow[];
};

export type PurchasePreviewArtifact = {
  preview: PurchasePreview;
  apply_result?: PurchaseApplyResult;
  verified_at?: string;
};

export type PurchaseArtifactStore = {
  read(previewId: string): Promise<PurchasePreviewArtifact>;
  save(artifact: PurchasePreviewArtifact): Promise<void>;
};

const PREVIEW_ID_PATTERN = /^pu_[a-f0-9]{20}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PREVIEW_DIR = path.join(ROOT, ".purchase-operator", "previews");

function artifactPath(previewDirectory: string, previewId: string): string {
  if (!PREVIEW_ID_PATTERN.test(previewId)) {
    throw new ProductLabError("preview_error", "Invalid preview id");
  }
  return path.join(previewDirectory, `${previewId}.json`);
}

// Local-filesystem preview store for the stdio path -- the purchase sibling of
// createInventoryCountArtifactStore in inventory-count-service.ts. Transient approval state, not a
// ledger; ignored by git (.gitignore already covers .inventory-operator/, extended alongside this
// slice for .purchase-operator/).
export function createPurchaseArtifactStore(previewDirectory = DEFAULT_PREVIEW_DIR): PurchaseArtifactStore {
  return {
    async read(previewId) {
      try {
        return JSON.parse(await readFile(artifactPath(previewDirectory, previewId), "utf8")) as PurchasePreviewArtifact;
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

const PREVIEW_TABLE = "product_lab_mcp_purchase_previews";

// Durable, owner-scoped preview storage -- the purchase sibling of
// createDurableInventoryCountArtifactStore in inventory-count-service.ts, backed by
// public.product_lab_mcp_purchase_previews (see that migration's header for why this is a sibling
// table rather than a reuse of product_lab_mcp_previews). `client` is always a request-scoped,
// already-authenticated Supabase client; RLS -- not this code -- is what makes "owner A cannot
// read/use owner B's preview" true.
export function createDurablePurchaseArtifactStore(client: SupabaseClient): PurchaseArtifactStore {
  return {
    async read(previewId) {
      if (!PREVIEW_ID_PATTERN.test(previewId)) {
        throw new ProductLabError("preview_error", "Invalid preview id");
      }
      const { data, error } = await client
        .from(PREVIEW_TABLE)
        .select("preview,apply_result,verified_at,expires_at")
        .eq("preview_id", previewId)
        .maybeSingle();
      if (error) {
        throw new ProductLabError("preview_error", `Unable to load preview artifact: ${error.message}`);
      }
      if (!data) {
        throw new ProductLabError("preview_error", "Preview not found");
      }
      if (data.expires_at && new Date(data.expires_at as string).getTime() < Date.now()) {
        throw new ProductLabError("preview_error", "Preview has expired; run purchase_preview again");
      }
      return {
        preview: data.preview as PurchasePreview,
        apply_result: (data.apply_result ?? undefined) as PurchaseApplyResult | undefined,
        verified_at: (data.verified_at ?? undefined) as string | undefined,
      };
    },
    async save(artifact) {
      const row = {
        preview_id: artifact.preview.preview_id,
        payload_hash: artifact.preview.payload_hash,
        operation_id: artifact.preview.operation_id,
        preview: artifact.preview,
        apply_result: artifact.apply_result ?? null,
        verified_at: artifact.verified_at ?? null,
      };
      const { error } = await client.from(PREVIEW_TABLE).upsert(row, { onConflict: "owner_id,preview_id" });
      if (error) {
        throw new ProductLabError("preview_error", `Unable to save preview artifact: ${error.message}`);
      }
    },
  };
}

function validationError(error: unknown): ProductLabError {
  return error instanceof ProductLabError
    ? error
    : new ProductLabError("preview_error", error instanceof Error ? error.message : String(error));
}

// One row per distinct ingredient touched by this preview, in the shape confirm_purchase_import_v2
// itself groups by (sum of converted_quantity per ingredient_id) -- computed independently here
// only to describe the expected result for apply()'s summary and verify()'s strict comparison,
// never to recompute cost.
function groupRowsByIngredient(preview: PurchasePreview) {
  const groups = new Map<string, { name: string; unit: string; currentQuantity: number; expectedDelta: number; totalPrice: number }>();
  for (const row of preview.rows) {
    const id = row.canonical_ingredient_id!;
    const existing = groups.get(id);
    if (existing) {
      existing.expectedDelta += row.converted_quantity!;
      existing.totalPrice += row.total_price!;
    } else {
      groups.set(id, {
        name: row.canonical_ingredient_name!,
        unit: row.base_unit!,
        currentQuantity: row.current_quantity!,
        expectedDelta: row.converted_quantity!,
        totalPrice: row.total_price!,
      });
    }
  }
  return groups;
}

export class PurchaseService {
  private readonly readService: Pick<ProductLabReadService, "loadState">;
  private readonly authenticatedClient: () => Promise<SupabaseClient>;
  private readonly artifacts: PurchaseArtifactStore;

  constructor(
    readService: Pick<ProductLabReadService, "loadState">,
    authenticatedClient: () => Promise<SupabaseClient>,
    artifacts: PurchaseArtifactStore,
  ) {
    this.readService = readService;
    this.authenticatedClient = authenticatedClient;
    this.artifacts = artifacts;
  }

  async preview(intent: PurchaseIntent): Promise<PurchasePreview> {
    const state = await this.readService.loadState();
    const preview = buildPurchasePreview({ intent, ...state });
    await this.artifacts.save({ preview });
    return preview;
  }

  async apply(previewId: string, approvalCode: string): Promise<PurchaseApplied> {
    // A fresh client performs auth.getUser again for every apply. Never reuse preview-time auth.
    const client = await this.authenticatedClient();
    const artifact = await this.artifacts.read(previewId);
    const preview = artifact.preview;
    try {
      assertPurchasePreviewApproved(preview, approvalCode);
    } catch (error) {
      throw validationError(error);
    }

    // Both ids are pure functions of the already-approved, immutable preview -- a retried apply
    // (lost response, or a second call after a real success) recomputes the exact same ids, so the
    // insert below and the RPC call are naturally idempotent without any extra stored pointer.
    const importId = deterministicUuid("purchase_import", preview.preview_id);

    // Check-before-insert, not upsert-and-ignore: once confirm_purchase_import_v2 has run once,
    // inventory_private.protect_posted_import's read-only guard rejects ANY further write to this
    // import's rows -- including a row that would merely conflict and be skipped, because Postgres
    // still fires a row's BEFORE INSERT trigger before evaluating ON CONFLICT DO NOTHING. A retried
    // apply must therefore never attempt to (re)insert once the import already exists; it can go
    // straight to the RPC, which is where the real idempotency guarantee (claim_mutation) lives.
    const existingImport = await client.from("purchase_imports").select("id").eq("id", importId).maybeSingle();
    if (existingImport.error) {
      throw new ProductLabError("apply_failed", `Unable to check for an existing purchase import: ${existingImport.error.message}`);
    }
    if (!existingImport.data) {
      const totalValue = preview.rows.reduce((sum, row) => sum + row.total_price!, 0);
      const importInsert = await client.from("purchase_imports").insert({
        id: importId,
        file_name: `mcp-purchase:${preview.occasion_id}`,
        status: "draft",
        row_count: preview.rows.length,
        total_value: totalValue,
      });
      // A unique-violation here means a concurrent apply call for this exact preview already created
      // the row between the check above and this insert -- treat it the same as "already exists" and
      // proceed to the RPC, rather than failing a legitimate concurrent retry.
      if (importInsert.error && importInsert.error.code !== "23505") {
        throw new ProductLabError("apply_failed", `Unable to persist purchase import draft: ${importInsert.error.message}`);
      }
      if (!importInsert.error) {
        const rowInsert = await client.from("purchase_import_rows").insert(
          preview.rows.map((row) => ({
            id: deterministicUuid("purchase_import_row", `${preview.preview_id}:${row.row_number}`),
            import_id: importId,
            row_index: row.row_number - 1,
            raw_item_name: row.raw_name,
            raw_quantity: String(row.entered_quantity),
            raw_unit: row.entered_unit ?? "",
            raw_total_price: String(row.total_price),
            parsed_quantity: row.entered_quantity,
            parsed_total_price: row.total_price,
            ingredient_id: row.canonical_ingredient_id,
            match_method: row.match_type,
            converted_quantity: row.converted_quantity,
            row_status: "matched",
          })),
        );
        if (rowInsert.error) {
          throw new ProductLabError("apply_failed", `Unable to persist purchase import rows: ${rowInsert.error.message}`);
        }
      }
    }

    const { data, error } = await client.rpc("confirm_purchase_import_v2", {
      p_operation_id: preview.operation_id,
      p_import_id: importId,
    });
    if (error) {
      throw new ProductLabError("apply_failed", `Purchase confirmation failed atomically: ${error.message}`);
    }
    const rpcResult = data as { import_id: string; transaction_ids: string[] } | null;
    if (!rpcResult || rpcResult.import_id !== importId) {
      throw new ProductLabError("apply_failed", "Database returned a result for a different operation");
    }

    const groups = groupRowsByIngredient(preview);
    const transactionsResult = await client
      .from("inventory_transactions")
      .select("id,ingredient_id,quantity_before,quantity_change,quantity_after")
      .eq("source_type", "purchase_import")
      .eq("source_id", importId);
    if (transactionsResult.error) {
      throw new ProductLabError("apply_failed", `Unable to read back applied purchase transactions: ${transactionsResult.error.message}`);
    }
    const rows: PurchaseApplyRow[] = [...groups.entries()].map(([ingredientId, group]) => {
      const transaction = (transactionsResult.data ?? []).find((row) => row.ingredient_id === ingredientId);
      if (!transaction) {
        throw new ProductLabError("apply_failed", `Applied purchase is missing its ledger transaction for ${group.name}`);
      }
      return {
        ingredient_id: ingredientId,
        ingredient_name: group.name,
        base_unit: group.unit,
        quantity_before: transaction.quantity_before,
        quantity_after: transaction.quantity_after,
        quantity_change: transaction.quantity_change,
        transaction_id: transaction.id,
      };
    });

    const applyResult: PurchaseApplyResult = {
      operation_id: preview.operation_id,
      payload_hash: preview.payload_hash,
      import_id: importId,
      transaction_ids: rpcResult.transaction_ids,
      rows,
    };
    await this.artifacts.save({ ...artifact, apply_result: applyResult });
    return { status: "applied_unverified", preview_id: previewId, ...applyResult };
  }

  async verify(previewId: string): Promise<PurchaseVerified> {
    const artifact = await this.artifacts.read(previewId);
    try {
      assertPurchasePreviewApproved(artifact.preview, artifact.preview.approval_code);
    } catch (error) {
      throw validationError(error);
    }
    if (!artifact.apply_result) {
      throw new ProductLabError("verification_failed", "No apply result exists for this preview");
    }
    const preview = artifact.preview;
    const importId = artifact.apply_result.import_id;
    const groups = groupRowsByIngredient(preview);
    const ingredientIds = [...groups.keys()];

    const client = await this.authenticatedClient();
    const [ingredientsResult, transactionsResult] = await Promise.all([
      client.from("ingredients").select("id,name,current_quantity,base_unit").in("id", ingredientIds),
      client.from("inventory_transactions")
        .select("id,ingredient_id,transaction_type,quantity_before,quantity_change,quantity_after,source_type,source_id")
        .eq("source_type", "purchase_import")
        .eq("source_id", importId),
    ]);
    if (ingredientsResult.error) {
      throw new ProductLabError("verification_failed", `Verification inventory read failed: ${ingredientsResult.error.message}`);
    }
    if (transactionsResult.error) {
      throw new ProductLabError("verification_failed", `Verification ledger read failed: ${transactionsResult.error.message}`);
    }

    const failures: string[] = [];
    if ((ingredientsResult.data ?? []).length !== ingredientIds.length) {
      failures.push("Inventory read-back row count does not match the approved preview");
    }
    if ((transactionsResult.data ?? []).length !== ingredientIds.length) {
      failures.push("Ledger read-back row count does not match the approved preview");
    }

    const purchaseRows: PurchaseVerificationRow[] = [];
    for (const [ingredientId, group] of groups) {
      const ingredient = (ingredientsResult.data ?? []).find((row) => row.id === ingredientId);
      const transaction = (transactionsResult.data ?? []).find((row) => row.ingredient_id === ingredientId);
      const expectedAfter = group.currentQuantity + group.expectedDelta;
      if (!transaction
        || transaction.transaction_type !== "purchase"
        || transaction.source_type !== "purchase_import"
        || transaction.source_id !== importId
        || Number(transaction.quantity_before) !== group.currentQuantity
        || Number(transaction.quantity_change) !== group.expectedDelta
        || Number(transaction.quantity_after) !== expectedAfter) {
        failures.push(`Ledger read-back mismatch for ${group.name}`);
      }
      if (!ingredient
        || ingredient.name !== group.name
        || ingredient.base_unit !== group.unit
        || Number(ingredient.current_quantity) !== expectedAfter) {
        failures.push(`Ingredient read-back mismatch for ${group.name}`);
      }
      if (transaction) {
        purchaseRows.push({
          ingredient: group.name,
          before: Number(transaction.quantity_before),
          after: Number(transaction.quantity_after),
          delta: Number(transaction.quantity_change),
          unit: group.unit,
          transaction_id: transaction.id,
          total_price_added: group.totalPrice,
        });
      }
    }

    if (failures.length > 0) {
      throw new ProductLabError("verification_failed", `Read-back verification failed:\n${failures.join("\n")}`);
    }

    const report: PurchaseVerified = {
      status: "verified",
      preview_id: previewId,
      occasion_id: preview.occasion_id,
      operation_id: preview.operation_id,
      payload_hash: preview.payload_hash,
      import_id: importId,
      ingredients_touched: purchaseRows.length,
      total_spent: purchaseRows.reduce((sum, row) => sum + row.total_price_added, 0),
      failures: 0,
      purchase_rows: purchaseRows,
    };
    await this.artifacts.save({ ...artifact, verified_at: new Date().toISOString() });
    return report;
  }
}

export function createPurchaseService(
  env: NodeJS.ProcessEnv = process.env,
  previewDirectory = DEFAULT_PREVIEW_DIR,
): PurchaseService {
  return new PurchaseService(
    createProductLabReadService(env),
    () => authenticatedProductLabClient(env),
    createPurchaseArtifactStore(previewDirectory),
  );
}

// Remote-request variant: one already-authenticated owner client backs the read state, the apply/
// verify client, and the durable artifact store for this single HTTP exchange -- mirrors
// inventory-count-service.ts's own createInventoryCountServiceForClient.
export function createPurchaseServiceForClient(client: SupabaseClient): PurchaseService {
  return new PurchaseService(
    createProductLabReadServiceForClient(client),
    () => Promise.resolve(client),
    createDurablePurchaseArtifactStore(client),
  );
}

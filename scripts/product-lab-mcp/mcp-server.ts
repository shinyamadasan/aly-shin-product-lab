import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ProductLabError } from "../product-lab/auth.ts";
import type { InventoryCountService } from "../product-lab/inventory-count-service.ts";
import type { ProductLabReadService } from "../product-lab/read-service.ts";
import { PurchaseDomainError, type PurchaseService } from "./purchase-service.ts";

const nullableText = z.string().nullable();
const inventoryItemSchema = z.object({
  id: z.string(),
  canonical_name: z.string(),
  active: z.boolean(),
  current_quantity: z.number(),
  canonical_unit: z.string(),
  inventory_reconciled_at: nullableText,
  cost_reconciled_at: nullableText,
  average_unit_cost: z.number().nullable(),
});
const candidateSchema = z.object({
  id: z.string(),
  canonical_name: z.string(),
  active: z.boolean(),
  reason: z.enum(["alias", "exact", "normalized", "strong_partial", "shared_token"]),
});
const purchaseEvidenceSchema = z.object({
  date: z.string(),
  supplier_store: z.string(),
  brand: nullableText,
  entered_quantity: z.number(),
  entered_unit: nullableText,
  normalized_quantity: z.number().nullable(),
  total_price: z.number(),
  canonical_unit_cost: z.number().nullable(),
  canonical_unit: z.string(),
  source: z.object({
    supply_entry_id: z.string(),
    inventory_transaction_id: nullableText,
    inventory_source_type: nullableText,
    inventory_source_id: nullableText,
  }),
});
const inventoryContextSchema = z.object({
  id: z.string(),
  date: z.string(),
  transaction_type: z.string(),
  quantity_change: z.number(),
  quantity_before: z.number(),
  quantity_after: z.number(),
  canonical_unit: z.string(),
  source_type: z.string(),
  source_id: nullableText,
  reason: nullableText,
});

export const inventoryListOutputSchema = z.object({
  inventory: z.array(inventoryItemSchema).max(500),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const ingredientInspectOutputSchema = z.object({
  status: z.enum(["matched", "suggestion", "ambiguous", "inactive", "not_found"]),
  query: z.string(),
  match_type: z.enum(["alias", "exact", "normalized", "suggested", "manual", "none"]),
  candidates: z.array(candidateSchema),
  ingredient: inventoryItemSchema.nullable(),
  recent_purchase_evidence: z.array(purchaseEvidenceSchema).max(5),
  recent_inventory_context: z.array(inventoryContextSchema).max(5),
});

const physicalCountRowInputSchema = z.object({
  raw_name: z.string(),
  match_name: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  pack_count: z.number().optional(),
  pack_size: z.number().optional(),
  pack_unit: z.string().optional(),
}).strict();

const countCandidateSchema = z.object({
  ingredientId: z.string(),
  ingredientName: z.string(),
  isActive: z.boolean(),
  reason: z.enum(["alias", "exact", "normalized", "strong_partial", "shared_token"]),
});

export const inventoryCountPreviewInputSchema = z.object({
  kind: z.literal("physical_count"),
  source: z.object({
    name: z.string(),
    fingerprint: z.string(),
    occurrence_id: z.string(),
  }).strict(),
  rows: z.array(physicalCountRowInputSchema).min(1),
}).strict();

const countPreviewRowSchema = z.object({
  row_number: z.number().int().positive(),
  raw_name: z.string(),
  match_name: z.string(),
  canonical_ingredient_id: nullableText,
  canonical_ingredient_name: nullableText,
  match_status: z.enum(["matched", "suggestion", "ambiguous", "unmatched", "inactive_alias"]),
  match_type: z.enum(["alias", "exact", "normalized", "suggested", "manual", "none"]),
  match_candidates: z.array(countCandidateSchema),
  current_quantity: z.number().nullable(),
  base_unit: nullableText,
  current_average_unit_cost: z.number().nullable(),
  counted_quantity: z.number().nullable(),
  counted_unit: nullableText,
  normalized_counted_quantity: z.number().nullable(),
  delta: z.number().nullable(),
  current_inventory_reconciled_at: nullableText,
  current_cost_reconciled_at: nullableText,
  expected_reconciliation_effect: z.literal("quantity_reconciled").nullable(),
  expected_cost_certification_effect: z.enum([
    "cleared",
    "existing_certification_preserved",
    "remained_uncertified",
  ]).nullable(),
  expected_latest_transaction_id: nullableText,
  expected_latest_transaction_quantity: z.number().nullable(),
  note: nullableText,
  errors: z.array(z.string()),
});

export const inventoryCountPreviewOutputSchema = z.object({
  version: z.literal(1),
  kind: z.literal("physical_count_preview"),
  preview_id: z.string(),
  approval_code: z.string(),
  payload_hash: z.string(),
  operation_id: z.string(),
  source: z.object({
    name: z.string(),
    fingerprint: z.string(),
    occurrence_id: z.string(),
  }),
  rows: z.array(countPreviewRowSchema),
  can_apply: z.boolean(),
  errors: z.array(z.string()),
  created_at: z.string(),
});

const countApplyRowSchema = z.object({
  ingredient_id: z.string(),
  ingredient_name: z.string(),
  base_unit: z.string(),
  quantity_before: z.union([z.number(), z.string()]),
  quantity_after: z.union([z.number(), z.string()]),
  quantity_change: z.union([z.number(), z.string()]),
  transaction_id: z.string(),
  inventory_reconciled_at: z.string(),
  cost_reconciled_at: nullableText,
});

export const inventoryCountApplyOutputSchema = z.object({
  status: z.literal("applied_unverified"),
  preview_id: z.string(),
  operation_id: z.string(),
  payload_hash: z.string(),
  applied_reconciliation_events: z.number().int().nonnegative(),
  rows: z.array(countApplyRowSchema),
});

const countVerificationRowSchema = z.object({
  ingredient: z.string(),
  before: z.number(),
  after: z.number(),
  delta: z.number(),
  unit: z.string(),
  transaction_id: z.string(),
  inventory_reconciled_at: z.string(),
  cost_reconciled_at: nullableText,
  cost_certification_effect: z.enum([
    "cleared",
    "existing_certification_preserved",
    "remained_uncertified",
  ]),
});

export const inventoryCountVerifyOutputSchema = z.object({
  status: z.literal("verified"),
  preview_id: z.string(),
  source: z.string(),
  operation_id: z.string(),
  payload_hash: z.string(),
  rows: z.number().int().nonnegative(),
  applied_reconciliation_events: z.number().int().nonnegative(),
  quantity_increased: z.number().int().nonnegative(),
  quantity_decreased: z.number().int().nonnegative(),
  exact_recounts_no_quantity_change: z.number().int().nonnegative(),
  cost_certifications_cleared: z.number().int().nonnegative(),
  existing_cost_certifications_preserved: z.number().int().nonnegative(),
  remained_uncertified: z.number().int().nonnegative(),
  failures: z.literal(0),
  reconciliation_rows: z.array(countVerificationRowSchema),
});

const purchaseItemInputSchema = z.object({
  raw_name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  total_price: z.number(),
  brand: z.string().nullable().optional(),
}).strict();

export const purchasePreviewInputSchema = z.object({
  kind: z.literal("purchase"),
  occasion_id: z.string(),
  supplier: z.string(),
  purchase_date: z.string(),
  source_note: z.string().optional(),
  items: z.array(purchaseItemInputSchema).min(1),
}).strict();

const purchaseApplyStatusSchema = z.enum(["APPLIED", "PARTIALLY_APPLIED", "REPLAYED", "NOT_APPLIED"]);

const purchasePreviewRowSchema = z.object({
  row_number: z.number().int().positive(),
  raw_name: z.string(),
  ingredient: z.object({ id: z.string(), name: z.string() }).nullable(),
  match_status: z.enum(["matched", "suggestion", "ambiguous", "unmatched", "inactive_alias"]),
  match_type: z.enum(["alias", "exact", "normalized", "suggested", "manual", "none"]),
  match_candidates: z.array(z.object({
    ingredient_id: z.string(),
    ingredient_name: z.string(),
    active: z.boolean(),
    reason: z.string(),
  })),
  entered_quantity: z.number().nullable(),
  entered_unit: nullableText,
  converted_quantity: z.number().nullable(),
  base_unit: nullableText,
  total_price: z.number().nullable(),
  brand: nullableText,
  evidence: z.object({
    current_quantity: z.number().nullable(),
    current_average_unit_cost: z.number().nullable(),
    inventory_reconciled_at: nullableText,
  }),
  errors: z.array(z.string()),
});

export const purchasePreviewOutputSchema = z.object({
  preview_id: z.string(),
  approval_code: z.string(),
  can_apply: z.boolean(),
  occasion_id: z.string(),
  supplier: nullableText,
  purchase_date: nullableText,
  source_note: nullableText,
  total_price: z.number(),
  rows: z.array(purchasePreviewRowSchema),
  errors: z.array(z.string()),
  stored: z.boolean(),
  expires_at: nullableText,
  apply_status: purchaseApplyStatusSchema.nullable(),
  notice: z.string(),
});

const purchaseLineSchema = z.object({
  row_number: z.number().int().positive(),
  operation_id: z.string(),
  ingredient_id: z.string(),
  ingredient_name: z.string(),
  outcome: z.enum(["applied", "replayed", "failed", "not_attempted"]),
  supply_id: nullableText,
  transaction_id: nullableText,
  quantity_after: z.number().nullable(),
  average_unit_cost: z.number().nullable(),
  cost_trusted: z.boolean().nullable(),
  error: nullableText,
});

export const purchaseApplyInputSchema = z.object({
  preview_id: z.string().regex(/^pu_[a-f0-9]{20}$/),
  approval_code: z.string().trim().min(1),
}).strict();

export const purchaseApplyOutputSchema = z.object({
  status: z.enum(["APPLIED", "PARTIALLY_APPLIED", "REPLAYED"]),
  preview_id: z.string(),
  occasion_id: z.string(),
  supplier: z.string(),
  purchase_date: z.string(),
  total_lines: z.number().int().positive(),
  committed_lines: z.number().int().nonnegative(),
  lines: z.array(purchaseLineSchema),
  failure: z.object({ row_number: z.number().int().positive(), code: z.string(), message: z.string() }).nullable(),
  message: z.string(),
  next_step: z.string(),
});

export const purchaseVerifyInputSchema = z.object({ preview_id: z.string().regex(/^pu_[a-f0-9]{20}$/) }).strict();

const purchaseVerificationRowSchema = z.object({
  row_number: z.number().int().positive(),
  ingredient: z.string(),
  supplier: z.string(),
  purchase_date: z.string(),
  brand: nullableText,
  entered_quantity: z.number(),
  entered_unit: z.string(),
  total_price: z.number(),
  base_unit: z.string(),
  quantity_before: z.number(),
  quantity_change: z.number(),
  quantity_after: z.number(),
  supply_id: z.string(),
  transaction_id: z.string(),
  cost_trusted_at_post: z.boolean().nullable(),
  current_observed: z.object({
    current_quantity: z.number(),
    average_unit_cost: z.number().nullable(),
    cost_reconciled_at: nullableText,
  }).nullable(),
});

export const purchaseVerifyOutputSchema = z.object({
  status: z.enum(["verified", "partial"]),
  preview_id: z.string(),
  occasion_id: z.string(),
  supplier: z.string(),
  purchase_date: z.string(),
  apply_status: purchaseApplyStatusSchema,
  total_lines: z.number().int().positive(),
  verified_lines: z.number().int().positive(),
  uncommitted_rows: z.array(z.number().int().positive()),
  total_spent: z.number(),
  rows: z.array(purchaseVerificationRowSchema),
  note: z.string(),
});

function success(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

// A partial result is still a structured, schema-shaped answer (the owner needs the per-line detail),
// but it is flagged as an error so no client treats a half-applied purchase as a success.
function loudPartial(value: object) {
  return { ...success(value), isError: true as const };
}

function failure(error: unknown, domain: "inventory" | "purchase" = "inventory") {
  const internalCode = error instanceof ProductLabError ? error.code : "internal_error";
  process.stderr.write(`Product Lab MCP tool failed: ${error instanceof PurchaseDomainError ? error.purchaseCode : internalCode}\n`);
  if (error instanceof PurchaseDomainError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: { code: error.purchaseCode, message: error.publicMessage } }) }],
    };
  }
  // The public vocabulary names the domain that failed: "Inventory count was not applied" would be a
  // false statement about a failed purchase. `domain` never changes the internal category.
  const subject = domain === "purchase" ? "Purchase" : "Inventory count";
  const detail = internalCode === "configuration_error"
      ? { code: "configuration_error", message: "Product Lab MCP is not configured" }
    : internalCode === "credential_rejected"
      || internalCode === "authentication_failed"
      || internalCode === "authorization_failed"
      ? { code: "authentication_error", message: "Product Lab authentication failed" }
      : internalCode === "preview_error"
        ? { code: "invalid_preview", message: `${subject} preview or approval is invalid` }
        : internalCode === "apply_failed"
          ? { code: domain === "purchase" ? "purchase_apply_failed" : "inventory_apply_failed", message: `${subject} was not applied` }
          : internalCode === "verification_failed"
            ? { code: domain === "purchase" ? "purchase_verification_failed" : "inventory_verification_failed", message: `${subject} verification failed` }
            : { code: "read_failed", message: "Product Lab read failed" };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: detail }) }],
  };
}

// All three services are REQUIRED: there is no default, and in particular no default filesystem-backed
// purchase service, so a remote registry can never silently pick up a local store.
export function createProductLabMcpServer(
  readService: ProductLabReadService,
  inventoryCountService: InventoryCountService,
  purchaseService: PurchaseService,
): McpServer {
  const server = new McpServer(
    { name: "product-lab", version: "2.0.0" },
    {
      instructions: "Product Lab facts plus owner-approved physical counts and purchases. Never infer a match from suggestions or ambiguities. After inventory_count_preview or purchase_preview, show the exact preview and stop. Call inventory_count_apply/purchase_apply only after a new owner message contains the matching approval code, then call inventory_count_verify/purchase_verify before reporting verified success. A purchase needs a supplier and an explicit purchase_date; never guess a unit, pack size, ingredient, supplier or date. A multi-line purchase is NOT atomic: if purchase_apply reports PARTIALLY_APPLIED, report it loudly, never call it complete, and never edit the preview.",
    },
  );

  server.registerTool(
    "inventory_list",
    {
      title: "List Product Lab inventory",
      description: "Returns a bounded list of current ingredient inventory facts. This tool never writes.",
      inputSchema: z.object({}).strict(),
      outputSchema: inventoryListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return success(await readService.inventoryList());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "ingredient_inspect",
    {
      title: "Inspect a Product Lab ingredient",
      description: "Matches one ingredient using Product Lab's guarded matcher and returns bounded inventory, purchase-cost, and movement evidence. Suggestions and ambiguities are never selected.",
      inputSchema: z.object({ name: z.string().trim().min(1) }).strict(),
      outputSchema: ingredientInspectOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        return success(await readService.ingredientInspect(name));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inventory_count_preview",
    {
      title: "Preview a Product Lab physical count",
      description: "Builds and stores the existing V1A deterministic physical-count preview. It never mutates inventory. Structured rows may contain one or multiple counted ingredients.",
      inputSchema: inventoryCountPreviewInputSchema,
      outputSchema: inventoryCountPreviewOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (intent) => {
      try {
        return success(await inventoryCountService.preview(intent));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inventory_count_apply",
    {
      title: "Apply an approved Product Lab physical count",
      description: "Applies only a stored V1A preview bound to its approval code. Call only after a NEW owner message explicitly confirms that exact code. Client approval is also required. Returns applied_unverified; verify separately.",
      inputSchema: z.object({
        preview_id: z.string().regex(/^pc_[a-f0-9]{20}$/),
        approval_code: z.string().trim().min(1),
      }).strict(),
      outputSchema: inventoryCountApplyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ preview_id, approval_code }) => {
      try {
        return success(await inventoryCountService.apply(preview_id, approval_code));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inventory_count_verify",
    {
      title: "Verify an applied Product Lab physical count",
      description: "Runs the existing V1A authoritative inventory and ledger read-back verification for a stored applied preview. This tool never writes inventory.",
      inputSchema: z.object({ preview_id: z.string().regex(/^pc_[a-f0-9]{20}$/) }).strict(),
      outputSchema: inventoryCountVerifyOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ preview_id }) => {
      try {
        return success(await inventoryCountService.verify(preview_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "purchase_preview",
    {
      title: "Preview a Product Lab purchase",
      description: "Builds and stores a deterministic preview for ONE real purchase (one supplier, one business date, one or more raw-ingredient lines already resolved by the caller into {raw_name, quantity, unit, total_price, brand?}). Supplier and purchase_date (YYYY-MM-DD) are required; every line needs a positive quantity, a unit of g/kg/ml/L/pcs and a total_price above zero (free or sample stock is not supported). It writes only the preview artifact, never inventory, and blocks any ambiguous, unmatched, unconvertible or never-physically-counted line. Use a fresh occasion_id for each distinct real purchase.",
      inputSchema: purchasePreviewInputSchema,
      outputSchema: purchasePreviewOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (intent) => {
      try {
        return success(await purchaseService.preview(intent));
      } catch (error) {
        return failure(error, "purchase");
      }
    },
  );

  server.registerTool(
    "purchase_apply",
    {
      title: "Apply an approved Product Lab purchase",
      description: "Applies only a stored purchase preview bound to its approval code, posting each line through the existing owner purchase authority (post_raw_purchase), one line at a time. Call only after a NEW owner message explicitly confirms that exact code. The purchase contents may not be re-supplied. Lines are individually idempotent but the purchase is NOT atomic: a failure after earlier lines committed returns PARTIALLY_APPLIED (flagged as an error) and committed lines are not rolled back; retrying with the same preview resumes without duplicating. Returns committed lines unverified; call purchase_verify next.",
      inputSchema: purchaseApplyInputSchema,
      outputSchema: purchaseApplyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ preview_id, approval_code }) => {
      try {
        const result = await purchaseService.apply(preview_id, approval_code);
        return result.status === "PARTIALLY_APPLIED" ? loudPartial(result) : success(result);
      } catch (error) {
        return failure(error, "purchase");
      }
    },
  );

  server.registerTool(
    "purchase_verify",
    {
      title: "Verify an applied Product Lab purchase",
      description: "Reads back, by id, the actual supply entry and inventory-ledger row of every committed line of a stored purchase and fails visibly on any mismatch or missing (reversed) row. Later inventory movements are valid and are reported as observed, not compared. A partially applied purchase is reported as partial and is never marked verified. This tool never writes inventory.",
      inputSchema: purchaseVerifyInputSchema,
      outputSchema: purchaseVerifyOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ preview_id }) => {
      try {
        const result = await purchaseService.verify(preview_id);
        return result.status === "partial" ? loudPartial(result) : success(result);
      } catch (error) {
        return failure(error, "purchase");
      }
    },
  );

  return server;
}

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ProductLabError } from "../product-lab/auth.ts";
import type { InventoryCountService } from "../product-lab/inventory-count-service.ts";
import { ORDER_ID_PATTERN, ORDER_PREVIEW_ID_PATTERN, type OrderCompletionService } from "../product-lab/order-completion-service.ts";
import type { ProductLabReadService } from "../product-lab/read-service.ts";
import { MAX_MCP_PHYSICAL_COUNT_ROWS, MAX_MCP_TOOL_INPUT_ELEMENTS } from "./input-limits.ts";

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
  rows: z.array(physicalCountRowInputSchema).min(1).max(MAX_MCP_PHYSICAL_COUNT_ROWS),
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

const orderPaymentSchema = z.object({
  payment_status: nullableText,
  payment_method: nullableText,
  paid_at: nullableText,
  paid_amount: z.number().nullable(),
  refunded_at: nullableText,
});
const orderSummarySchema = z.object({
  order_id: z.string(),
  status: z.string(),
  customer_name: nullableText,
  placed_at: nullableText,
  fulfillment_method: nullableText,
  fulfillment_at: nullableText,
  total: z.number(),
  payment: orderPaymentSchema,
  completed_at: nullableText,
  cancelled_at: nullableText,
  updated_at: nullableText,
});
const orderLineSummarySchema = z.object({
  line_id: z.string(),
  item_name: z.string(),
  product_id: nullableText,
  quantity: z.number(),
  unit_price: z.number(),
  pieces_per_unit: z.number().nullable(),
  stock_pieces: z.number().nullable(),
});
const orderReservationSchema = z.object({
  allocation_id: z.string(),
  product_id: z.string(),
  production_execution_id: z.string(),
  reserved_pieces: z.number(),
  status: z.string(),
  lot_on_hand: z.number(),
  lot_reserved: z.number(),
});

export const orderInspectOutputSchema = z.object({
  kind: z.enum(["open_orders", "order"]),
  orders: z.array(orderSummarySchema).max(50).optional(),
  returned: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  order: orderSummarySchema.optional(),
  lines: z.array(orderLineSummarySchema).optional(),
  reservation_status: z.enum(["none_required", "reserved", "fulfilled", "released", "not_reserved", "inconsistent"]).optional(),
  reservations: z.array(orderReservationSchema).optional(),
});

export const orderCompletePreviewOutputSchema = z.object({
  version: z.literal(1),
  kind: z.literal("order_completion_preview"),
  order_id: z.string(),
  preview_id: z.string(),
  approval_code: z.string(),
  operation_id: z.string(),
  snapshot_hash: z.string(),
  order: orderSummarySchema,
  lines: z.array(orderLineSummarySchema),
  stock: z.array(z.object({
    allocation_id: z.string(),
    product_id: z.string(),
    production_execution_id: z.string(),
    pieces_to_fulfill: z.number(),
    lot_on_hand_before: z.number(),
    lot_on_hand_after: z.number(),
    lot_reserved_before: z.number(),
    lot_reserved_after: z.number(),
  })),
  effects: z.object({
    status_from: z.string(),
    status_to: z.literal("completed"),
    finished_pieces_fulfilled: z.number(),
    payment_change: z.literal("none"),
  }),
  can_apply: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  created_at: z.string(),
});

export const orderCompleteApplyOutputSchema = z.object({
  status: z.literal("applied_unverified"),
  order_id: z.string(),
  preview_id: z.string(),
  operation_id: z.string(),
  order_status: z.string(),
  completed_at: nullableText,
  payment: orderPaymentSchema,
});

export const orderCompleteVerifyOutputSchema = z.object({
  status: z.enum(["verified", "not_verified"]),
  order_id: z.string(),
  preview_id: z.string(),
  operation_id: z.string(),
  order_status: z.string(),
  completed_at: nullableText,
  allocations: z.number().int().nonnegative(),
  allocations_fulfilled: z.number().int().nonnegative(),
  fulfill_movements_for_operation: z.number().int().nonnegative(),
  finished_pieces_fulfilled: z.number(),
  mutation_receipt: z.enum(["matched", "missing", "mismatched", "not_checked"]),
  payment_at_completion: orderPaymentSchema.nullable(),
  payment_now: orderPaymentSchema,
  failures: z.array(z.string()),
});

const orderIdSchema = z.string().regex(ORDER_ID_PATTERN);
const orderPreviewIdSchema = z.string().regex(ORDER_PREVIEW_ID_PATTERN);

function success(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const internalCode = error instanceof ProductLabError ? error.code : "internal_error";
  process.stderr.write(`Product Lab MCP tool failed: ${internalCode}\n`);
  const detail = internalCode === "configuration_error"
      ? { code: "configuration_error", message: "Product Lab MCP is not configured" }
    : internalCode === "credential_rejected"
      || internalCode === "authentication_failed"
      || internalCode === "authorization_failed"
      ? { code: "authentication_error", message: "Product Lab authentication failed" }
      : internalCode === "preview_error"
        ? { code: "invalid_preview", message: "Inventory count preview or approval is invalid" }
        : internalCode === "apply_failed"
          ? { code: "inventory_apply_failed", message: "Inventory count was not applied" }
          : internalCode === "verification_failed"
            ? { code: "inventory_verification_failed", message: "Inventory count verification failed" }
            : internalCode === "order_not_found"
              ? { code: "order_not_found", message: "Order not found" }
              : internalCode === "order_preview_invalid"
                ? { code: "order_preview_stale_or_invalid", message: "The order changed since this preview, or the approval code does not match. Nothing was changed. Run order_complete_preview again." }
                : internalCode === "order_not_completable"
                  ? { code: "order_not_completable", message: "This order cannot be completed. Nothing was changed. Run order_complete_preview to see why." }
                  : internalCode === "order_apply_in_progress"
                    ? { code: "order_apply_in_progress", message: "This completion is still being processed. Retry order_complete_apply with the same preview_id and approval_code." }
                    : internalCode === "order_apply_failed"
                      ? { code: "order_apply_failed", message: "Order completion was not confirmed. Run order_complete_verify before retrying." }
                      : internalCode === "order_apply_unavailable"
                        ? { code: "order_apply_unavailable", message: "Order completion is not available on this database yet. Nothing was changed." }
                        : { code: "read_failed", message: "Product Lab read failed" };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: detail }) }],
  };
}

export function createProductLabMcpServer(
  readService: ProductLabReadService,
  inventoryCountService: InventoryCountService,
  orderCompletionService: OrderCompletionService,
): McpServer {
  const server = new McpServer(
    { name: "product-lab", version: "2.0.0" },
    {
      maxToolInputElements: MAX_MCP_TOOL_INPUT_ELEMENTS,
      instructions: "Product Lab facts plus owner-approved physical counts. Never infer a match from suggestions or ambiguities. After inventory_count_preview, show the exact preview and stop. Call inventory_count_apply only after a new owner message contains the matching approval code, then call inventory_count_verify before reporting verified success. Order completion follows the same rule: after order_complete_preview, show the exact preview, ask the owner to approve its approval code, and stop; call order_complete_apply only after a new owner message contains that code, then call order_complete_verify. Completing an order never records a payment.",
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
    "order_inspect",
    {
      title: "Inspect Product Lab orders",
      description: "Without order_id, lists up to 50 open orders (new, confirmed, ready). With order_id, returns that order, its lines, payment state and stock reservation status. This tool never writes.",
      inputSchema: z.object({ order_id: orderIdSchema.optional() }).strict(),
      outputSchema: orderInspectOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ order_id }) => {
      try {
        return success(await orderCompletionService.inspect(order_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "order_complete_preview",
    {
      title: "Preview completing a Product Lab order",
      description: "Validates that a confirmed or ready order can be completed and shows exactly which reserved finished stock would be fulfilled. Never changes the order, stock or payment. Show the result and stop; apply only after a NEW owner message confirms the approval code.",
      inputSchema: z.object({ order_id: orderIdSchema }).strict(),
      outputSchema: orderCompletePreviewOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ order_id }) => {
      try {
        return success(await orderCompletionService.preview(order_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "order_complete_apply",
    {
      title: "Complete an approved Product Lab order",
      description: "Completes an order through Product Lab's checked fulfillment function, which refuses if the order changed since the preview or reserved stock is short. Call only after a NEW owner message explicitly confirms that exact approval code. Does not record payment. Returns applied_unverified; verify separately.",
      inputSchema: z.object({
        order_id: orderIdSchema,
        preview_id: orderPreviewIdSchema,
        approval_code: z.string().trim().min(1).max(32),
      }).strict(),
      outputSchema: orderCompleteApplyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      // Claude Code prompts on every call of a tool carrying this marker, in every permission mode
      // including auto and bypassPermissions, and no allow rule skips it. It travels with the server,
      // so it holds on any owner's machine regardless of local settings.
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ order_id, preview_id, approval_code }) => {
      try {
        return success(await orderCompletionService.apply(order_id, preview_id, approval_code));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "order_complete_verify",
    {
      title: "Verify a Product Lab order completion",
      description: "Independently re-reads the order, its stock allocations, finished-stock movements and the completion's mutation receipt. Only this tool can report status verified. Never changes the order, stock or payment.",
      inputSchema: z.object({ order_id: orderIdSchema, preview_id: orderPreviewIdSchema }).strict(),
      outputSchema: orderCompleteVerifyOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ order_id, preview_id }) => {
      try {
        return success(await orderCompletionService.verify(order_id, preview_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

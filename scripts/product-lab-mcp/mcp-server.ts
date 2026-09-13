import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ProductLabError } from "../product-lab/auth.ts";
import { createProductLabReadService, type ProductLabReadService } from "../product-lab/read-service.ts";

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
      : { code: "read_failed", message: "Product Lab read failed" };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: detail }) }],
  };
}

export function createProductLabMcpServer(
  service: ProductLabReadService = createProductLabReadService(),
): McpServer {
  const server = new McpServer(
    { name: "product-lab", version: "1.0.0" },
    {
      instructions: "Read-only Product Lab facts. Use ingredient_inspect for one ingredient and inventory_list for the bounded current catalog. Never infer a match from suggestion or ambiguous candidates.",
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
        return success(await service.inventoryList());
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
        return success(await service.ingredientInspect(name));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

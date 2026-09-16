import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(root, "scripts", "product-lab-mcp", "server.ts");

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_NO_WARNINGS: "1",
    ...overrides,
  };
}

async function connectClient(name: string, url: string, overrides: Record<string, string> = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: root,
    env: childEnvironment({
      PRODUCT_LAB_SUPABASE_URL: url,
      PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mcp_test",
      PRODUCT_LAB_OWNER_ACCESS_TOKEN: "owner-token",
      ...overrides,
    }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const eggId = "11111111-1111-4111-8111-111111111111";
const flourId = "22222222-2222-4222-8222-222222222222";

test("Product Lab MCP purchases (Daily Bakery Ops V2, Slice 1): preview, approval, atomic apply bridge, replay, verify", async (t) => {
  const ingredients: Array<{
    id: string; name: string; base_unit: string; category: string; current_quantity: number;
    low_stock_threshold: number; target_stock_quantity: number; nearest_expiration_date: null;
    average_unit_cost: number; notes: null; is_active: boolean; archived_at: null;
    base_unit_migration_flagged_reason: null; inventory_reconciled_at: string | null; cost_reconciled_at: null;
  }> = [
    { id: eggId, name: "Egg", base_unit: "pcs", category: "ingredient", current_quantity: 20, low_stock_threshold: 0, target_stock_quantity: 0, nearest_expiration_date: null, average_unit_cost: 8, notes: null, is_active: true, archived_at: null, base_unit_migration_flagged_reason: null, inventory_reconciled_at: "2026-09-10T00:00:00.000Z", cost_reconciled_at: null },
    { id: flourId, name: "Flour", base_unit: "g", category: "ingredient", current_quantity: 500, low_stock_threshold: 0, target_stock_quantity: 0, nearest_expiration_date: null, average_unit_cost: 0.09, notes: null, is_active: true, archived_at: null, base_unit_migration_flagged_reason: null, inventory_reconciled_at: "2026-09-10T00:00:00.000Z", cost_reconciled_at: null },
  ];
  const aliases: Array<{ id: string; raw_text: string; normalized_text: string; ingredient_id: string; source: string }> = [];
  const supplies: unknown[] = [];
  type Tx = { id: string; ingredient_id: string; transaction_type: string; quantity_change: number; quantity_before: number; quantity_after: number; source_type: string; source_id: string | null; note: string; reason: null; actor: null; reconciliation_snapshot: null; created_at: string };
  const transactions: Tx[] = [];
  const purchaseImports: Array<{ id: string; file_name: string; status: string; row_count: number; total_value: number }> = [];
  const purchaseImportRows: Array<{ id: string; import_id: string; ingredient_id: string; converted_quantity: number; parsed_total_price: number; row_status: string; match_method: string }> = [];
  const receipts = new Map<string, { hash: string; result: unknown }>();
  let mutationCount = 0;
  let rpcCount = 0;
  let importsWriteCount = 0;
  let rowsWriteCount = 0;

  const api = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (token !== "owner-token") return json(res, 401, { message: "invalid token" });
      return json(res, 200, {
        id: "99999999-9999-4999-8999-999999999999",
        aud: "authenticated",
        role: "authenticated",
        email: "owner@example.test",
        app_metadata: { app_role: "owner" },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname === "/rest/v1/ingredients") {
      const idFilter = url.searchParams.get("id");
      const rows = idFilter?.startsWith("in.(")
        ? ingredients.filter((row) => idFilter.includes(row.id))
        : ingredients;
      return json(res, 200, rows, { "content-range": `0-${rows.length - 1}/${rows.length}` });
    }
    if (url.pathname === "/rest/v1/ingredient_aliases") return json(res, 200, aliases);
    if (url.pathname === "/rest/v1/supply_entries") return json(res, 200, supplies);

    if (url.pathname === "/rest/v1/inventory_transactions" && req.method === "GET") {
      const sourceId = url.searchParams.get("source_id")?.replace(/^eq\./, "") ?? null;
      const idFilter = url.searchParams.get("id");
      let rows = transactions;
      if (sourceId) rows = rows.filter((row) => row.source_id === sourceId);
      if (idFilter?.startsWith("in.(")) rows = rows.filter((row) => idFilter.includes(row.id));
      return json(res, 200, rows);
    }

    if (url.pathname === "/rest/v1/purchase_imports" && req.method === "GET") {
      const idFilter = url.searchParams.get("id")?.replace(/^eq\./, "") ?? null;
      const rows = idFilter ? purchaseImports.filter((row) => row.id === idFilter) : purchaseImports;
      return json(res, 200, rows);
    }

    if (url.pathname === "/rest/v1/purchase_imports" && req.method === "POST") {
      importsWriteCount += 1;
      const body = (await bodyOf(req)) as Array<Record<string, unknown>> | Record<string, unknown>;
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        if (purchaseImports.some((existing) => existing.id === row.id)) {
          return json(res, 409, { message: "duplicate key value violates unique constraint", code: "23505" });
        }
        purchaseImports.push({ id: String(row.id), file_name: String(row.file_name), status: "draft", row_count: Number(row.row_count), total_value: Number(row.total_value) });
      }
      return json(res, 201, []);
    }

    if (url.pathname === "/rest/v1/purchase_import_rows" && req.method === "POST") {
      rowsWriteCount += 1;
      const body = (await bodyOf(req)) as Array<Record<string, unknown>>;
      for (const row of body) {
        if (!purchaseImportRows.some((existing) => existing.id === row.id)) {
          purchaseImportRows.push({
            id: String(row.id), import_id: String(row.import_id), ingredient_id: String(row.ingredient_id),
            converted_quantity: Number(row.converted_quantity), parsed_total_price: Number(row.parsed_total_price),
            row_status: String(row.row_status), match_method: String(row.match_method),
          });
        }
      }
      return json(res, 201, []);
    }

    if (url.pathname === "/rest/v1/rpc/confirm_purchase_import_v2") {
      rpcCount += 1;
      const body = (await bodyOf(req)) as { p_operation_id: string; p_import_id: string };
      const operationId = body.p_operation_id;
      const importId = body.p_import_id;
      const prior = receipts.get(operationId);
      if (prior) {
        if (prior.hash !== importId) return json(res, 409, { message: "operation reused for a different request" });
        return json(res, 200, prior.result);
      }
      const importRow = purchaseImports.find((row) => row.id === importId);
      if (!importRow) return json(res, 404, { message: "Purchase import not found" });
      if (importRow.status !== "draft") return json(res, 409, { message: `This import is already ${importRow.status}` });
      const rows = purchaseImportRows.filter((row) => row.import_id === importId && row.row_status !== "excluded");
      if (rows.length === 0) return json(res, 400, { message: "No rows to confirm" });
      for (const row of rows) {
        const ingredient = ingredients.find((item) => item.id === row.ingredient_id);
        if (!ingredient || row.match_method === "none" || row.match_method === "suggested" || row.converted_quantity <= 0) {
          return json(res, 400, { message: "Row is not ready to confirm" });
        }
        if (!ingredient.inventory_reconciled_at) {
          return json(res, 400, { message: `Verify the physical stock of "${ingredient.name}" before posting a purchase for it.` });
        }
      }
      const touchedIds = [...new Set(rows.map((row) => row.ingredient_id))].sort();
      const transactionIds: string[] = [];
      const now = new Date().toISOString();
      for (const ingredientId of touchedIds) {
        const ingredient = ingredients.find((item) => item.id === ingredientId)!;
        const added = rows.filter((row) => row.ingredient_id === ingredientId).reduce((sum, row) => sum + row.converted_quantity, 0);
        const before = ingredient.current_quantity;
        const after = before + added;
        const txId = `90000000-0000-4000-8000-${String(mutationCount + 1).padStart(12, "0")}`;
        transactions.push({
          id: txId, ingredient_id: ingredientId, transaction_type: "purchase", quantity_change: added,
          quantity_before: before, quantity_after: after, source_type: "purchase_import", source_id: importId,
          note: "", reason: null, actor: null, reconciliation_snapshot: null, created_at: now,
        });
        ingredient.current_quantity = after;
        transactionIds.push(txId);
        mutationCount += 1;
      }
      importRow.status = "confirmed";
      const result = { import_id: importId, transaction_ids: transactionIds };
      receipts.set(operationId, { hash: importId, result });
      return json(res, 200, result);
    }

    return json(res, 404, { message: `unexpected path ${url.pathname}` });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  await t.test("purchase_apply's input schema accepts only preview_id and approval_code, never a re-supplied payload", async () => {
    const connection = await connectClient("purchase-schema", url);
    t.after(() => connection.client.close());
    const discovery = await connection.client.listTools();
    const applyTool = discovery.tools.find((tool) => tool.name === "purchase_apply");
    const previewTool = discovery.tools.find((tool) => tool.name === "purchase_preview");
    const verifyTool = discovery.tools.find((tool) => tool.name === "purchase_verify");
    assert.equal(applyTool?.annotations?.destructiveHint, true);
    assert.equal(previewTool?.annotations?.destructiveHint, false);
    assert.equal(verifyTool?.annotations?.readOnlyHint, true);
    const applyProperties = (applyTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.deepEqual(Object.keys(applyProperties).sort(), ["approval_code", "preview_id"]);
    for (const forbidden of ["items", "raw_name", "quantity", "unit", "total_price", "sql", "rpc"]) {
      assert.equal(forbidden in applyProperties, false);
    }
  });

  await t.test("single-item purchase: preview never mutates, apply bridges atomically, verify succeeds", async () => {
    const connection = await connectClient("purchase-single", url);
    t.after(() => connection.client.close());

    const importsBefore = importsWriteCount;
    const rowsBefore = rowsWriteCount;
    const rpcBefore = rpcCount;
    const previewResult = await connection.client.callTool({
      name: "purchase_preview",
      arguments: {
        kind: "purchase",
        occasion_id: "2026-09-16-eggs",
        items: [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }],
      },
    });
    assert.equal(previewResult.isError, undefined, JSON.stringify(previewResult));
    // Preview must never write to purchase_imports/purchase_import_rows or call the RPC.
    assert.equal(importsWriteCount, importsBefore);
    assert.equal(rowsWriteCount, rowsBefore);
    assert.equal(rpcCount, rpcBefore);

    const preview = previewResult.structuredContent as Record<string, unknown>;
    assert.equal(preview.can_apply, true);
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    t.after(() => rm(path.join(root, ".purchase-operator", "previews", `${previewId}.json`), { force: true }));

    const wrongApproval = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: "0000-0000" },
    });
    assert.equal(wrongApproval.isError, true);
    assert.match(JSON.stringify(wrongApproval.content), /invalid_preview/);
    assert.equal(rpcCount, rpcBefore);

    const applied = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(applied.isError, undefined, JSON.stringify(applied));
    const appliedContent = applied.structuredContent as Record<string, unknown>;
    assert.equal(appliedContent.status, "applied_unverified");
    assert.equal(rpcCount, rpcBefore + 1);
    assert.equal(ingredients.find((item) => item.id === eggId)!.current_quantity, 50);

    // Replay: same preview_id + approval_code must not create a second reconciliation event.
    const replay = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(replay.isError, undefined);
    assert.deepEqual(replay.structuredContent, applied.structuredContent);
    assert.equal(rpcCount, rpcBefore + 2, "the RPC is still called (idempotency is the database's claim_mutation, not a client-side skip)");
    assert.equal(ingredients.find((item) => item.id === eggId)!.current_quantity, 50, "replay must not double-apply the purchase");

    const verified = await connection.client.callTool({
      name: "purchase_verify",
      arguments: { preview_id: previewId },
    });
    assert.equal(verified.isError, undefined, JSON.stringify(verified));
    const report = verified.structuredContent as Record<string, unknown>;
    assert.equal(report.status, "verified");
    assert.equal(report.ingredients_touched, 1);
    assert.equal(report.total_spent, 300);
    const purchaseRows = report.purchase_rows as Array<Record<string, unknown>>;
    assert.equal(purchaseRows[0].before, 20);
    assert.equal(purchaseRows[0].after, 50);
    assert.equal(purchaseRows[0].delta, 30);
    assert.equal(purchaseRows[0].unit, "pcs");
  });

  await t.test("multi-item purchase: distinct ingredients, one delta each, verify reports both", async () => {
    const connection = await connectClient("purchase-multi", url);
    t.after(() => connection.client.close());
    const previewResult = await connection.client.callTool({
      name: "purchase_preview",
      arguments: {
        kind: "purchase",
        occasion_id: "2026-09-16-flour-and-eggs",
        items: [
          { raw_name: "Egg", quantity: 12, unit: "pcs", total_price: 120 },
          { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 },
        ],
      },
    });
    const preview = previewResult.structuredContent as Record<string, unknown>;
    assert.equal(preview.can_apply, true);
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    t.after(() => rm(path.join(root, ".purchase-operator", "previews", `${previewId}.json`), { force: true }));

    const eggBefore = ingredients.find((item) => item.id === eggId)!.current_quantity;
    const flourBefore = ingredients.find((item) => item.id === flourId)!.current_quantity;

    const applied = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(applied.isError, undefined, JSON.stringify(applied));
    const appliedContent = applied.structuredContent as Record<string, unknown>;
    const appliedRows = appliedContent.rows as Array<Record<string, unknown>>;
    assert.equal(appliedRows.length, 2);
    assert.equal(ingredients.find((item) => item.id === eggId)!.current_quantity, eggBefore + 12);
    assert.equal(ingredients.find((item) => item.id === flourId)!.current_quantity, flourBefore + 2000);

    const verified = await connection.client.callTool({ name: "purchase_verify", arguments: { preview_id: previewId } });
    const report = verified.structuredContent as Record<string, unknown>;
    assert.equal(report.status, "verified");
    assert.equal(report.ingredients_touched, 2);
    assert.equal(report.total_spent, 310);
  });

  await t.test("a preview payload tampered after approval is rejected (stale/tampered guard)", async () => {
    const connection = await connectClient("purchase-tamper", url);
    t.after(() => connection.client.close());
    const previewResult = await connection.client.callTool({
      name: "purchase_preview",
      arguments: { kind: "purchase", occasion_id: "2026-09-16-tamper", items: [{ raw_name: "Egg", quantity: 5, unit: "pcs", total_price: 50 }] },
    });
    const preview = previewResult.structuredContent as Record<string, unknown>;
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    const artifactPath = path.join(root, ".purchase-operator", "previews", `${previewId}.json`);
    t.after(() => rm(artifactPath, { force: true }));

    const stored = JSON.parse(await readFile(artifactPath, "utf8")) as { preview: { rows: Array<{ converted_quantity: number }> } };
    stored.preview.rows[0].converted_quantity = 9999;
    await writeFile(artifactPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const rpcBefore = rpcCount;
    const tamperedApply = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(tamperedApply.isError, true);
    assert.match(JSON.stringify(tamperedApply.content), /invalid_preview/);
    assert.equal(rpcCount, rpcBefore, "a tampered preview must never reach the database");
  });

  await t.test("apply is atomic: a mid-flight rejection leaves the whole batch unapplied, not partially applied", async () => {
    const connection = await connectClient("purchase-atomic", url);
    t.after(() => connection.client.close());
    const previewResult = await connection.client.callTool({
      name: "purchase_preview",
      arguments: {
        kind: "purchase",
        occasion_id: "2026-09-16-atomic",
        items: [
          { raw_name: "Egg", quantity: 6, unit: "pcs", total_price: 60 },
          { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
        ],
      },
    });
    const preview = previewResult.structuredContent as Record<string, unknown>;
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    t.after(() => rm(path.join(root, ".purchase-operator", "previews", `${previewId}.json`), { force: true }));

    // Simulate the ingredient becoming un-postable between preview and apply (mirrors the database's
    // own inventory_reconciled_at guard rejecting the whole confirm before anything is written).
    const flour = ingredients.find((item) => item.id === flourId)!;
    const savedReconciledAt = flour.inventory_reconciled_at;
    flour.inventory_reconciled_at = null;

    const eggBefore = ingredients.find((item) => item.id === eggId)!.current_quantity;
    const transactionsBefore = transactions.length;
    const applied = await connection.client.callTool({
      name: "purchase_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(applied.isError, true);
    assert.match(JSON.stringify(applied.content), /apply_failed|inventory_apply_failed/);
    assert.equal(transactions.length, transactionsBefore, "no ledger row for EITHER ingredient -- the eggs half must not have been applied either");
    assert.equal(ingredients.find((item) => item.id === eggId)!.current_quantity, eggBefore);

    flour.inventory_reconciled_at = savedReconciledAt;
  });

  await t.test("verify detects an authoritative-state mismatch instead of trusting the apply artifact", async () => {
    const connection = await connectClient("purchase-verify-mismatch", url);
    t.after(() => connection.client.close());
    const previewResult = await connection.client.callTool({
      name: "purchase_preview",
      arguments: { kind: "purchase", occasion_id: "2026-09-16-mismatch", items: [{ raw_name: "Egg", quantity: 4, unit: "pcs", total_price: 40 }] },
    });
    const preview = previewResult.structuredContent as Record<string, unknown>;
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    t.after(() => rm(path.join(root, ".purchase-operator", "previews", `${previewId}.json`), { force: true }));

    const applied = await connection.client.callTool({ name: "purchase_apply", arguments: { preview_id: previewId, approval_code: approvalCode } });
    assert.equal(applied.isError, undefined);
    const appliedContent = applied.structuredContent as { rows: Array<{ transaction_id: string }> };
    const transactionId = appliedContent.rows[0].transaction_id;
    const ledgerRow = transactions.find((row) => row.id === transactionId)!;
    const originalAfter = ledgerRow.quantity_after;
    ledgerRow.quantity_after = originalAfter + 1000;

    const mismatch = await connection.client.callTool({ name: "purchase_verify", arguments: { preview_id: previewId } });
    assert.equal(mismatch.isError, true);
    assert.match(JSON.stringify(mismatch.content), /verification_failed/);
    ledgerRow.quantity_after = originalAfter;
  });
});

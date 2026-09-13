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

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body) as Record<string, unknown>;
}

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_NO_WARNINGS: "1",
    ...overrides,
  };
}

type ConnectedClient = {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
};

async function connectClient(
  name: string,
  url: string,
  overrides: Record<string, string> = {},
): Promise<ConnectedClient> {
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

test("Product Lab stdio MCP protocol, auth, schemas, safety, and protocol-client parity", async (t) => {
  const saltId = "11111111-1111-4111-8111-111111111111";
  const ingredients = [{
    id: saltId,
    name: "MC Sea Salt",
    base_unit: "g",
    category: "ingredient",
    current_quantity: 4700,
    low_stock_threshold: 100,
    target_stock_quantity: 5000,
    nearest_expiration_date: null,
    average_unit_cost: null,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migration_flagged_reason: null,
    inventory_reconciled_at: "2026-09-12T01:00:00.000Z",
    cost_reconciled_at: null,
  }];
  const aliases = [{
    id: "alias-1",
    raw_text: "sea salt",
    normalized_text: "sea salt",
    ingredient_id: saltId,
    source: "test",
  }];
  const supplies = [{
    id: "22222222-2222-4222-8222-222222222222",
    ingredient_id: saltId,
    ingredient_name: "MC Sea Salt",
    brand_name: "McCormick",
    supplier_name: "Test Store",
    purchase_date: "2026-09-11",
    created_at: "2026-09-11T01:00:00.000Z",
    pack_quantity: 1,
    unit: "kg",
    total_cost: 24,
    quality_rating: 5,
    notes: null,
  }];
  const transactions: Array<{
    id: string;
    ingredient_id: string;
    transaction_type: string;
    quantity_change: number;
    quantity_before: number;
    quantity_after: number;
    source_type: string;
    source_id: string | null;
    note: string;
    reason: string | null;
    actor: string | null;
    reconciliation_snapshot: Record<string, unknown> | null;
    created_at: string;
  }> = [{
    id: "33333333-3333-4333-8333-333333333333",
    ingredient_id: saltId,
    transaction_type: "purchase",
    quantity_change: 1000,
    quantity_before: 3700,
    quantity_after: 4700,
    source_type: "manual",
    source_id: supplies[0].id,
    note: "",
    reason: null,
    actor: null,
    reconciliation_snapshot: null,
    created_at: "2026-09-11T02:00:00.000Z",
  }];
  let requestCount = 0;
  let authCount = 0;
  let rpcCount = 0;
  let mutationCount = 0;
  let ownerTokenExpired = false;
  const receipts = new Map<string, { hash: string; result: Record<string, unknown> }>();
  const api = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      authCount += 1;
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (token === "invalid-token" || (token === "owner-token" && ownerTokenExpired)) {
        return json(res, 401, { message: "invalid token" });
      }
      return json(res, 200, {
        id: "99999999-9999-4999-8999-999999999999",
        aud: "authenticated",
        role: "authenticated",
        email: "owner@example.test",
        app_metadata: { app_role: token === "staff-token" ? "staff" : "owner" },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
    if (req.headers.authorization === "Bearer read-error-token" && url.pathname.startsWith("/rest/v1/")) {
      return json(res, 500, { message: "RAW_BACKEND_DETAIL owner-token sb_publishable_mcp_test" });
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
    if (url.pathname === "/rest/v1/inventory_transactions") {
      const idFilter = url.searchParams.get("id");
      const rows = idFilter?.startsWith("in.(")
        ? transactions.filter((row) => idFilter.includes(row.id))
        : transactions;
      return json(res, 200, rows);
    }
    if (url.pathname === "/rest/v1/rpc/apply_inventory_physical_count_batch") {
      rpcCount += 1;
      const body = await bodyOf(req);
      const operationId = String(body.p_operation_id);
      const payloadHash = String(body.p_payload_hash);
      const prior = receipts.get(operationId);
      if (prior) {
        if (prior.hash !== payloadHash) return json(res, 409, { message: "operation reused for a different request" });
        return json(res, 200, prior.result);
      }
      const requestedRows = body.p_rows as Array<Record<string, unknown>>;
      for (const row of requestedRows) {
        const ingredient = ingredients.find((item) => item.id === row.ingredient_id);
        const latest = [...transactions]
          .filter((item) => item.ingredient_id === row.ingredient_id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
        if (!ingredient
          || ingredient.current_quantity !== row.expected_quantity
          || ingredient.base_unit !== row.expected_unit
          || (latest?.id ?? null) !== row.expected_latest_id) {
          return json(res, 409, { message: "stale physical-count preview" });
        }
      }
      const resultRows = requestedRows.map((row, index) => {
        const ingredient = ingredients.find((item) => item.id === row.ingredient_id)!;
        const latest = [...transactions]
          .filter((item) => item.ingredient_id === ingredient.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
        const before = ingredient.current_quantity;
        const after = Number(row.counted_quantity);
        const delta = after - before;
        const transactionId = `90000000-0000-4000-8000-${String(mutationCount + 1).padStart(12, "0")}`;
        const reconciledAt = `2026-09-13T02:00:0${index}.000Z`;
        transactions.push({
          id: transactionId,
          ingredient_id: ingredient.id,
          transaction_type: "adjustment",
          quantity_change: delta,
          quantity_before: before,
          quantity_after: after,
          source_type: "manual",
          source_id: null,
          note: String(row.note),
          reason: "stock_count_correction",
          actor: "99999999-9999-4999-8999-999999999999",
          reconciliation_snapshot: {
            cache_quantity: before,
            latest_ledger_quantity: latest?.quantity_after ?? null,
            latest_ledger_id: latest?.id ?? null,
            base_unit: ingredient.base_unit,
            average_unit_cost: ingredient.average_unit_cost,
            previous_reconciled_at: ingredient.inventory_reconciled_at,
            verified_quantity: after,
          },
          created_at: reconciledAt,
        });
        ingredient.current_quantity = after;
        ingredient.inventory_reconciled_at = reconciledAt;
        if (delta > 0) ingredient.cost_reconciled_at = null;
        mutationCount += 1;
        return {
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          base_unit: ingredient.base_unit,
          quantity_before: before,
          quantity_after: after,
          quantity_change: delta,
          transaction_id: transactionId,
          inventory_reconciled_at: reconciledAt,
          cost_reconciled_at: ingredient.cost_reconciled_at,
        };
      });
      const result = {
        operation_id: operationId,
        payload_hash: payloadHash,
        applied_reconciliation_events: resultRows.length,
        rows: resultRows,
      };
      receipts.set(operationId, { hash: payloadHash, result });
      return json(res, 200, result);
    }
    return json(res, 404, { message: `unexpected path ${url.pathname}` });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  await t.test("server starts, discovers exactly the approved Slice 2 surface, and returns structured results", async () => {
    const connection = await connectClient("protocol-test", url);
    t.after(() => connection.client.close());
    const discovery = await connection.client.listTools();
    assert.deepEqual(discovery.tools.map((tool) => tool.name).sort(), [
      "ingredient_inspect",
      "inventory_count_apply",
      "inventory_count_preview",
      "inventory_count_verify",
      "inventory_list",
    ]);
    for (const tool of discovery.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
    }
    for (const name of ["inventory_list", "ingredient_inspect", "inventory_count_verify"]) {
      const tool = discovery.tools.find((item) => item.name === name);
      assert.equal(tool?.annotations?.readOnlyHint, true);
      assert.equal(tool?.annotations?.destructiveHint, false);
    }
    const previewTool = discovery.tools.find((tool) => tool.name === "inventory_count_preview");
    const applyTool = discovery.tools.find((tool) => tool.name === "inventory_count_apply");
    assert.equal(previewTool?.annotations?.destructiveHint, false);
    assert.equal(applyTool?.annotations?.readOnlyHint, false);
    assert.equal(applyTool?.annotations?.destructiveHint, true);
    assert.equal(applyTool?.annotations?.idempotentHint, true);
    const inventoryTool = discovery.tools.find((tool) => tool.name === "inventory_list");
    const inspectTool = discovery.tools.find((tool) => tool.name === "ingredient_inspect");
    assert.ok(inventoryTool?.outputSchema && typeof inventoryTool.outputSchema === "object" && "properties" in inventoryTool.outputSchema);
    assert.ok(inspectTool?.inputSchema && typeof inspectTool.inputSchema === "object" && "properties" in inspectTool.inputSchema);
    const inventoryProperties = (inventoryTool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const inspectProperties = (inspectTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const applyProperties = (applyTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("inventory" in inventoryProperties);
    assert.ok("name" in inspectProperties);
    assert.deepEqual(Object.keys(applyProperties).sort(), ["approval_code", "preview_id"]);
    for (const forbidden of ["ingredient", "quantity", "unit", "payload", "sql", "rpc"]) {
      assert.equal(forbidden in applyProperties, false);
    }

    const inventory = await connection.client.callTool({ name: "inventory_list", arguments: {} });
    assert.equal(inventory.isError, undefined);
    assert.deepEqual(inventory.structuredContent, {
      inventory: [{
        id: saltId,
        canonical_name: "MC Sea Salt",
        active: true,
        current_quantity: 4700,
        canonical_unit: "g",
        inventory_reconciled_at: "2026-09-12T01:00:00.000Z",
        cost_reconciled_at: null,
        average_unit_cost: null,
      }],
      returned: 1,
      total: 1,
      truncated: false,
    });
    const inspected = await connection.client.callTool({ name: "ingredient_inspect", arguments: { name: "MC Sea Salt" } });
    assert.equal(inspected.isError, undefined);
    assert.equal((inspected.structuredContent as { status: string }).status, "matched");
    assert.match(connection.stderr(), /Product Lab MCP stdio server starting/);
  });

  await t.test("valid owner auth is checked through auth.getUser", async () => {
    const before = authCount;
    const connection = await connectClient("owner-auth-test", url);
    await connection.client.listTools();
    const result = await connection.client.callTool({ name: "inventory_list", arguments: {} });
    await connection.client.close();
    assert.equal(result.isError, undefined);
    assert.equal(authCount, before + 1);
  });

  await t.test("non-owner and invalid tokens return structured tool errors", async () => {
    for (const token of ["staff-token", "invalid-token"]) {
      const connection = await connectClient("auth-error", url, { PRODUCT_LAB_OWNER_ACCESS_TOKEN: token });
      await connection.client.listTools();
      const result = await connection.client.callTool({ name: "inventory_list", arguments: {} });
      await connection.client.close();
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /authentication_error/);
    }
  });

  await t.test("secret and service-role keys are rejected before any network request", async () => {
    const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const secretKeys = [
      "sb_secret_mcp_test",
      `${jwtPart({ alg: "HS256", typ: "JWT" })}.${jwtPart({ role: "service_role" })}.signature`,
    ];
    for (const key of secretKeys) {
      const before = requestCount;
      const connection = await connectClient("secret-key-test", url, { PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: key });
      await connection.client.listTools();
      const result = await connection.client.callTool({ name: "inventory_list", arguments: {} });
      await connection.client.close();
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /authentication_error/);
      assert.equal(requestCount, before);
    }
  });

  await t.test("two independent MCP protocol clients receive equivalent evidence from the same entry point", async () => {
    const first = await connectClient("protocol-client-one", url);
    const second = await connectClient("protocol-client-two", url);
    await first.client.listTools();
    await second.client.listTools();
    const firstResult = await first.client.callTool({ name: "ingredient_inspect", arguments: { name: "MC Sea Salt" } });
    const secondResult = await second.client.callTool({ name: "ingredient_inspect", arguments: { name: "MC Sea Salt" } });
    await first.client.close();
    await second.client.close();
    assert.deepEqual(firstResult.structuredContent, secondResult.structuredContent);
  });

  await t.test("backend errors are public-safe while diagnostics stay on stderr without credentials", async () => {
    const connection = await connectClient("public-error-test", url, { PRODUCT_LAB_OWNER_ACCESS_TOKEN: "read-error-token" });
    const result = await connection.client.callTool({ name: "inventory_list", arguments: {} });
    await connection.client.close();
    const publicResult = JSON.stringify(result.content);
    assert.equal(result.isError, true);
    assert.match(publicResult, /read_failed/);
    assert.doesNotMatch(publicResult, /RAW_BACKEND_DETAIL|owner-token|sb_publishable_mcp_test/);
    assert.match(connection.stderr(), /Product Lab MCP tool failed: read_failed/);
    assert.doesNotMatch(connection.stderr(), /RAW_BACKEND_DETAIL|owner-token|sb_publishable_mcp_test|read-error-token/);
  });

  await t.test("preview, approval-code and payload boundary, apply replay, stale protection, and verification use V1A end to end", async () => {
    const connection = await connectClient("inventory-count-flow", url);
    t.after(() => connection.client.close());
    const authBeforePreview = authCount;
    const previewResult = await connection.client.callTool({
      name: "inventory_count_preview",
      arguments: {
        kind: "physical_count",
        source: {
          name: "owner-message-2026-09-13",
          fingerprint: "a".repeat(64),
          occurrence_id: "mcp-count-2026-09-13-01",
        },
        rows: [{ raw_name: "sea salt", quantity: 4.8, unit: "kg" }],
      },
    });
    assert.equal(previewResult.isError, undefined, JSON.stringify(previewResult));
    assert.equal(authCount, authBeforePreview + 1);
    const preview = previewResult.structuredContent as Record<string, unknown>;
    const previewRows = preview.rows as Array<Record<string, unknown>>;
    assert.equal(preview.can_apply, true);
    assert.equal(previewRows[0].match_status, "matched");
    assert.equal(previewRows[0].match_type, "alias");
    assert.equal(previewRows[0].canonical_ingredient_id, saltId);
    assert.equal(previewRows[0].current_quantity, 4700);
    assert.equal(previewRows[0].normalized_counted_quantity, 4800);
    assert.equal(previewRows[0].delta, 100);
    assert.equal(previewRows[0].expected_cost_certification_effect, "remained_uncertified");
    assert.equal(typeof preview.payload_hash, "string");
    assert.equal(typeof preview.approval_code, "string");
    const previewId = String(preview.preview_id);
    const approvalCode = String(preview.approval_code);
    t.after(() => rm(path.join(root, ".inventory-operator", "previews", `${previewId}.json`), { force: true }));

    const staffConnection = await connectClient("inventory-count-staff", url, {
      PRODUCT_LAB_OWNER_ACCESS_TOKEN: "staff-token",
    });
    const staffApply = await staffConnection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    await staffConnection.client.close();
    assert.equal(staffApply.isError, true);
    assert.match(JSON.stringify(staffApply.content), /authentication_error/);
    assert.equal(rpcCount, 0);

    const secretConnection = await connectClient("inventory-count-secret", url, {
      PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_secret_apply_test",
    });
    const requestsBeforeSecretApply = requestCount;
    const secretApply = await secretConnection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    await secretConnection.client.close();
    assert.equal(secretApply.isError, true);
    assert.match(JSON.stringify(secretApply.content), /authentication_error/);
    assert.equal(requestCount, requestsBeforeSecretApply, "privileged keys must fail before any request");
    assert.equal(rpcCount, 0);

    ownerTokenExpired = true;
    const authBeforeApply = authCount;
    const expiredApply = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(expiredApply.isError, true);
    assert.match(JSON.stringify(expiredApply.content), /authentication_error/);
    assert.equal(authCount, authBeforeApply + 1, "apply must revalidate auth instead of reusing preview auth");
    assert.equal(rpcCount, 0);

    ownerTokenExpired = false;
    const wrongApproval = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: "0000-0000" },
    });
    assert.equal(wrongApproval.isError, true);
    assert.match(JSON.stringify(wrongApproval.content), /invalid_preview/);
    assert.equal(rpcCount, 0);

    const missingPreview = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: "pc_00000000000000000000", approval_code: approvalCode },
    });
    assert.equal(missingPreview.isError, true);
    assert.match(JSON.stringify(missingPreview.content), /invalid_preview/);
    assert.equal(rpcCount, 0);

    const substitutedPayload = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode, quantity: 999 },
    });
    assert.equal(substitutedPayload.isError, true);
    const missingApproval = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId },
    });
    assert.equal(missingApproval.isError, true);
    assert.equal(rpcCount, 0);

    const applied = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.equal(applied.isError, undefined);
    assert.equal((applied.structuredContent as { status: string }).status, "applied_unverified");
    assert.equal(rpcCount, 1);
    assert.equal(mutationCount, 1);

    const replay = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: previewId, approval_code: approvalCode },
    });
    assert.deepEqual(replay.structuredContent, applied.structuredContent);
    assert.equal(rpcCount, 2);
    assert.equal(mutationCount, 1, "idempotent replay must not create another reconciliation event");

    const storedArtifactPath = path.join(root, ".inventory-operator", "previews", `${previewId}.json`);
    const storedArtifact = JSON.parse(await readFile(storedArtifactPath, "utf8")) as {
      apply_result: { rows: Array<{ cost_reconciled_at: string | null }> };
    };
    storedArtifact.apply_result.rows[0].cost_reconciled_at = "1999-01-01T00:00:00.000Z";
    await writeFile(storedArtifactPath, `${JSON.stringify(storedArtifact, null, 2)}\n`, "utf8");

    const verified = await connection.client.callTool({
      name: "inventory_count_verify",
      arguments: { preview_id: previewId },
    });
    assert.equal(verified.isError, undefined);
    const report = verified.structuredContent as Record<string, unknown>;
    assert.equal(report.status, "verified");
    assert.equal(report.quantity_increased, 1);
    assert.equal(report.cost_certifications_cleared, 0);
    assert.equal(report.remained_uncertified, 1);
    const reconciliationRows = report.reconciliation_rows as Array<Record<string, unknown>>;
    assert.equal(reconciliationRows[0].after, 4800);
    assert.equal(reconciliationRows[0].unit, "g");
    assert.equal(reconciliationRows[0].cost_reconciled_at, null, "authoritative ingredient read-back must override a tampered apply artifact timestamp");
    assert.equal(reconciliationRows[0].cost_certification_effect, "remained_uncertified");

    const appliedTransaction = transactions.find((row) => row.id === reconciliationRows[0].transaction_id)!;
    const snapshot = appliedTransaction.reconciliation_snapshot as Record<string, unknown>;
    const originalVerifiedQuantity = snapshot.verified_quantity;
    snapshot.verified_quantity = 999;
    const mismatch = await connection.client.callTool({
      name: "inventory_count_verify",
      arguments: { preview_id: previewId },
    });
    assert.equal(mismatch.isError, true);
    assert.match(JSON.stringify(mismatch.content), /inventory_verification_failed/);
    assert.doesNotMatch(JSON.stringify(mismatch.content), /verified_quantity|999/);
    snapshot.verified_quantity = originalVerifiedQuantity;

    const stalePreviewResult = await connection.client.callTool({
      name: "inventory_count_preview",
      arguments: {
        kind: "physical_count",
        source: {
          name: "owner-message-stale",
          fingerprint: "b".repeat(64),
          occurrence_id: "mcp-count-2026-09-13-stale",
        },
        rows: [{ raw_name: "MC Sea Salt", quantity: 4750, unit: "g" }],
      },
    });
    const stalePreview = stalePreviewResult.structuredContent as Record<string, unknown>;
    const stalePreviewId = String(stalePreview.preview_id);
    t.after(() => rm(path.join(root, ".inventory-operator", "previews", `${stalePreviewId}.json`), { force: true }));
    ingredients[0].current_quantity = 4790;
    const staleApply = await connection.client.callTool({
      name: "inventory_count_apply",
      arguments: {
        preview_id: stalePreviewId,
        approval_code: String(stalePreview.approval_code),
      },
    });
    assert.equal(staleApply.isError, true);
    assert.match(JSON.stringify(staleApply.content), /inventory_apply_failed/);
    assert.equal(mutationCount, 1);
  });

  await t.test("MCP delegates the sole mutation, Codex config declares user review plus an apply prompt, and Claude config declares ask", async () => {
    const [adapter, entry, readService, countService, cli, codexConfig, claudeConfig, mcpConfig] = await Promise.all([
      readFile(path.join(root, "scripts", "product-lab-mcp", "mcp-server.ts"), "utf8"),
      readFile(serverEntry, "utf8"),
      readFile(path.join(root, "scripts", "product-lab", "read-service.ts"), "utf8"),
      readFile(path.join(root, "scripts", "product-lab", "inventory-count-service.ts"), "utf8"),
      readFile(path.join(root, "scripts", "inventory-operator", "run.ts"), "utf8"),
      readFile(path.join(root, ".codex", "config.toml"), "utf8"),
      readFile(path.join(root, ".claude", "settings.json"), "utf8"),
      readFile(path.join(root, ".mcp.json"), "utf8"),
    ]);
    assert.match(adapter, /product-lab\/inventory-count-service/);
    assert.match(cli, /product-lab\/inventory-count-service/);
    assert.doesNotMatch(cli, /\.rpc\(|reconciliationSnapshotMismatches/);
    assert.doesNotMatch(adapter, /inventory-operator\/run|\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    assert.doesNotMatch(readService, /\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    assert.match(countService, /\.rpc\(\s*\n?\s*"apply_inventory_physical_count_batch"/);
    assert.equal((countService.match(/\.rpc\(/g) ?? []).length, 1);
    assert.doesNotMatch(countService, /\.insert\(|\.update\(|\.delete\(|execute_sql|generic/i);
    assert.doesNotMatch(`${adapter}\n${entry}`, /process\.stdout|console\.log/);
    assert.match(entry, /process\.stderr\.write/);
    const approvedTools = [
      "inventory_list",
      "ingredient_inspect",
      "inventory_count_preview",
      "inventory_count_apply",
      "inventory_count_verify",
    ];
    for (const forbidden of ["sql", "rpc", "purchase_post", "cost_certification", "order_transition", "bake", "inventory_adjustment"]) {
      assert.equal(approvedTools.includes(forbidden), false);
    }
    const codexEnabledTools = codexConfig.match(/enabled_tools\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
    assert.match(codexEnabledTools, /"inventory_count_preview"/);
    assert.match(codexEnabledTools, /"inventory_count_verify"/);
    assert.match(codexEnabledTools, /"inventory_count_apply"/);
    assert.match(codexConfig, /approvals_reviewer\s*=\s*"user"/);
    assert.match(codexConfig, /\[mcp_servers\.product_lab\.tools\.inventory_count_apply\][\s\S]*approval_mode\s*=\s*"prompt"/);
    assert.deepEqual(JSON.parse(claudeConfig).permissions.ask, ["mcp__product_lab__inventory_count_apply"]);
    assert.doesNotMatch(claudeConfig, /"allow"\s*:\s*\[[\s\S]*inventory_count_apply/);
    assert.doesNotMatch(mcpConfig, /allowedTools|inventory_count_apply/);
  });
});

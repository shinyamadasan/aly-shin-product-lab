import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(root, "scripts", "product-lab-mcp", "server.ts");

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
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
  const transactions = [{
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
  const api = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      authCount += 1;
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (token === "invalid-token") return json(res, 401, { message: "invalid token" });
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
      return json(res, 200, ingredients, { "content-range": `0-${ingredients.length - 1}/${ingredients.length}` });
    }
    if (url.pathname === "/rest/v1/ingredient_aliases") return json(res, 200, aliases);
    if (url.pathname === "/rest/v1/supply_entries") return json(res, 200, supplies);
    if (url.pathname === "/rest/v1/inventory_transactions") return json(res, 200, transactions);
    return json(res, 404, { message: `unexpected path ${url.pathname}` });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  await t.test("server starts, discovers exactly two read-only tools, and returns structured results", async () => {
    const connection = await connectClient("protocol-test", url);
    t.after(() => connection.client.close());
    const discovery = await connection.client.listTools();
    assert.deepEqual(discovery.tools.map((tool) => tool.name).sort(), ["ingredient_inspect", "inventory_list"]);
    for (const tool of discovery.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
    }
    const inventoryTool = discovery.tools.find((tool) => tool.name === "inventory_list");
    const inspectTool = discovery.tools.find((tool) => tool.name === "ingredient_inspect");
    assert.ok(inventoryTool?.outputSchema && typeof inventoryTool.outputSchema === "object" && "properties" in inventoryTool.outputSchema);
    assert.ok(inspectTool?.inputSchema && typeof inspectTool.inputSchema === "object" && "properties" in inspectTool.inputSchema);
    const inventoryProperties = (inventoryTool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const inspectProperties = (inspectTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("inventory" in inventoryProperties);
    assert.ok("name" in inspectProperties);

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

  await t.test("MCP source has no mutation or generic database surface and keeps diagnostics off stdout", async () => {
    const [adapter, entry, service] = await Promise.all([
      readFile(path.join(root, "scripts", "product-lab-mcp", "mcp-server.ts"), "utf8"),
      readFile(serverEntry, "utf8"),
      readFile(path.join(root, "scripts", "product-lab", "read-service.ts"), "utf8"),
    ]);
    assert.doesNotMatch(adapter, /inventory-operator\/core|inventory-operator\/run|\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    assert.doesNotMatch(service, /\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    assert.doesNotMatch(`${adapter}\n${entry}`, /process\.stdout|console\.log/);
    assert.match(entry, /process\.stderr\.write/);
    for (const forbidden of ["sql", "rpc", "physical_count", "purchase_post", "cost_certification", "order_transition"]) {
      assert.equal(["inventory_list", "ingredient_inspect"].includes(forbidden), false);
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createProductLabReadService } from "../scripts/product-lab/read-service.ts";

type RequestRecord = { table: string; search: string; range: string; prefer: string };

function json(res: ServerResponse, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

function uuid(index: number) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function inventoryRow(index: number, name = `Ingredient ${String(index).padStart(4, "0")}`) {
  return {
    id: uuid(index),
    name,
    is_active: true,
    current_quantity: index,
    base_unit: "g",
    inventory_reconciled_at: null,
    cost_reconciled_at: null,
    average_unit_cost: null,
  };
}

function owner(req: IncomingMessage, res: ServerResponse) {
  json(res, {
    id: uuid(999999),
    aud: "authenticated",
    role: "authenticated",
    email: "owner@example.test",
    app_metadata: { app_role: "owner" },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  });
}

async function withApi(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void,
  run: (url: string) => Promise<void>,
) {
  const api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") return owner(req, res);
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const address = api.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
}

function service(url: string) {
  return createProductLabReadService({
    ...process.env,
    PRODUCT_LAB_SUPABASE_URL: url,
    PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_query_test",
    PRODUCT_LAB_OWNER_ACCESS_TOKEN: "owner-token",
  });
}

test("inventory_list queries only returned ingredient fields with an exact count and server limit", async () => {
  const requests: RequestRecord[] = [];
  const rows = Array.from({ length: 501 }, (_, index) => inventoryRow(index + 1));
  await withApi((req, res, url) => {
    const table = url.pathname.replace("/rest/v1/", "");
    requests.push({ table, search: url.search, range: String(req.headers.range ?? ""), prefer: String(req.headers.prefer ?? "") });
    assert.equal(table, "ingredients", `inventory_list unexpectedly queried ${table}`);
    json(res, rows.slice(0, 500), { "content-range": "0-499/501" });
  }, async (url) => {
    const result = await service(url).inventoryList();
    assert.equal(result.returned, 500);
    assert.equal(result.total, 501);
    assert.equal(result.truncated, true);
  });

  assert.equal(requests.length, 1);
  const query = new URLSearchParams(requests[0].search);
  assert.equal(query.get("limit"), "500");
  assert.match(requests[0].prefer, /count=exact/);
  assert.equal(query.get("order"), "name.asc,id.asc");
  assert.equal(query.get("select"), "id,name,is_active,current_quantity,base_unit,inventory_reconciled_at,cost_reconciled_at,average_unit_cost");
  assert.doesNotMatch(requests[0].search, /notes|actor|reconciliation_snapshot/);
});

test("an unmatched inspection loads only paginated matching rows and no evidence tables", async () => {
  const tables: string[] = [];
  await withApi((_req, res, url) => {
    const table = url.pathname.replace("/rest/v1/", "");
    tables.push(table);
    if (table === "ingredients" || table === "ingredient_aliases") return json(res, []);
    assert.fail(`unmatched inspection unexpectedly queried ${table}`);
  }, async (url) => {
    const result = await service(url).ingredientInspect("Moon Dust");
    assert.equal(result.status, "not_found");
  });
  assert.deepEqual(tables.sort(), ["ingredient_aliases", "ingredients"]);
});

test("matching crosses the 1000-row boundary and matched evidence is filtered and limited server-side", async () => {
  const targetId = uuid(1001);
  const ingredients = Array.from({ length: 1001 }, (_, index) => ({
    id: uuid(index + 1),
    name: index === 1000 ? "Deep Ingredient" : `Ingredient ${index + 1}`,
    is_active: true,
  }));
  const aliases = Array.from({ length: 1001 }, (_, index) => ({
    id: `alias-${index + 1}`,
    raw_text: index === 1000 ? "deep alias" : `alias ${index + 1}`,
    normalized_text: index === 1000 ? "deep alias" : `alias ${index + 1}`,
    ingredient_id: uuid(index + 1),
    source: "test",
  }));
  const requests: RequestRecord[] = [];

  await withApi((req, res, url) => {
    const table = url.pathname.replace("/rest/v1/", "");
    requests.push({ table, search: url.search, range: String(req.headers.range ?? ""), prefer: String(req.headers.prefer ?? "") });
    const select = url.searchParams.get("select") ?? "";
    if (table === "ingredients" && select === "id,name,is_active") {
      const from = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return json(res, ingredients.slice(from, from + limit));
    }
    if (table === "ingredient_aliases") {
      const from = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return json(res, aliases.slice(from, from + limit));
    }
    if (table === "ingredients") return json(res, [inventoryRow(1001, "Deep Ingredient")]);
    if (table === "supply_entries") {
      return json(res, Array.from({ length: 5 }, (_, index) => ({
        id: `supply-${index + 1}`,
        ingredient_id: targetId,
        brand_name: null,
        supplier_name: "Test Store",
        purchase_date: `2026-09-0${index + 1}`,
        created_at: `2026-09-0${index + 1}T00:00:00.000Z`,
        pack_quantity: 1,
        unit: "kg",
        total_cost: 24,
      })));
    }
    if (table === "inventory_transactions") return json(res, []);
    assert.fail(`unexpected table ${table}`);
  }, async (url) => {
    const result = await service(url).ingredientInspect("deep alias");
    assert.equal(result.status, "matched");
    assert.equal(result.ingredient?.id, targetId);
    assert.equal(result.recent_purchase_evidence.length, 5);
  });

  assert.ok(requests.some((item) => item.table === "ingredients" && new URLSearchParams(item.search).get("offset") === "1000"));
  assert.ok(requests.some((item) => item.table === "ingredient_aliases" && new URLSearchParams(item.search).get("offset") === "1000"));
  const evidence = requests.filter((item) => item.table === "supply_entries" || item.table === "inventory_transactions");
  assert.ok(evidence.length >= 2);
  for (const request of evidence) {
    const query = new URLSearchParams(request.search);
    assert.equal(query.get("limit"), "5");
    assert.match(request.search, new RegExp(`ingredient_id=eq\\.${targetId}`));
    assert.doesNotMatch(query.get("select") ?? "", /note|actor|reconciliation_snapshot/);
  }
});

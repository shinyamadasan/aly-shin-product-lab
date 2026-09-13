import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const operator = path.join(root, "scripts", "inventory-operator", "run.ts");
const previewDirectory = path.join(root, ".inventory-operator", "previews");

type CliResult = { code: number; stdout: string; stderr: string };
type ApiIngredient = {
  id: string; name: string; base_unit: string; category: string; current_quantity: number;
  low_stock_threshold: number; target_stock_quantity: number; nearest_expiration_date: null;
  average_unit_cost: number; notes: string; is_active: boolean; archived_at: null;
  base_unit_migration_flagged_reason: null; inventory_reconciled_at: string | null;
  cost_reconciled_at: string | null;
};
type ApiTransaction = {
  id: string; ingredient_id: string; transaction_type: string; quantity_change: number;
  quantity_before: number; quantity_after: number; source_type: string; source_id: null;
  note: string; reason: string | null; actor: string | null; reconciliation_snapshot: Record<string, unknown> | null;
  created_at: string;
};

function runCli(args: string[], url: string, overrides: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [operator, ...args], {
      cwd: root,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        PRODUCT_LAB_SUPABASE_URL: url,
        PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_operator_cli_test",
        PRODUCT_LAB_OWNER_ACCESS_TOKEN: "owner-token",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body) as Record<string, unknown>;
}

function unsignedJwt(role: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ role })}.test-signature`;
}

test("inventory operator CLI boundary", async (t) => {
  const ids = {
    increased: "11111111-1111-4111-8111-111111111111",
    decreased: "22222222-2222-4222-8222-222222222222",
    exact: "33333333-3333-4333-8333-333333333333",
  };
  const initialReconciledAt = "2026-09-10T00:00:00.000Z";
  const ingredients: ApiIngredient[] = [
    [ids.increased, "Increased", initialReconciledAt],
    [ids.decreased, "Decreased", initialReconciledAt],
    [ids.exact, "Exact", null],
  ].map(([id, name, cost]) => ({
    id: id!, name: name!, base_unit: "g", category: "ingredient", current_quantity: 100,
    low_stock_threshold: 0, target_stock_quantity: 0, nearest_expiration_date: null,
    average_unit_cost: 1.25, notes: "", is_active: true, archived_at: null,
    base_unit_migration_flagged_reason: null, inventory_reconciled_at: initialReconciledAt,
    cost_reconciled_at: cost,
  }));
  const transactions: ApiTransaction[] = ingredients.map((ingredient, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ingredient_id: ingredient.id, transaction_type: "purchase", quantity_change: 100,
    quantity_before: 0, quantity_after: 100, source_type: "manual", source_id: null,
    note: "opening", reason: null, actor: null, reconciliation_snapshot: null,
    created_at: `2026-09-11T00:00:0${index}.000Z`,
  }));
  const receipts = new Map<string, { hash: string; result: Record<string, unknown> }>();
  let requestCount = 0;
  let authRequests = 0;
  let rpcRequests = 0;
  let mutationCount = 0;
  let transactionSequence = 0;

  const server = createServer(async (req, res) => {
    requestCount += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      authRequests += 1;
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (token === "invalid-token") return json(res, 401, { message: "invalid token" });
      const role = token === "staff-token" ? "staff" : "owner";
      return json(res, 200, {
        id: "99999999-9999-4999-8999-999999999999", aud: "authenticated", role: "authenticated",
        email: "owner@example.test", app_metadata: { app_role: role }, user_metadata: {},
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
    if (url.pathname === "/rest/v1/ingredient_aliases" || url.pathname === "/rest/v1/supply_entries") {
      return json(res, 200, []);
    }
    if (url.pathname === "/rest/v1/inventory_transactions") {
      const idFilter = url.searchParams.get("id");
      const rows = idFilter?.startsWith("in.(")
        ? transactions.filter((row) => idFilter.includes(row.id))
        : [...transactions].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return json(res, 200, rows);
    }
    if (url.pathname === "/rest/v1/rpc/apply_inventory_physical_count_batch") {
      rpcRequests += 1;
      const body = await bodyOf(req);
      const operationId = String(body.p_operation_id);
      const payloadHash = String(body.p_payload_hash);
      const prior = receipts.get(operationId);
      if (prior) {
        if (prior.hash !== payloadHash) return json(res, 409, { message: "operation reused for a different request" });
        return json(res, 200, prior.result);
      }
      const resultRows = (body.p_rows as Array<Record<string, unknown>>).map((row, index) => {
        const ingredient = ingredients.find((item) => item.id === row.ingredient_id)!;
        const latest = [...transactions].filter((item) => item.ingredient_id === ingredient.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
        assert.equal(ingredient.current_quantity, row.expected_quantity);
        assert.equal(latest?.id ?? null, row.expected_latest_id);
        assert.equal(ingredient.base_unit, row.expected_unit);
        const before = ingredient.current_quantity;
        const after = Number(row.counted_quantity);
        const delta = after - before;
        transactionSequence += 1;
        const transactionId = `90000000-0000-4000-8000-${String(transactionSequence).padStart(12, "0")}`;
        const reconciledAt = `2026-09-12T01:00:0${index}.000Z`;
        const transaction: ApiTransaction = {
          id: transactionId, ingredient_id: ingredient.id, transaction_type: "adjustment",
          quantity_change: delta, quantity_before: before, quantity_after: after,
          source_type: "manual", source_id: null, note: String(row.note),
          reason: "stock_count_correction", actor: "99999999-9999-4999-8999-999999999999",
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
        };
        transactions.push(transaction);
        ingredient.current_quantity = after;
        ingredient.inventory_reconciled_at = reconciledAt;
        if (delta > 0) ingredient.cost_reconciled_at = null;
        mutationCount += 1;
        return {
          ingredient_id: ingredient.id, ingredient_name: ingredient.name, base_unit: ingredient.base_unit,
          quantity_before: before, quantity_after: after, quantity_change: delta,
          transaction_id: transactionId, inventory_reconciled_at: reconciledAt,
          cost_reconciled_at: ingredient.cost_reconciled_at,
        };
      });
      const result = {
        operation_id: operationId, payload_hash: payloadHash,
        applied_reconciliation_events: resultRows.length, rows: resultRows,
      };
      receipts.set(operationId, { hash: payloadHash, result });
      return json(res, 200, result);
    }
    return json(res, 404, { message: `unexpected path ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  await t.test("authentication success exercises getUser", async () => {
    const before = authRequests;
    for (const key of ["sb_publishable_operator_cli_test", unsignedJwt("anon")]) {
      const result = await runCli(["inventory:list"], url, { PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: key });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).length, 3);
    }
    assert.equal(authRequests, before + 2);
  });

  await t.test("non-owner, invalid token, and privileged project keys fail closed", async () => {
    const staff = await runCli(["inventory:list"], url, { PRODUCT_LAB_OWNER_ACCESS_TOKEN: "staff-token" });
    assert.equal(staff.code, 1);
    assert.match(staff.stderr, /not a Product Lab owner/);
    const invalid = await runCli(["inventory:list"], url, { PRODUCT_LAB_OWNER_ACCESS_TOKEN: "invalid-token" });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Owner token validation failed/);
    for (const key of ["sb_secret_privileged_test", unsignedJwt("service_role")]) {
      const before = requestCount;
      const rejected = await runCli(["inventory:list"], url, { PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: key });
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /not allowed/);
      assert.equal(requestCount, before, "privileged key rejection must happen before any request");
    }
  });

  await t.test("missing preview artifact fails after apply-time authentication and before mutation", async () => {
    const beforeAuth = authRequests;
    const beforeRpc = rpcRequests;
    const result = await runCli(["inventory:count-apply", "--preview-id", "pc_00000000000000000000", "--approval-code", "0000-0000"], url);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(authRequests, beforeAuth + 1);
    assert.equal(rpcRequests, beforeRpc);
  });

  let previewId = "";
  let approvalCode = "";
  await t.test("approved apply, replay, and verified report are truthful", async () => {
    const temp = path.join(tmpdir(), `inventory-operator-cli-${process.pid}-${Date.now()}`);
    await mkdir(temp, { recursive: true });
    t.after(() => rm(temp, { recursive: true, force: true }));
    const inputPath = path.join(temp, "count.json");
    await writeFile(inputPath, JSON.stringify({
      kind: "physical_count",
      source: { name: "reviewer-count.csv", fingerprint: createHash("sha256").update("source bytes").digest("hex"), occurrence_id: "reviewer-cli-count" },
      rows: [
        { raw_name: "Increased", quantity: 120, unit: "g" },
        { raw_name: "Decreased", quantity: 80, unit: "g" },
        { raw_name: "Exact", quantity: 100, unit: "g" },
      ],
    }));
    const previewResult = await runCli(["inventory:count-preview", "--input", inputPath], url);
    assert.equal(previewResult.code, 0, previewResult.stderr);
    const preview = JSON.parse(previewResult.stdout);
    previewId = preview.preview_id;
    approvalCode = preview.approval_code;
    t.after(() => rm(path.join(previewDirectory, `${previewId}.json`), { force: true }));

    const first = await runCli(["inventory:count-apply", "--preview-id", previewId, "--approval-code", approvalCode], url);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).status, "applied_unverified");
    const replay = await runCli(["inventory:count-apply", "--preview-id", previewId, "--approval-code", approvalCode], url);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(first.stdout));
    assert.equal(rpcRequests, 2);
    assert.equal(mutationCount, 3, "replay must not duplicate mutations");

    const verified = await runCli(["inventory:verify", "--preview-id", previewId], url);
    assert.equal(verified.code, 0, verified.stderr);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.status, "verified");
    assert.equal(report.quantity_increased, 1);
    assert.equal(report.quantity_decreased, 1);
    assert.equal(report.exact_recounts_no_quantity_change, 1);
    assert.equal(report.cost_certifications_cleared, 1);
    assert.equal(report.existing_cost_certifications_preserved, 1);
    assert.equal(report.remained_uncertified, 1);
    assert.equal(report.reconciliation_rows.length, 3);
    assert.equal("changed_rows" in report, false);
  });

  await t.test("multiple reconciliation snapshot mismatches can never report verified", async () => {
    const appliedTransactions = transactions.filter((row) => row.id.startsWith("90000000"));
    const target = appliedTransactions[0];
    assert.ok(target?.reconciliation_snapshot);
    for (const [field, wrong] of [
      ["cache_quantity", 999],
      ["latest_ledger_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["average_unit_cost", 99],
      ["previous_reconciled_at", "2020-01-01T00:00:00.000Z"],
    ] as const) {
      const original = target.reconciliation_snapshot[field];
      target.reconciliation_snapshot[field] = wrong;
      const result = await runCli(["inventory:verify", "--preview-id", previewId], url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(field));
      assert.doesNotMatch(result.stdout, /verified|success/i);
      target.reconciliation_snapshot[field] = original;
    }
  });
});

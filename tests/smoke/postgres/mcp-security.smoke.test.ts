import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../../../workers/product-lab-mcp/index.ts";
import * as nextRoute from "../../../src/app/api/mcp/route.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "pipe" });
  else child.kill("SIGTERM");
}

test("MCP approval and input security against disposable PostgreSQL/PostgREST", {
  skip: process.env.RUN_POSTGRES_SMOKE !== "1", timeout: 180_000,
}, async (t) => {
  const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "aly-mcp-security-")), "state.json");
  let logs = "";
  const backend = spawn(process.execPath, ["tests/smoke/browser/financial-release-2.backend.mjs", stateFile], { cwd: root, stdio: "pipe" });
  backend.stdout.on("data", (data) => { logs += data; });
  backend.stderr.on("data", (data) => { logs += data; });
  t.after(() => {
    stop(backend);
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      execFileSync("docker", ["rm", "-f", state.REST, state.PG], { stdio: "pipe" });
      execFileSync("docker", ["network", "rm", state.NET], { stdio: "pipe" });
    }
  });
  for (let attempt = 0; attempt < 160 && !existsSync(stateFile) && backend.exitCode === null; attempt++) await delay();
  assert.ok(existsSync(stateFile), `Disposable backend must start: ${logs}`);
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.match(state.PG, /^finqa\d+-pg$/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", state.PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" }).trim();
  // This fixture has no Auth server tables; create only the owner referenced by the real preview RLS.
  sql(`create table auth.users (id uuid primary key); insert into auth.users values ('${state.ownerSub}');`);
  sql(readFileSync(path.join(root, "supabase/migrations/20260915203210_add_inventory_base_unit_migration_markers.sql"), "utf8"));
  sql(readFileSync(path.join(root, "supabase/migrations/20260914120000_product_lab_mcp_durable_previews.sql"), "utf8"));
  await delay();
  const supabaseUrl = `http://127.0.0.1:${state.shimPort}`;
  const session = await (await fetch(`${supabaseUrl}/auth/v1/token`, { method: "POST" })).json() as { access_token: string };
  const bindings = {
    PRODUCT_LAB_SUPABASE_URL: supabaseUrl,
    PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_disposable_test",
    PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: "127.0.0.1",
  };
  const oldEnv = Object.fromEntries(Object.keys(bindings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, bindings);
  t.after(() => { for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const adapters = [
    { name: "Netlify route", url: "http://127.0.0.1/api/mcp", call: nextRoute.POST },
    { name: "Worker adapter", url: "http://127.0.0.1/api/mcp", call: (request: Request) => worker.fetch(request, bindings) },
  ];
  if (process.env.RUN_WORKER_SMOKE === "1") {
    const local = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "wrangler.product-lab-mcp.jsonc", "--local", "--ip", "127.0.0.1", "--port", "18787", "--inspector-port", "0", "--show-interactive-dev-session", "false", ...Object.entries(bindings).flatMap(([key, value]) => ["--var", `${key}:${value}`])], {
      cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let workerLogs = "";
    local.stdout.on("data", (data) => { workerLogs += data; });
    local.stderr.on("data", (data) => { workerLogs += data; });
    t.after(() => stop(local));
    const url = "http://127.0.0.1:18787/api/mcp";
    let ready = false;
    for (let attempt = 0; attempt < 100 && local.exitCode === null; attempt++) {
      try { if ((await fetch(url)).status === 401) { ready = true; break; } } catch { /* starting */ }
      await delay();
    }
    assert.ok(ready, `Local workerd must start: ${workerLogs}`);
    adapters.push({ name: "local workerd", url, call: (request: Request) => fetch(request) });
  }
  for (const adapter of adapters) await t.test(adapter.name, async () => {
    const before = Number(sql(`select current_quantity from ingredients where id='${state.flour}'`));
    const historyBefore = Number(sql("select count(*) from inventory_transactions"));
    const client = new Client({ name: "disposable-count-security", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url), {
      authProvider: { token: async () => session.access_token },
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", new URL(adapter.url).host);
        return adapter.call(new Request(input, { ...init, headers }));
      },
    }));
    try {
      const complex = await client.callTool({ name: "inventory_list", arguments: { extra: Array(5000).fill(null) } });
      assert.equal(complex.isError, true);
      assert.match(JSON.stringify(complex.content), /maximum of 5000 elements/);
      const bodyRejected = await adapter.call(new Request(adapter.url, {
        method: "POST", headers: { host: new URL(adapter.url).host, authorization: `Bearer ${session.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", extra: "x".repeat(262144) }),
      }));
      assert.equal(bodyRejected.status, 413);
      const preview = await client.callTool({ name: "inventory_count_preview", arguments: {
        kind: "physical_count", source: { name: "disposable-owner-message", fingerprint: "f".repeat(64), occurrence_id: adapter.name },
        rows: [{ raw_name: "Flour", quantity: before + 1, unit: "g" }],
      } });
      assert.equal(preview.isError, undefined, JSON.stringify(preview));
      const { preview_id, approval_code } = preview.structuredContent as { preview_id: string; approval_code: string };
      const stored = { preview_id, approval_code };
      const invalid = await client.callTool({ name: "inventory_count_apply", arguments: { preview_id: stored.preview_id, approval_code: "INVALID" } });
      assert.equal(invalid.isError, true);
      assert.equal(Number(sql("select count(*) from inventory_transactions")), historyBefore);
      assert.equal(Number(sql(`select current_quantity from ingredients where id='${state.flour}'`)), before);
      const applied = await client.callTool({ name: "inventory_count_apply", arguments: stored });
      // Only the stored preview reference and matching owner approval code cross the mutation boundary.
      assert.equal(applied.isError, undefined, JSON.stringify(applied));
      const verified = await client.callTool({ name: "inventory_count_verify", arguments: { preview_id: stored.preview_id } });
      assert.equal(verified.isError, undefined, JSON.stringify(verified));
      assert.equal((verified.structuredContent as { status: string }).status, "verified");
      const replay = await client.callTool({ name: "inventory_count_apply", arguments: stored });
      assert.equal(replay.isError, undefined, JSON.stringify(replay));
      assert.equal(Number(sql("select count(*) from inventory_transactions")), historyBefore + 1);
      assert.equal(Number(sql(`select current_quantity from ingredients where id='${state.flour}'`)), before + 1);
    } finally { await client.close(); }
  });
});

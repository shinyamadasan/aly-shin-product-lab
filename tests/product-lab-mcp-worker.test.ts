import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../workers/product-lab-mcp/index.ts";

// TASK-073 -- the Cloudflare Worker is a transport/hosting move only. These tests drive the Worker's
// real `fetch` handler (the same function workerd runs) against a fake Supabase project, and read the
// source/config to prove the structural claims (one shared handler, no filesystem in the remote import
// graph, no privileged key, stdio untouched). The in-workerd runtime itself is covered by the
// `wrangler dev` smoke recorded in docs/PRODUCT_LAB_MCP.md, which a Node test cannot run.
const root = path.resolve(import.meta.dirname, "..");

const WORKER_HOSTNAME = "alyandpon-product-lab-mcp.example.workers.dev";
const OWNER_ID = "99999999-9999-4999-8999-999999999999";
const SALT_ID = "11111111-1111-4111-8111-111111111111";
const FIVE_TOOLS = [
  "ingredient_inspect",
  "inventory_count_apply",
  "inventory_count_preview",
  "inventory_count_verify",
  "inventory_list",
];

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

type FakeSupabase = {
  url: string;
  authChecks: () => number;
  previewWrites: Array<Record<string, unknown>>;
  applyRpcCalls: () => number;
  close: () => Promise<void>;
};

async function startFakeSupabase(): Promise<FakeSupabase> {
  let authChecks = 0;
  let applyRpcCalls = 0;
  const previewWrites: Array<Record<string, unknown>> = [];
  let baseUrl = "";
  const api = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (url.pathname === "/auth/v1/user") {
        authChecks += 1;
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        if (!token || token === "invalid-token") return json(res, 401, { message: "invalid token" });
        return json(res, 200, {
          id: OWNER_ID,
          aud: "authenticated",
          role: "authenticated",
          email: "owner@example.test",
          app_metadata: { app_role: token === "staff-token" ? "staff" : "owner" },
          user_metadata: {},
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname === "/rest/v1/ingredients") {
        return json(res, 200, [{
          id: SALT_ID,
          name: "MC Sea Salt",
          is_active: true,
          current_quantity: 4700,
          base_unit: "g",
          inventory_reconciled_at: "2026-09-12T01:00:00.000Z",
          cost_reconciled_at: null,
          average_unit_cost: null,
        }], { "content-range": "0-0/1" });
      }
      if (url.pathname === "/rest/v1/product_lab_mcp_previews") {
        if (req.method === "POST") {
          previewWrites.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          res.writeHead(201);
          return res.end();
        }
        return json(res, 200, []);
      }
      if (url.pathname === "/rest/v1/rpc/apply_inventory_physical_count_batch") {
        applyRpcCalls += 1;
        return json(res, 200, {});
      }
      if (url.pathname.startsWith("/rest/v1/")) return json(res, 200, []);
      if (url.pathname === "/.well-known/oauth-authorization-server/auth/v1") {
        return json(res, 200, {
          issuer: `${baseUrl}/auth/v1`,
          authorization_endpoint: `${baseUrl}/oauth/consent`,
          token_endpoint: `${baseUrl}/auth/v1/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      return json(res, 404, { message: `unexpected path ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    authChecks: () => authChecks,
    previewWrites,
    applyRpcCalls: () => applyRpcCalls,
    close: () => new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve()))),
  };
}

// A real transport sets Host before application code runs; a hand-built Request does not.
function requestFor(input: string | URL, init?: RequestInit): Request {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  return new Request(url, { ...init, headers });
}

const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const JSON_HEADERS = { "content-type": "application/json" };

test("Product Lab MCP Cloudflare Worker transport (TASK-073)", async (t) => {
  const supabase = await startFakeSupabase();
  t.after(() => supabase.close());

  const bindings = {
    PRODUCT_LAB_SUPABASE_URL: supabase.url,
    PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_worker_test",
    PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: WORKER_HOSTNAME,
  };
  const mcpUrl = `https://${WORKER_HOSTNAME}/api/mcp`;
  const call = (request: Request, env: Record<string, unknown> = bindings) => worker.fetch(request, env);

  async function connect(token: string, env: Record<string, unknown> = bindings) {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      authProvider: { token: async () => token },
      fetch: (input, init) => call(requestFor(input as string | URL, init), env),
    });
    const client = new Client({ name: "worker-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  await t.test("an unknown route is 404", async () => {
    for (const pathname of ["/", "/nope", "/api/mcp/extra", "/api/mcp/", "/.well-known/other", "/.well-known/oauth-protected-resource"]) {
      const response = await call(requestFor(`https://${WORKER_HOSTNAME}${pathname}`));
      assert.equal(response.status, 404, pathname);
    }
  });

  await t.test("a wrong method on a known route is 405 with an Allow header", async () => {
    for (const method of ["PUT", "PATCH", "OPTIONS"]) {
      const response = await call(requestFor(mcpUrl, { method }));
      assert.equal(response.status, 405, `${method} /api/mcp`);
      assert.equal(response.headers.get("allow"), "GET, POST, DELETE");
    }
    for (const pathname of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-authorization-server"]) {
      const response = await call(requestFor(`https://${WORKER_HOSTNAME}${pathname}`, { method: "POST" }));
      assert.equal(response.status, 405, `POST ${pathname}`);
      assert.equal(response.headers.get("allow"), "GET");
    }
  });

  await t.test("a missing bearer token gets the OAuth 401 challenge naming the Worker's own discovery document", async () => {
    const response = await call(requestFor(mcpUrl, { method: "POST", headers: JSON_HEADERS, body: TOOLS_LIST }));
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.ok(challenge.startsWith("Bearer"));
    assert.ok(challenge.includes(`resource_metadata="https://${WORKER_HOSTNAME}/.well-known/oauth-protected-resource/api/mcp"`));
  });

  await t.test("an invalid Host or Origin is refused BEFORE any token reaches Supabase", async () => {
    const before = supabase.authChecks();
    const badHost = await call(requestFor(mcpUrl, {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: "Bearer owner-token", host: "attacker.example" },
      body: TOOLS_LIST,
    }));
    assert.equal(badHost.status, 403);
    const badOrigin = await call(requestFor(mcpUrl, {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: "Bearer owner-token", origin: "https://attacker.example" },
      body: TOOLS_LIST,
    }));
    assert.equal(badOrigin.status, 403);
    assert.equal(supabase.authChecks(), before, "a rejected Host/Origin must never trigger a Supabase auth round trip");
  });

  await t.test("the Worker fails CLOSED: with no configured hostname even localhost is refused, and stray bindings cannot widen the allowlist", async () => {
    const withoutHostname = { ...bindings, PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: undefined };
    const localhost = await call(requestFor("http://localhost/api/mcp", {
      method: "POST",
      headers: JSON_HEADERS,
      body: TOOLS_LIST,
    }), withoutHostname);
    assert.equal(localhost.status, 403, "NODE_ENV is forced to production inside the Worker; localhost must not be trusted");

    const strayBindings = { ...withoutHostname, VERCEL_URL: "stray.example", URL: "https://stray2.example", NODE_ENV: "development" };
    for (const host of ["stray.example", "stray2.example", "localhost"]) {
      const response = await call(requestFor(`https://${host}/api/mcp`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: TOOLS_LIST,
      }), strayBindings);
      assert.equal(response.status, 403, host);
    }
  });

  await t.test("the canonical resource URL is the configured Worker hostname, in both the challenge and discovery", async () => {
    const discovery = await call(requestFor(`https://${WORKER_HOSTNAME}/.well-known/oauth-protected-resource/api/mcp`));
    assert.equal(discovery.status, 200);
    const body = await discovery.json() as { resource: string; resource_name: string };
    assert.equal(body.resource, mcpUrl);
    assert.equal(body.resource_name, "Product Lab MCP");

    // An attacker-controlled forwarded host cannot move it.
    const spoofed = await call(requestFor(`https://${WORKER_HOSTNAME}/.well-known/oauth-protected-resource/api/mcp`, {
      headers: { "x-forwarded-host": "attacker.example" },
    }));
    assert.equal(((await spoofed.json()) as { resource: string }).resource, mcpUrl);

    const challenge = await call(requestFor(mcpUrl, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-forwarded-host": "attacker.example" },
      body: TOOLS_LIST,
    }));
    assert.equal(challenge.status, 401);
    assert.ok(!(challenge.headers.get("www-authenticate") ?? "").includes("attacker.example"));
  });

  await t.test("Protected Resource Metadata names Supabase as the authorization server", async () => {
    const response = await call(requestFor(`https://${WORKER_HOSTNAME}/.well-known/oauth-protected-resource/api/mcp`));
    const body = await response.json() as { authorization_servers: string[] };
    assert.deepEqual(body.authorization_servers, [`${supabase.url}/auth/v1`]);
  });

  await t.test("authorization-server metadata is Supabase's own document, not a Worker-issued one", async () => {
    const response = await call(requestFor(`https://${WORKER_HOSTNAME}/.well-known/oauth-authorization-server`));
    assert.equal(response.status, 200);
    const body = await response.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string };
    assert.equal(body.issuer, `${supabase.url}/auth/v1`);
    assert.equal(body.token_endpoint, `${supabase.url}/auth/v1/oauth/token`);
    assert.equal(body.authorization_endpoint, `${supabase.url}/oauth/consent`);
  });

  await t.test("a missing configuration is a 500 configuration error, never a crash or an open endpoint", async () => {
    const response = await call(requestFor(mcpUrl, { method: "POST", headers: JSON_HEADERS, body: TOOLS_LIST }), {});
    assert.equal(response.status, 500);
    const discovery = await call(requestFor(`https://${WORKER_HOSTNAME}/.well-known/oauth-authorization-server`), {});
    assert.equal(discovery.status, 500);
  });

  await t.test("a privileged Supabase key supplied to the Worker is refused rather than used", async () => {
    const serviceRoleJwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"),
      "signature",
    ].join(".");
    for (const key of ["sb_secret_not_a_real_key", serviceRoleJwt]) {
      const before = supabase.authChecks();
      const response = await call(
        requestFor(mcpUrl, { method: "POST", headers: { ...JSON_HEADERS, authorization: "Bearer owner-token" }, body: TOOLS_LIST }),
        { ...bindings, PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: key },
      );
      assert.equal(response.status, 500);
      assert.equal(supabase.authChecks(), before);
    }
  });

  await t.test("a verified owner lists exactly the five tools and reads through request-scoped auth", async (subtest) => {
    const client = await connect("owner-token");
    subtest.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), FIVE_TOOLS);
    const inventory = await client.callTool({ name: "inventory_list", arguments: {} });
    assert.equal(inventory.isError, undefined);
    assert.equal((inventory.structuredContent as { returned: number }).returned, 1);
    await assert.rejects(() => client.callTool({ name: "delete_everything", arguments: {} }));
  });

  await t.test("a non-owner session is refused", async () => {
    await assert.rejects(() => connect("staff-token"));
  });

  await t.test("a remote preview is persisted in Supabase, and apply without a stored preview never reaches the mutation RPC", async (subtest) => {
    const client = await connect("owner-token");
    subtest.after(() => client.close());
    const preview = await client.callTool({
      name: "inventory_count_preview",
      arguments: {
        kind: "physical_count",
        source: { name: "owner-message-worker", fingerprint: "a".repeat(64), occurrence_id: "worker-count-01" },
        rows: [{ raw_name: "sea salt", quantity: 4.8, unit: "kg" }],
      },
    });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    assert.equal(supabase.previewWrites.length, 1, "the preview must be written to the Supabase durable store");
    assert.equal(supabase.previewWrites[0].preview_id, (preview.structuredContent as { preview_id: string }).preview_id);
    assert.equal(supabase.previewWrites[0].owner_id, undefined, "owner_id is database-owned (auth.uid()), never client-supplied");

    const apply = await client.callTool({
      name: "inventory_count_apply",
      arguments: { preview_id: "pc_00000000000000000000", approval_code: "WRONG-CODE" },
    });
    assert.equal(apply.isError, true);
    assert.equal(supabase.applyRpcCalls(), 0, "no apply RPC without a stored, approved preview");
  });

  await t.test("the Next.js /api/mcp rollback route still serves the same five tools through the same shared handler", async (subtest) => {
    const previous = {
      url: process.env.PRODUCT_LAB_SUPABASE_URL,
      key: process.env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY,
      host: process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME,
    };
    process.env.PRODUCT_LAB_SUPABASE_URL = supabase.url;
    process.env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_worker_test";
    process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = "localhost";
    subtest.after(() => {
      for (const [name, value] of [
        ["PRODUCT_LAB_SUPABASE_URL", previous.url],
        ["PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY", previous.key],
        ["PRODUCT_LAB_MCP_PUBLIC_HOSTNAME", previous.host],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const nextRoute = await import("../src/app/api/mcp/route.ts");
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      authProvider: { token: async () => "owner-token" },
      fetch: (input, init) => nextRoute.POST(requestFor(input as string | URL, init)),
    });
    const client = new Client({ name: "rollback-test", version: "1.0.0" });
    await client.connect(transport);
    subtest.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), FIVE_TOOLS);
  });
});

// ---- structural claims -------------------------------------------------------------------------

async function read(...segments: string[]): Promise<string> {
  return readFile(path.join(root, ...segments), "utf8");
}

// Relative TypeScript imports only: the transitive set of project files a module pulls in.
async function projectImportGraph(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [path.resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const source = await readFile(file, "utf8");
    seen.set(file, source);
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+\.ts)["']/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  return seen;
}

test("Product Lab MCP Worker structure (TASK-073)", async (t) => {
  await t.test("the Worker and the Next.js route are thin adapters over ONE shared handler and ONE tool registry", async () => {
    const [workerSource, nextMcp, nextDiscovery, handler, discovery] = await Promise.all([
      read("workers", "product-lab-mcp", "index.ts"),
      read("src", "app", "api", "mcp", "route.ts"),
      read("src", "app", ".well-known", "[...path]", "route.ts"),
      read("scripts", "product-lab-mcp", "http-handler.ts"),
      read("scripts", "product-lab-mcp", "oauth-discovery.ts"),
    ]);
    assert.match(workerSource, /scripts\/product-lab-mcp\/http-handler\.ts/);
    assert.match(nextMcp, /scripts\/product-lab-mcp\/http-handler\.ts/);
    assert.match(workerSource, /scripts\/product-lab-mcp\/oauth-discovery\.ts/);
    assert.match(nextDiscovery, /scripts\/product-lab-mcp\/oauth-discovery\.ts/);
    // The one place the tool registry is built for a remote request:
    assert.match(handler, /createProductLabMcpServer/);
    assert.match(handler, /createInventoryCountServiceForClient/);
    assert.match(handler, /requireBearerAuth/);
    assert.match(discovery, /oauthMetadataResponse/);
    // Neither adapter, nor the Worker, may carry its own registry, auth gate or token logic.
    for (const adapter of [workerSource, nextMcp, nextDiscovery]) {
      assert.doesNotMatch(adapter, /registerTool|createProductLabMcpServer|requireBearerAuth|verifyAccessToken|createMcpHandler|\.rpc\(/);
    }
    const registry = await read("scripts", "product-lab-mcp", "mcp-server.ts");
    assert.equal((registry.match(/registerTool\(/g) ?? []).length, 5);
  });

  await t.test("the remote import graph contains no local-filesystem code, so remote previews can only be Supabase-backed", async () => {
    const graph = await projectImportGraph("workers/product-lab-mcp/index.ts");
    const files = [...graph.keys()].map((file) => path.relative(root, file).replaceAll("\\", "/"));
    assert.ok(files.includes("scripts/product-lab/inventory-count-service.ts"));
    assert.ok(files.includes("scripts/product-lab-mcp/mcp-server.ts"));
    assert.ok(!files.includes("scripts/product-lab/inventory-count-service-local.ts"));
    for (const [file, source] of graph) {
      assert.doesNotMatch(source, /node:fs|node:path|node:url|import\.meta\.url|createInventoryCountArtifactStore/, path.relative(root, file));
    }
    // And the shared service still ships only the durable store.
    const service = await read("scripts", "product-lab", "inventory-count-service.ts");
    assert.match(service, /createDurableInventoryCountArtifactStore/);
  });

  await t.test("local stdio keeps its filesystem store and its environment-token configuration unchanged", async () => {
    const [stdio, local, mcpConfig] = await Promise.all([
      read("scripts", "product-lab-mcp", "server.ts"),
      read("scripts", "product-lab", "inventory-count-service-local.ts"),
      read(".mcp.json"),
    ]);
    assert.match(stdio, /inventory-count-service-local\.ts/);
    assert.match(stdio, /serveStdio/);
    assert.match(local, /node:fs\/promises/);
    assert.match(local, /\.inventory-operator/);
    assert.deepEqual(JSON.parse(mcpConfig), {
      mcpServers: {
        product_lab: {
          type: "stdio",
          command: "node",
          args: ["${CLAUDE_PROJECT_DIR:-.}/scripts/product-lab-mcp/server.ts"],
          env: {
            PRODUCT_LAB_SUPABASE_URL: "${PRODUCT_LAB_SUPABASE_URL}",
            PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "${PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY}",
            PRODUCT_LAB_OWNER_ACCESS_TOKEN: "${PRODUCT_LAB_OWNER_ACCESS_TOKEN}",
          },
        },
      },
    });
  });

  await t.test("no service-role or Supabase secret key is introduced, and no production values are committed", async () => {
    const [workerSource, handler, discovery, wrangler] = await Promise.all([
      read("workers", "product-lab-mcp", "index.ts"),
      read("scripts", "product-lab-mcp", "http-handler.ts"),
      read("scripts", "product-lab-mcp", "oauth-discovery.ts"),
      read("wrangler.product-lab-mcp.jsonc"),
    ]);
    // (scripts/inventory-operator/credentials.ts names service_role only to REJECT it, so it is not scanned.)
    for (const [name, source] of Object.entries({ workerSource, handler, discovery, wrangler })) {
      assert.doesNotMatch(source, /service_role|SERVICE_ROLE|sb_secret_|SUPABASE_SECRET/i, name);
    }
    const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
    assert.equal(config.name, "alyandpon-product-lab-mcp");
    assert.equal(config.main, "workers/product-lab-mcp/index.ts");
    assert.equal(config.compatibility_date, "2026-10-05");
    assert.equal(config.workers_dev, true);
    assert.equal(config.vars, undefined, "required values are secrets/dashboard variables, never committed vars");
    assert.equal(config.compatibility_flags, undefined, "nodejs_compat is on by default for this compatibility date");
    assert.doesNotMatch(wrangler, /https?:\/\/[a-z0-9-]+\.supabase\.co/);
  });
});

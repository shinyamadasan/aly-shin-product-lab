import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { authenticateProductLabRequest, ProductLabError, type ProductLabProjectConfig } from "../scripts/product-lab/auth.ts";
import { createProductLabOAuthTokenVerifier, ownerContextFromAuthInfo } from "../scripts/product-lab-mcp/remote-auth.ts";

const root = path.resolve(import.meta.dirname, "..");

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

// A real deployed server sees a Host header populated by the actual incoming HTTP connection, before
// the request ever reaches application code -- Next.js builds the Request it hands to a route
// handler FROM that real connection. Constructing a Request directly in a test bypasses that network
// layer entirely, so the Host header a real client's request would always carry has to be added back
// here, exactly as a genuine transport would set it, or the route's Host-validation gate (correctly)
// rejects every request in this file for "Missing Host header" regardless of what is being tested.
function requestFor(input: string | URL, init?: RequestInit): Request {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  return new Request(url, { ...init, headers });
}

const OWNER_ID = "99999999-9999-4999-8999-999999999999";
const SALT_ID = "11111111-1111-4111-8111-111111111111";

// A minimal fake Supabase project: Auth (/auth/v1/user), REST (/rest/v1/*), and the RFC 8414
// Authorization Server metadata Supabase's OAuth 2.1 Server exposes
// (/.well-known/oauth-authorization-server/auth/v1). Mirrors the fixture style already used by
// tests/product-lab-mcp.test.ts for the stdio path.
async function startFakeSupabase() {
  const ingredients = [{
    id: SALT_ID,
    name: "MC Sea Salt",
    is_active: true,
    current_quantity: 4700,
    base_unit: "g",
    inventory_reconciled_at: "2026-09-12T01:00:00.000Z",
    cost_reconciled_at: null,
    average_unit_cost: null,
  }];
  const api = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token || token === "invalid-token" || token === "expired-token") {
        return json(res, 401, { message: "invalid token" });
      }
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
      return json(res, 200, ingredients, { "content-range": `0-${ingredients.length - 1}/${ingredients.length}` });
    }
    if (url.pathname === "/rest/v1/ingredient_aliases") {
      return json(res, 200, []);
    }
    if (url.pathname === "/rest/v1/supply_entries" || url.pathname === "/rest/v1/inventory_transactions") {
      return json(res, 200, []);
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth/v1") {
      return json(res, 200, {
        issuer: "http://127.0.0.1:0/auth/v1",
        authorization_endpoint: "http://127.0.0.1:0/oauth/consent",
        token_endpoint: "http://127.0.0.1:0/auth/v1/oauth/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    return json(res, 404, { message: `unexpected path ${url.pathname}` });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  return { server: api, url: `http://127.0.0.1:${address.port}` };
}

test("Product Lab MCP owner authentication (Slice 2.1A)", async (t) => {
  const { server, url } = await startFakeSupabase();
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const config: ProductLabProjectConfig = { url, publishableKey: "sb_publishable_mcp_test" };

  await t.test("missing token is refused", async () => {
    await assert.rejects(
      () => authenticateProductLabRequest(config, undefined),
      (error: unknown) => error instanceof ProductLabError && error.code === "authentication_failed",
    );
  });

  await t.test("malformed / empty token is refused", async () => {
    await assert.rejects(
      () => authenticateProductLabRequest(config, "   "),
      (error: unknown) => error instanceof ProductLabError && error.code === "authentication_failed",
    );
  });

  await t.test("invalid / expired token is refused", async () => {
    await assert.rejects(
      () => authenticateProductLabRequest(config, "invalid-token"),
      (error: unknown) => error instanceof ProductLabError && error.code === "authentication_failed",
    );
    await assert.rejects(
      () => authenticateProductLabRequest(config, "expired-token"),
      (error: unknown) => error instanceof ProductLabError && error.code === "authentication_failed",
    );
  });

  await t.test("authenticated non-owner is refused", async () => {
    await assert.rejects(
      () => authenticateProductLabRequest(config, "staff-token"),
      (error: unknown) => error instanceof ProductLabError && error.code === "authorization_failed",
    );
  });

  await t.test("valid owner token is accepted and scoped to that owner", async () => {
    const context = await authenticateProductLabRequest(config, "owner-token");
    assert.equal(context.ownerId, OWNER_ID);
    assert.equal(context.ownerEmail, "owner@example.test");
    assert.ok(context.client);
  });

  await t.test("the OAuth token verifier maps the same decisions onto MCP AuthInfo without a second round trip's worth of authorization logic", async () => {
    const verifier = createProductLabOAuthTokenVerifier(config);
    const authInfo = await verifier.verifyAccessToken("owner-token");
    assert.equal(authInfo.token, "owner-token");
    assert.ok(Array.isArray(authInfo.scopes));
    assert.equal(typeof authInfo.expiresAt, "number");
    const context = ownerContextFromAuthInfo(authInfo);
    assert.equal(context.ownerId, OWNER_ID);

    await assert.rejects(() => verifier.verifyAccessToken("invalid-token"), /Product Lab owner authentication failed/);
    await assert.rejects(() => verifier.verifyAccessToken("staff-token"), /Product Lab owner authentication failed/);
  });

  await t.test("a factory invoked without verified AuthInfo fails closed rather than falling back to any default identity", () => {
    assert.throws(
      () => ownerContextFromAuthInfo(undefined),
      (error: unknown) => error instanceof ProductLabError && error.code === "authentication_failed",
    );
  });
});

test("Product Lab remote MCP endpoint (Slice 2.1A)", async (t) => {
  const { server, url } = await startFakeSupabase();
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  process.env.PRODUCT_LAB_SUPABASE_URL = url;
  process.env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mcp_test";
  delete process.env.PRODUCT_LAB_OWNER_ACCESS_TOKEN;

  const mcpRoute = await import("../src/app/api/mcp/route.ts");
  const wellKnown = await import("../src/app/.well-known/[...path]/route.ts");

  async function connect(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      authProvider: { token: async () => token },
      fetch: (input, init) => mcpRoute.POST(requestFor(input as string | URL, init)),
    });
    const client = new Client({ name: "remote-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  await t.test("an unauthenticated request is rejected before reaching any tool", async () => {
    const response = await mcpRoute.POST(requestFor("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate")?.includes("Bearer"));
  });

  await t.test("a valid non-owner OAuth session is rejected", async () => {
    await assert.rejects(() => connect("staff-token"));
  });

  await t.test("a random unauthenticated internet request never reaches the tool registry", async () => {
    const response = await mcpRoute.POST(requestFor("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inventory_count_apply", arguments: {} } }),
    }));
    assert.equal(response.status, 401);
  });

  await t.test("a request naming a Host outside the allowlist is refused even with a valid owner token", async () => {
    const response = await mcpRoute.POST(requestFor("http://attacker.example/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-token",
        host: "attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    assert.notEqual(response.status, 200);
    assert.ok(response.status === 400 || response.status === 421 || response.status === 403);
  });

  await t.test("a request carrying a disallowed Origin header is refused even with a valid owner token", async () => {
    const response = await mcpRoute.POST(requestFor("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-token",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    assert.notEqual(response.status, 200);
  });

  await t.test("a request with no Origin header (the normal shape for non-browser MCP clients) is not refused by Origin validation", async () => {
    // Confirms Host/Origin hardening does not break the legitimate MCP client path exercised by
    // every other test in this file -- `connect()` below never sends an Origin header either, and
    // already proves the full authenticated flow still works end to end.
    const client = await connect("owner-token");
    const discovery = await client.listTools();
    assert.equal(discovery.tools.length, 5);
    await client.close();
  });

  await t.test("a verified owner session lists exactly the five approved tools and reads through request-scoped auth", async (subtest) => {
    const client = await connect("owner-token");
    subtest.after(() => client.close());

    const discovery = await client.listTools();
    assert.deepEqual(discovery.tools.map((tool) => tool.name).sort(), [
      "ingredient_inspect",
      "inventory_count_apply",
      "inventory_count_preview",
      "inventory_count_verify",
      "inventory_list",
    ]);

    const inventory = await client.callTool({ name: "inventory_list", arguments: {} });
    assert.equal(inventory.isError, undefined);
    assert.deepEqual(inventory.structuredContent, {
      inventory: [{
        id: SALT_ID,
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

    const inspected = await client.callTool({ name: "ingredient_inspect", arguments: { name: "MC Sea Salt" } });
    assert.equal(inspected.isError, undefined);
    assert.equal((inspected.structuredContent as { status: string }).status, "matched");
  });

  await t.test("calling a nonexistent tool has no effect and returns a protocol error, not a crash", async (subtest) => {
    const client = await connect("owner-token");
    subtest.after(() => client.close());
    await assert.rejects(() => client.callTool({ name: "delete_everything", arguments: {} }));
  });

  await t.test("RFC 9728 protected-resource metadata names Supabase as the authorization server", async () => {
    const response = await wellKnown.GET(new Request("http://mcp.test/.well-known/oauth-protected-resource/api/mcp"));
    assert.equal(response.status, 200);
    const body = await response.json() as { resource: string; authorization_servers: string[] };
    assert.ok(body.resource.endsWith("/api/mcp"));
    assert.ok(Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0);
  });

  await t.test("RFC 8414 authorization-server metadata mirrors Supabase's own discovery document", async () => {
    const response = await wellKnown.GET(new Request("http://mcp.test/.well-known/oauth-authorization-server"));
    assert.equal(response.status, 200);
    const body = await response.json() as { authorization_endpoint: string; token_endpoint: string };
    assert.match(body.authorization_endpoint, /oauth\/consent/);
    assert.match(body.token_endpoint, /oauth\/token/);
  });

  await t.test("an unrelated well-known path falls through to 404, not the OAuth documents", async () => {
    const response = await wellKnown.GET(new Request("http://mcp.test/.well-known/something-else"));
    assert.equal(response.status, 404);
  });

  await t.test("a configured public hostname wins over the underlying request URL's hostname", async () => {
    const previous = process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
    process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = "app.alyandpon.com";
    try {
      const response = await wellKnown.GET(
        new Request("https://elegant-bombolone-754d65.netlify.app/.well-known/oauth-protected-resource/api/mcp"),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { resource: string };
      assert.equal(body.resource, "https://app.alyandpon.com/api/mcp");
    } finally {
      if (previous === undefined) delete process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
      else process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = previous;
    }
  });

  await t.test("an arbitrary inbound Host/X-Forwarded-Host header cannot override the configured hostname", async () => {
    const previous = process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
    process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = "app.alyandpon.com";
    try {
      const response = await wellKnown.GET(
        new Request("http://mcp.test/.well-known/oauth-protected-resource/api/mcp", {
          headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
        }),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { resource: string };
      assert.equal(body.resource, "https://app.alyandpon.com/api/mcp");
    } finally {
      if (previous === undefined) delete process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
      else process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = previous;
    }
  });

  await t.test("with no configured public hostname, the request URL's own hostname is used (local/dev fallback)", async () => {
    const previous = process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
    delete process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
    try {
      const response = await wellKnown.GET(
        new Request("http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { resource: string };
      assert.equal(body.resource, "http://localhost:3000/api/mcp");
    } finally {
      if (previous === undefined) delete process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
      else process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = previous;
    }
  });

  await t.test("authorization_servers still names the Supabase OAuth server when a public hostname is configured", async () => {
    const previous = process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
    process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = "app.alyandpon.com";
    try {
      const response = await wellKnown.GET(
        new Request("https://elegant-bombolone-754d65.netlify.app/.well-known/oauth-protected-resource/api/mcp"),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { authorization_servers: string[] };
      assert.ok(Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0);
    } finally {
      if (previous === undefined) delete process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
      else process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME = previous;
    }
  });
});

test("Product Lab MCP durable preview store RLS shape (Slice 2.1A)", async () => {
  const migration = await readFile(
    path.join(root, "supabase", "migrations", "20260914120000_product_lab_mcp_durable_previews.sql"),
    "utf8",
  );
  assert.match(migration, /create table public\.product_lab_mcp_previews/);
  // Reviewer fix: preview_id is content-derived, so a global `primary key (preview_id)` lets two
  // different owner accounts collide on an otherwise-valid preview. Uniqueness must be owner-scoped.
  assert.match(migration, /primary key\s*\(owner_id,\s*preview_id\)/);
  assert.doesNotMatch(migration, /preview_id text primary key/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /force row level security/);
  // Every policy must combine the role check with the row-owner check -- the role check alone would
  // let every owner account read every other owner account's preview.
  const policyBlocks = migration.match(/create policy[\s\S]*?;/g) ?? [];
  assert.ok(policyBlocks.length >= 3, "expected select/insert/update owner policies");
  for (const block of policyBlocks) {
    assert.match(block, /public\.is_product_lab_owner\(\)/);
    assert.match(block, /owner_id\s*=\s*auth\.uid\(\)/);
  }
  assert.doesNotMatch(migration, /grant\s+(all|delete)\s+on\s+public\.product_lab_mcp_previews\s+to\s+(anon|public)/i);
});

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MAX_MCP_REQUEST_BODY_BYTES, MAX_MCP_TOOL_INPUT_ELEMENTS } from "../../scripts/product-lab-mcp/input-limits.ts";

// Exercise the actual HTTP adapters with bounded fixtures, never a deployed endpoint.
export async function verifyMcpInputSecurity(t: TestContext, url: string, call: (request: Request) => Promise<Response>) {
  const headers = {
    host: new URL(url).host,
    authorization: "Bearer owner-token",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  for (const protocol of ["2025-11-25", "2026-07-28"]) {
    await t.test(`${protocol}: declared, undeclared and misleading body lengths cannot bypass the byte cap`, async () => {
      const body = JSON.stringify({ ...rpc, padding: "x".repeat(MAX_MCP_REQUEST_BODY_BYTES) });
      for (const length of [undefined, "1", String(body.length)]) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = new TextEncoder().encode(body);
            for (let offset = 0; offset < bytes.length; offset += 8192) controller.enqueue(bytes.slice(offset, offset + 8192));
            controller.close();
          },
        });
        const request = new Request(url, {
          method: "POST", body: stream, duplex: "half",
          headers: { ...headers, "mcp-protocol-version": protocol, ...(length ? { "content-length": length } : {}) },
        } as RequestInit);
        const response = await call(request);
        assert.equal(response.status, 413);
        assert.match(await response.text(), /262144|too large|exceed/i);
      }
    });
    await t.test(`${protocol}: a 101-message JSON-RPC batch is rejected`, async () => {
      const response = await call(new Request(url, {
        method: "POST", headers: { ...headers, "mcp-protocol-version": protocol },
        body: JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ ...rpc, id }))),
      }));
      assert.equal(response.status, 400);
      assert.match(await response.text(), /batch/i);
    });
  }
  await t.test("tool complexity and count-row guards reject before invoking a tool", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: { token: async () => "owner-token" },
      fetch: (input, init) => call(new Request(input, { ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), host: new URL(url).host }) })),
    });
    const client = new Client({ name: "input-security-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      // Unknown keys must also count, before strict Zod validation gets a chance to traverse them.
      const complex = await client.callTool({
        name: "inventory_list", arguments: { unknown: Array(MAX_MCP_TOOL_INPUT_ELEMENTS).fill(null) },
      });
      assert.equal(complex.isError, true);
      assert.match(JSON.stringify(complex.content), /maximum of 5000 elements/);
      const tooManyRows = await client.callTool({
        name: "inventory_count_preview", arguments: {
          kind: "physical_count", source: { name: "bounded-fixture", fingerprint: "f".repeat(64), occurrence_id: "reject-501" },
          rows: Array.from({ length: 501 }, () => ({ raw_name: "sea salt", quantity: 1, unit: "g" })),
        },
      }).catch((error: Error) => error);
      assert.match(JSON.stringify(tooManyRows instanceof Error ? tooManyRows.message : tooManyRows), /500|too_big/);
      const valid = await client.callTool({ name: "inventory_list", arguments: {} });
      assert.equal(valid.isError, undefined, "the same endpoint remains usable after rejection");
    } finally {
      await client.close();
    }
  });
}

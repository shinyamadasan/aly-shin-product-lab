import test from "node:test";
import assert from "node:assert/strict";
import { allowedMcpHostnames } from "../scripts/product-lab-mcp/origin-policy.ts";

test("Product Lab MCP Host/Origin allowlist (Slice 2.1A)", async (t) => {
  await t.test("a plain local/test environment (no VERCEL) trusts only localhost-class hostnames", () => {
    const hostnames = allowedMcpHostnames({});
    assert.deepEqual(hostnames.sort(), ["127.0.0.1", "[::1]", "localhost"].sort());
  });

  await t.test("a Vercel-built environment never trusts localhost, production or preview", () => {
    const hostnames = allowedMcpHostnames({ VERCEL: "1" });
    assert.equal(hostnames.length, 0);
    assert.equal(hostnames.includes("localhost"), false);
  });

  await t.test("VERCEL_URL (this deployment's own hostname) is trusted once VERCEL is set", () => {
    const hostnames = allowedMcpHostnames({ VERCEL: "1", VERCEL_URL: "my-app-abc123.vercel.app" });
    assert.deepEqual(hostnames, ["my-app-abc123.vercel.app"]);
  });

  await t.test("VERCEL_PROJECT_PRODUCTION_URL (the assigned production domain) is trusted", () => {
    const hostnames = allowedMcpHostnames({ VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "product-lab.example.com" });
    assert.deepEqual(hostnames, ["product-lab.example.com"]);
  });

  await t.test("an operator-configured custom hostname is trusted alongside Vercel's own", () => {
    const hostnames = allowedMcpHostnames({
      VERCEL: "1",
      VERCEL_URL: "my-app-abc123.vercel.app",
      PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: "mcp.aly-and-shin.example",
    });
    assert.deepEqual(hostnames.sort(), ["mcp.aly-and-shin.example", "my-app-abc123.vercel.app"].sort());
  });

  await t.test("a bare VERCEL=1 with none of its URL env vars set trusts nothing -- fails closed, not open", () => {
    assert.deepEqual(allowedMcpHostnames({ VERCEL: "1" }), []);
  });
});

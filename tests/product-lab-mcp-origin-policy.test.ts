import test from "node:test";
import assert from "node:assert/strict";
import { hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { allowedMcpHostnames } from "../scripts/product-lab-mcp/origin-policy.ts";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://ignored.example/", { headers });
}

test("Product Lab MCP Host/Origin allowlist (Slice 2.1A, made platform-neutral in Netlify Migration Slice 1)", async (t) => {
  await t.test("LOCAL: a plain local/test environment (no NODE_ENV) trusts only localhost-class hostnames", () => {
    const hostnames = allowedMcpHostnames({});
    assert.deepEqual(hostnames.sort(), ["127.0.0.1", "[::1]", "localhost"].sort());
  });

  await t.test("LOCAL: NODE_ENV=development (next dev) trusts only localhost-class hostnames", () => {
    const hostnames = allowedMcpHostnames({ NODE_ENV: "development" });
    assert.deepEqual(hostnames.sort(), ["127.0.0.1", "[::1]", "localhost"].sort());
  });

  await t.test("LOCAL: an operator-configured custom hostname still works alongside localhost", () => {
    const hostnames = allowedMcpHostnames({ PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: "custom.local.test" });
    assert.deepEqual(
      hostnames.sort(),
      ["127.0.0.1", "[::1]", "localhost", "custom.local.test"].sort(),
    );
  });

  await t.test("PRODUCTION-LIKE: a platform-neutral production environment never trusts localhost", () => {
    // No VERCEL, no Netlify markers -- just NODE_ENV=production, as any `next build`/`next start`
    // output sets regardless of host. This is the core of the fix: safety must not key off any one
    // platform's own env var.
    const hostnames = allowedMcpHostnames({ NODE_ENV: "production" });
    assert.deepEqual(hostnames, []);
  });

  await t.test("PRODUCTION-LIKE: a Netlify production environment does not trust localhost", () => {
    const hostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      NETLIFY: "true",
      CONTEXT: "production",
    });
    assert.equal(hostnames.includes("localhost"), false);
    assert.deepEqual(hostnames, []);
  });

  await t.test("PRODUCTION-LIKE: the correct Netlify production hostname (from URL) is trusted", () => {
    const hostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      NETLIFY: "true",
      CONTEXT: "production",
      URL: "https://aly-shin-product-lab.netlify.app",
    });
    assert.deepEqual(hostnames, ["aly-shin-product-lab.netlify.app"]);
  });

  await t.test("PRODUCTION-LIKE: PRODUCT_LAB_MCP_PUBLIC_HOSTNAME still works on Netlify for a custom domain", () => {
    const hostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      NETLIFY: "true",
      URL: "https://aly-shin-product-lab.netlify.app",
      PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: "mcp.aly-and-shin.example",
    });
    assert.deepEqual(
      hostnames.sort(),
      ["aly-shin-product-lab.netlify.app", "mcp.aly-and-shin.example"].sort(),
    );
  });

  await t.test("PRODUCTION-LIKE: a malformed Netlify URL is ignored rather than crashing or leaking it verbatim", () => {
    const hostnames = allowedMcpHostnames({ NODE_ENV: "production", URL: "not-a-url" });
    assert.deepEqual(hostnames, []);
  });

  await t.test("PRODUCTION-LIKE: an arbitrary Host header is rejected against a real production allowlist", () => {
    const allowedHostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      URL: "https://aly-shin-product-lab.netlify.app",
    });
    const rejection = hostHeaderValidationResponse(requestWith({ host: "evil.example.com" }), allowedHostnames);
    assert.notEqual(rejection, undefined);
    assert.equal(rejection?.status, 403);
    const accepted = hostHeaderValidationResponse(
      requestWith({ host: "aly-shin-product-lab.netlify.app" }),
      allowedHostnames,
    );
    assert.equal(accepted, undefined);
  });

  await t.test("PRODUCTION-LIKE: an arbitrary Origin is rejected against a real production allowlist", () => {
    const allowedHostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      URL: "https://aly-shin-product-lab.netlify.app",
    });
    const rejection = originValidationResponse(
      requestWith({ host: "aly-shin-product-lab.netlify.app", origin: "https://evil.example.com" }),
      allowedHostnames,
    );
    assert.notEqual(rejection, undefined);
    assert.equal(rejection?.status, 403);
  });

  await t.test("PRODUCTION-LIKE: a missing Origin for a normal MCP client remains valid when Host is valid", () => {
    const allowedHostnames = allowedMcpHostnames({
      NODE_ENV: "production",
      URL: "https://aly-shin-product-lab.netlify.app",
    });
    const hostRejection = hostHeaderValidationResponse(
      requestWith({ host: "aly-shin-product-lab.netlify.app" }),
      allowedHostnames,
    );
    assert.equal(hostRejection, undefined);
    const originRejection = originValidationResponse(
      requestWith({ host: "aly-shin-product-lab.netlify.app" }),
      allowedHostnames,
    );
    assert.equal(originRejection, undefined);
  });

  await t.test("VERCEL REGRESSION: a real Vercel-built environment (NODE_ENV=production) never trusts localhost", () => {
    const hostnames = allowedMcpHostnames({ VERCEL: "1", NODE_ENV: "production" });
    assert.equal(hostnames.length, 0);
    assert.equal(hostnames.includes("localhost"), false);
  });

  await t.test("VERCEL REGRESSION: VERCEL_URL (this deployment's own hostname) is trusted in production", () => {
    const hostnames = allowedMcpHostnames({
      VERCEL: "1",
      NODE_ENV: "production",
      VERCEL_URL: "my-app-abc123.vercel.app",
    });
    assert.deepEqual(hostnames, ["my-app-abc123.vercel.app"]);
  });

  await t.test("VERCEL REGRESSION: VERCEL_PROJECT_PRODUCTION_URL (the assigned production domain) is trusted", () => {
    const hostnames = allowedMcpHostnames({
      VERCEL: "1",
      NODE_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "product-lab.example.com",
    });
    assert.deepEqual(hostnames, ["product-lab.example.com"]);
  });

  await t.test("VERCEL REGRESSION: an operator-configured custom hostname is trusted alongside Vercel's own", () => {
    const hostnames = allowedMcpHostnames({
      VERCEL: "1",
      NODE_ENV: "production",
      VERCEL_URL: "my-app-abc123.vercel.app",
      PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: "mcp.aly-and-shin.example",
    });
    assert.deepEqual(hostnames.sort(), ["mcp.aly-and-shin.example", "my-app-abc123.vercel.app"].sort());
  });

  await t.test("VERCEL REGRESSION: a real Vercel production env with none of its URL vars set trusts nothing -- fails closed, not open", () => {
    assert.deepEqual(allowedMcpHostnames({ VERCEL: "1", NODE_ENV: "production" }), []);
  });
});

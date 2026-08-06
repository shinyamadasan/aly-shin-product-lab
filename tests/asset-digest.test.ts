import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { sha256Hex } from "../src/lib/asset-digest.ts";

// Parity proof for P1 (PROP-027): asset-binary.ts used to hash via node:crypto directly, which
// cannot run in a browser. This asserts the Web Crypto replacement produces byte-identical hex
// output against the exact algorithm it replaces, for the same inputs, before anything downstream
// (deterministic Storage paths) is allowed to depend on it.
function nodeCryptoSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("sha256Hex matches node:crypto's sha256 hex output for empty bytes", async () => {
  const bytes = new Uint8Array();
  assert.equal(await sha256Hex(bytes), nodeCryptoSha256Hex(bytes));
});

test("sha256Hex matches node:crypto's sha256 hex output for a single byte", async () => {
  const bytes = new Uint8Array([0x2a]);
  assert.equal(await sha256Hex(bytes), nodeCryptoSha256Hex(bytes));
});

test("sha256Hex matches node:crypto's sha256 hex output for realistic PNG-shaped bytes", async () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x04, 0x38,
    0x00, 0x00, 0x04, 0x38,
    0x08, 0x04, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(await sha256Hex(bytes), nodeCryptoSha256Hex(bytes));
});

test("sha256Hex output is a 64-character lowercase hex string", async () => {
  const digest = await sha256Hex(new Uint8Array([1, 2, 3, 4, 5]));
  assert.match(digest, /^[0-9a-f]{64}$/);
});

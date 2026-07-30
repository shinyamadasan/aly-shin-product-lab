import test from "node:test";
import assert from "node:assert/strict";

import { resolvePaidAnthropicSmokeGate } from "./smoke/creative-workers/paid-smoke-gate.ts";

test("resolvePaidAnthropicSmokeGate refuses when neither variable is set", () => {
  assert.equal(resolvePaidAnthropicSmokeGate({}).ok, false);
});

test("resolvePaidAnthropicSmokeGate refuses an API key alone, with no opt-in", () => {
  assert.equal(resolvePaidAnthropicSmokeGate({ ANTHROPIC_API_KEY: "sk-test" }).ok, false);
});

test("resolvePaidAnthropicSmokeGate refuses the opt-in alone, with no API key", () => {
  assert.equal(resolvePaidAnthropicSmokeGate({ RUN_PAID_ANTHROPIC_SMOKE: "1" }).ok, false);
});

test("resolvePaidAnthropicSmokeGate refuses any opt-in value other than exactly \"1\"", () => {
  for (const value of ["true", "yes", "0", "01", " 1", "1 "]) {
    assert.equal(resolvePaidAnthropicSmokeGate({ ANTHROPIC_API_KEY: "sk-test", RUN_PAID_ANTHROPIC_SMOKE: value }).ok, false, `expected "${value}" to be refused`);
  }
});

test("resolvePaidAnthropicSmokeGate allows the request only when both conditions hold exactly", () => {
  assert.equal(resolvePaidAnthropicSmokeGate({ ANTHROPIC_API_KEY: "sk-test", RUN_PAID_ANTHROPIC_SMOKE: "1" }).ok, true);
});

test("resolvePaidAnthropicSmokeGate's refusal message explains the test is billable and requires explicit opt-in", () => {
  const result = resolvePaidAnthropicSmokeGate({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /billable/i);
    assert.match(result.message, /ANTHROPIC_API_KEY/);
    assert.match(result.message, /RUN_PAID_ANTHROPIC_SMOKE=1/);
  }
});

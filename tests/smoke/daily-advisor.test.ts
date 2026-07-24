import test from "node:test";
import assert from "node:assert/strict";
import { invokeClaude } from "../../scripts/daily-advisor/claude-invoke.ts";

// Opt-in ONLY: this is the one test file in the repo allowed to make a real Claude CLI call, and
// it does so only when explicitly requested via ADVISOR_SMOKE_TEST=1 -- run with
// `npm run advisor:smoke` after setting that env var. It is NOT part of `npm test`'s glob
// (tests/*.test.ts is non-recursive, this file lives under tests/smoke/), so ordinary test runs,
// CI, and pre-commit checks never spend real Claude usage.
const shouldRun = process.env.ADVISOR_SMOKE_TEST === "1";

test("smoke: a real, minimal claude -p --tools \"\" call succeeds end to end", { skip: !shouldRun }, async () => {
  const result = await invokeClaude('Reply with exactly the single word: OK', { timeoutMs: 30000 });
  assert.equal(result.ok, true, result.ok ? "" : `Claude call failed: ${(result as { detail: string }).detail}`);
  if (result.ok) {
    assert.match(result.text, /OK/i);
  }
});

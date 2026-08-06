import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildExternalAssetExecutor } from "../src/lib/external-asset-provider.ts";
import type { GeneratedAssetFileCandidate } from "../src/lib/asset-generation-validation.ts";
import type { AssetJobRecord } from "../src/lib/asset-jobs.ts";
import type { AssetGenerationSpecV1 } from "../src/lib/asset-generation-spec.ts";

function candidate(): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    durationMs: null,
    fileSizeBytes: 12,
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  };
}

test("buildExternalAssetExecutor returns exactly the given candidate, unchanged, wrapped in a one-element array", async () => {
  const suppliedCandidate = candidate();
  const executor = buildExternalAssetExecutor(suppliedCandidate);
  const result = await executor({ id: "asset-job-1" } as AssetJobRecord, {} as AssetGenerationSpecV1, { signal: new AbortController().signal });

  assert.deepEqual(result, [suppliedCandidate]);
  assert.equal(result[0], suppliedCandidate, "must be the same object, not a copy");
});

test("buildExternalAssetExecutor performs no I/O -- calling it never touches job or spec", async () => {
  const suppliedCandidate = candidate();
  const executor = buildExternalAssetExecutor(suppliedCandidate);
  // A job/spec that would throw if any property were read proves the executor never inspects them --
  // the bytes were already supplied and locally validated; there is nothing left to derive from
  // either argument.
  const poisonedJob = new Proxy({} as AssetJobRecord, {
    get() {
      throw new Error("external executor must not read the job");
    },
  });
  const poisonedSpec = new Proxy({} as AssetGenerationSpecV1, {
    get() {
      throw new Error("external executor must not read the spec");
    },
  });

  const result = await executor(poisonedJob, poisonedSpec, { signal: new AbortController().signal });
  assert.deepEqual(result, [suppliedCandidate]);
});

test("external asset provider makes no network call, uses no SDK, and names no provider", () => {
  const source = readFileSync(new URL("../src/lib/external-asset-provider.ts", import.meta.url), "utf8");

  for (const forbidden of [/\bfetch\s*\(/, /OpenAI/i, /Gemini/i, /Midjourney/i, /Canva/i, /@supabase\/supabase-js/i, /API_KEY/i]) {
    assert.doesNotMatch(source, forbidden);
  }
});

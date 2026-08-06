import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/creative-package-asset-create.tsx", import.meta.url), "utf8");
const opportunitiesPage = readFileSync(new URL("../src/components/opportunities-page.tsx", import.meta.url), "utf8");

// Captures the function's own leading indentation and requires the closing brace to match it, so
// a nested function (indented inside the component body) doesn't overrun into its own siblings --
// which a bare "next \n}\n" would, since sibling closing braces share that same shallow indent.
function extractFunction(name: string): string {
  const match = source.match(new RegExp(`( *)(?:async )?function ${name}\\([\\s\\S]*?\\n\\1\\}\\n`));
  if (!match) {
    throw new Error(`Could not find function ${name} in creative-package-asset-create.tsx -- test fixture is stale.`);
  }
  return match[0];
}

test("[static] creating a job, resuming an existing one, viewing its brief, and copying it never claim the Asset Job or start an attempt", () => {
  const readOnlyFunctions = [extractFunction("resolveBrief"), extractFunction("createJob"), extractFunction("copyBrief")];
  for (const fn of readOnlyFunctions) {
    for (const forbidden of [/claimQueuedAssetJobWithAttempt/, /runAssetJobWithExecutors/, /claim_asset_job_with_attempt/, /\.rpc\s*\(/]) {
      assert.doesNotMatch(fn, forbidden);
    }
  }
});

test("[static] uploadImage is the only place allowed to claim the Asset Job, and only after pre-claim intake validation succeeds", () => {
  const uploadFn = extractFunction("uploadImage");
  assert.match(uploadFn, /runAssetJobWithExecutors/);
  assert.match(uploadFn, /buildAssetUploadCandidateFromBlob/);

  // Two occurrences expected in the whole file: the import and this one call site. If a second call
  // site is ever added, this catches it -- claiming must stay concentrated in exactly one place.
  const occurrences = source.match(/runAssetJobWithExecutors/g) ?? [];
  assert.equal(occurrences.length, 2, "runAssetJobWithExecutors must appear exactly twice: the import and uploadImage's one call site");
});

test("[static] the External Creative Workspace create/brief/upload UI is actually mounted on the Opportunities page, next to the read-only Assets viewer, wired to refresh it on upload", () => {
  assert.match(opportunitiesPage, /import \{ CreativePackageAssetCreate \} from "@\/components\/creative-package-asset-create";/);
  assert.match(opportunitiesPage, /<CreativePackageAssetCreate creativePackageId=\{selectedPackage\.id\} onUploaded=\{\(\) => setAssetRefreshToken\(\(current\) => current \+ 1\)\} \/>/);
});

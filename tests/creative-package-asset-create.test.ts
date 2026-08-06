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

// PROP-035 Slice 3: variant="ritual" hides four provenance/job-lifecycle presentation elements
// (origin+status tags, Asset Job ID, Workspace input, Source kind dropdown) for a caller composing
// this component into a screen that shouldn't show that vocabulary. It must change no logic --
// resolveBrief/createJob/copyBrief/uploadImage stay exactly as asserted read-only/claim-boundary
// above, regardless of variant.
test("[static] variant is additive: default is \"full\", and every existing caller omits it (default rendering unchanged)", () => {
  assert.match(source, /variant\?: "full" \| "ritual";/);
  assert.match(source, /variant = "full"/);
  // Opportunities page (the only existing caller) never passes variant -- it always gets the
  // unchanged, pre-Slice-3 default render.
  assert.doesNotMatch(opportunitiesPage, /CreativePackageAssetCreate[\s\S]{0,40}variant=/);
});

test("[static] exactly four elements are gated behind variant === \"full\": origin/status tags, Asset Job ID, Workspace input, Source kind dropdown -- nothing else", () => {
  // Each named element still exists in the file (proves the guard hides it conditionally rather
  // than the element having been deleted outright).
  assert.match(source, /Resuming existing Asset Job/);
  assert.match(source, /Asset Job created/);
  assert.match(source, /Asset Job ID/);
  assert.match(source, /Workspace \(optional\)/);
  assert.match(source, /Source kind \(optional\)/);
});

test("[static] the actual upload mechanism -- Image file input and Upload image button -- is never gated by variant", () => {
  const uploadSectionStart = source.indexOf("Image file");
  const uploadSectionEnd = source.indexOf("Upload image") + "Upload image".length;
  assert.ok(uploadSectionStart > -1 && uploadSectionEnd > uploadSectionStart, "test fixture is stale -- could not locate the Image file / Upload image block");
  const uploadSection = source.slice(uploadSectionStart, uploadSectionEnd);
  assert.doesNotMatch(uploadSection, /variant ===/);
});

// PROP-035 Slice 4: three more banned-vocabulary leaks found while embedding this component into
// Today -- the section header, the initial prompt/button copy, and the queued/claim explanatory
// paragraph all said "Asset Job" or "queued"/"claim" unconditionally, which Today (ritual) can't
// show per today-product-spec.md's User Language section. Extends the same variant mechanism
// Slice 3 established; still zero change to createJob/uploadImage/resolveBrief/copyBrief themselves.
test("[static] variant=\"ritual\" also hides the section header and relabels the initial prompt/button, with no \"Asset Job\"/\"queued\"/\"claim\" wording reaching ritual mode", () => {
  assert.match(source, /variant === "full" \? \(\s*<div className="flex items-center gap-2">/);
  assert.match(source, /Get today's brief to paste into ChatGPT/);
  assert.match(source, /"Start today's post"/);
  assert.match(source, /canUpload && variant === "full" \?/);

  const occurrences = source.match(/variant === "full"/g) ?? [];
  assert.equal(occurrences.length, 10, "expected exactly 10 variant === \"full\" guards after Slice 4's extension -- if this changes, an element was added or removed from the ritual-hidden set");
});

test("[static] the completion message drops \"in Assets\" under ritual, without changing the completed-upload condition it's gated behind", () => {
  assert.match(source, /variant === "full" \? "Upload complete\. See it below in Assets\." : "Upload complete\."/);
  assert.match(source, /job\.status === "completed" \?/);
});

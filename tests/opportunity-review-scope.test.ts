import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Opportunity review UI is wired as its own Product Lab route", () => {
  assert.match(source("src/app/opportunities/page.tsx"), /view="opportunities"/);
  assert.match(source("src/app/product-lab.tsx"), /<OpportunitiesPage initialStatusFilter=/);
  assert.match(source("src/lib/lab-state.ts"), /view: "opportunities"/);
  assert.match(source("src/components/app-shell.tsx"), /opportunities: "Opportunity review"/);
});

test("Opportunity review files do not introduce excluded post-Creative-Job concepts", () => {
  const reviewedSource = [
    source("src/app/opportunities/page.tsx"),
    source("src/components/opportunities-page.tsx"),
    source("src/lib/opportunity-review.ts"),
    source("src/lib/creative-jobs.ts"),
    source("src/lib/creative-packages.ts"),
  ].join("\n");

  for (const forbidden of [
    /from\("content_packages"\)/i,
    /from\("assets"\)/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
    /from\("campaigns"\)/i,
    /from\("workers"\)/i,
    /Claude/i,
    /OpenAI/i,
    /Gemini/i,
    /Remotion/i,
  ]) {
    assert.doesNotMatch(reviewedSource, forbidden);
  }
});

test("Opportunity review UI creates jobs but does not execute the runner or materializer", () => {
  const page = source("src/components/opportunities-page.tsx");

  assert.match(page, /createCreativeJobForAcceptedOpportunity/);
  assert.doesNotMatch(page, /runMockCreativeJob/);
  assert.doesNotMatch(page, /runMockCreativeJobAndMaterializePackage/);
  assert.doesNotMatch(page, /createCreativePackageFromCompletedJob/);
});

test("Opportunity review UI reads completed-job packages without exposing package write actions", () => {
  const page = source("src/components/opportunities-page.tsx");

  assert.match(page, /getCreativePackageForJob/);
  assert.match(page, /View Package/);
  assert.match(page, /No Creative Package has been materialized yet\./);
  for (const forbiddenAction of ["Create Package", "Materialize Package", "Retry Package", "Edit Package", "Approve Package", "Publish Package"]) {
    assert.doesNotMatch(page, new RegExp(forbiddenAction));
  }
});

test("Opportunity review UI exposes accessible labels for filters, actions, and evidence", () => {
  const page = source("src/components/opportunities-page.tsx");

  for (const label of [
    "Opportunity status filters",
    "New",
    "All",
    "Accepted",
    "Dismissed",
    "Expired",
    "Converted",
    "Status:",
    "Accept",
    "Dismiss",
    "Mark expired",
    "Create Job",
    "Creative Job",
    "Last error",
    "View job detail",
    "Creative Package",
    "View Package",
    "Raw package JSON",
    "Raw evidence JSON",
  ]) {
    assert.match(page, new RegExp(label));
  }
});

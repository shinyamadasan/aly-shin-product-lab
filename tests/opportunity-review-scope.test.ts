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

test("Opportunity review files do not introduce excluded PROP-016 follow-on concepts", () => {
  const reviewedSource = [
    source("src/app/opportunities/page.tsx"),
    source("src/components/opportunities-page.tsx"),
    source("src/lib/opportunity-review.ts"),
  ].join("\n");

  for (const forbidden of [
    /from\("creative_jobs"\)/i,
    /from\("content_packages"\)/i,
    /from\("assets"\)/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("campaigns"\)/i,
    /from\("workers"\)/i,
    /\.rpc\(/i,
    /Claude/i,
    /Remotion/i,
    /createCreativeJob/i,
    /publish/i,
  ]) {
    assert.doesNotMatch(reviewedSource, forbidden);
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
    "Raw evidence JSON",
  ]) {
    assert.match(page, new RegExp(label));
  }
});

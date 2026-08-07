import test from "node:test";
import assert from "node:assert/strict";
import { areTastingFormSnapshotsEqual, buildTastingFormSnapshot, isTastingFormDirty } from "../src/lib/tasting-form-snapshot.ts";

// Mirrors a real BatchTastingSection checkpoint submission (src/app/product-lab.tsx) -- every
// field name here matches that form's `name=` attributes exactly. This form has no `id` field --
// it can only ever create a new tasting_feedback row, never edit an existing one (confirmed by
// reading saveTasting: tastingId is always "" for this form, so it always takes the insert path).
function tastingFormData(
  overrides: Partial<{
    productId: string;
    batchId: string;
    timeLabel: string;
    tasterName: string;
    rating: string;
    willingToPay: string;
    liked: string;
    improve: string;
    wouldBuy: string;
    wouldReorder: string;
    packagingReaction: string;
  }> = {},
): FormData {
  const data = new FormData();
  data.append("productId", overrides.productId ?? "product-1");
  data.append("batchId", overrides.batchId ?? "batch-1");
  data.append("timeLabel", overrides.timeLabel ?? "2 hours post-bake");
  data.append("tasterName", overrides.tasterName ?? "Aly");
  data.append("rating", overrides.rating ?? "8");
  data.append("willingToPay", overrides.willingToPay ?? "150");
  data.append("liked", overrides.liked ?? "Chocolate flavor was strong.");
  data.append("improve", overrides.improve ?? "Could be less dry.");
  data.append("wouldBuy", overrides.wouldBuy ?? "yes");
  data.append("wouldReorder", overrides.wouldReorder ?? "maybe");
  data.append("packagingReaction", overrides.packagingReaction ?? "Box felt sturdy.");
  return data;
}

test("an identical form is clean", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData());
  assert.equal(isTastingFormDirty(live, baseline), false);
});

test("a changed rating is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ rating: "5" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed 'what they liked' field is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ liked: "Too sweet now." }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed 'what should improve' field is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ improve: "Bake 5 minutes less." }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed wouldBuy decision is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ wouldBuy: "no" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed wouldReorder decision is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ wouldReorder: "no" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed time label is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ timeLabel: "24 hours post-bake" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed taster name is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ tasterName: "Shin" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed willingness to pay is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ willingToPay: "200" }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("a changed packaging reaction is dirty", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const live = buildTastingFormSnapshot(tastingFormData({ packagingReaction: "Box got crushed in transit." }));
  assert.equal(isTastingFormDirty(live, baseline), true);
});

test("changing a field then restoring its original value returns to clean", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData());
  const changed = buildTastingFormSnapshot(tastingFormData({ rating: "10" }));
  assert.equal(isTastingFormDirty(changed, baseline), true);

  const reverted = buildTastingFormSnapshot(tastingFormData({ rating: "8" }));
  assert.equal(isTastingFormDirty(reverted, baseline), false);
});

test("productId and batchId never contribute to dirty state even when they differ", () => {
  const baseline = buildTastingFormSnapshot(tastingFormData({ productId: "product-1", batchId: "batch-1" }));
  const live = buildTastingFormSnapshot(tastingFormData({ productId: "product-2", batchId: "batch-2" }));
  assert.equal(areTastingFormSnapshotsEqual(live, baseline), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { areFormDataSnapshotsEqual, buildFormDataSnapshot } from "../src/lib/form-data-snapshot.ts";

function formData(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) {
    data.append(key, value);
  }
  return data;
}

test("identical FormData produces an equal snapshot", () => {
  const a = buildFormDataSnapshot(formData([["name", "Flour"], ["cost", "20"]]));
  const b = buildFormDataSnapshot(formData([["name", "Flour"], ["cost", "20"]]));
  assert.equal(areFormDataSnapshotsEqual(a, b), true);
});

test("a changed field value makes the snapshots unequal", () => {
  const a = buildFormDataSnapshot(formData([["name", "Flour"], ["cost", "20"]]));
  const b = buildFormDataSnapshot(formData([["name", "Flour"], ["cost", "25"]]));
  assert.equal(areFormDataSnapshotsEqual(a, b), false);
});

test("a field present in one snapshot but not the other is unequal", () => {
  const a = buildFormDataSnapshot(formData([["name", "Flour"]]));
  const b = buildFormDataSnapshot(formData([["name", "Flour"], ["notes", "new field"]]));
  assert.equal(areFormDataSnapshotsEqual(a, b), false);
});

test("excludeNames omits listed fields from both the snapshot and the comparison", () => {
  const a = buildFormDataSnapshot(formData([["name", "Flour"], ["uploadError", ""]]), ["uploadError"]);
  const b = buildFormDataSnapshot(formData([["name", "Flour"], ["uploadError", "a transient error"]]), ["uploadError"]);
  assert.deepEqual(Object.keys(a), ["name"]);
  assert.equal(areFormDataSnapshotsEqual(a, b), true);
});

test("repeated field names are captured in full via getAll, order-sensitive", () => {
  const data = new FormData();
  data.append("tag", "a");
  data.append("tag", "b");
  const snapshot = buildFormDataSnapshot(data);
  assert.deepEqual(snapshot.tag, ["a", "b"]);

  const reordered = new FormData();
  reordered.append("tag", "b");
  reordered.append("tag", "a");
  assert.equal(areFormDataSnapshotsEqual(snapshot, buildFormDataSnapshot(reordered)), false);
});

test("File entries compare by name/size/lastModified, not by lossy stringification", () => {
  const fileA = new File(["hello"], "photo.jpg", { lastModified: 1000 });
  const fileB = new File(["hello"], "photo.jpg", { lastModified: 1000 });
  const fileC = new File(["hello"], "different.jpg", { lastModified: 1000 });

  const dataA = new FormData();
  dataA.append("photo", fileA);
  const dataB = new FormData();
  dataB.append("photo", fileB);
  const dataC = new FormData();
  dataC.append("photo", fileC);

  assert.equal(areFormDataSnapshotsEqual(buildFormDataSnapshot(dataA), buildFormDataSnapshot(dataB)), true);
  assert.equal(areFormDataSnapshotsEqual(buildFormDataSnapshot(dataA), buildFormDataSnapshot(dataC)), false);
});

test("an empty FormData snapshot equals another empty one", () => {
  assert.equal(areFormDataSnapshotsEqual(buildFormDataSnapshot(new FormData()), buildFormDataSnapshot(new FormData())), true);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { changeMediaProduct, listMediaForProduct, uploadProductMedia, uploadProductMediaBatch, type ProductMediaClient, type ProductMediaRow } from "../src/lib/product-media.ts";

function fixture(extension: string, name = `test-pattern.${extension}`) {
  return new File([readFileSync(new URL(`./fixtures/product-media/test-pattern.${extension}`, import.meta.url))], name);
}

function memoryClient() {
  const rows: ProductMediaRow[] = [];
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let failInsert = false;
  let failSigning = false;
  const client = {
    from(table: string) {
      assert.equal(table, "product_media");
      return {
        select() {
          let filtered = rows.slice();
          const query = {
            eq(column: keyof ProductMediaRow, value: string) { filtered = filtered.filter((row) => row[column] === value); return query; },
            is(column: keyof ProductMediaRow, value: null) { filtered = filtered.filter((row) => row[column] === value); return query; },
            order() { return query; },
            then(resolve: (value: { data: ProductMediaRow[]; error: null }) => void) { resolve({ data: filtered, error: null }); },
          };
          return query;
        },
        insert(row: Omit<ProductMediaRow, "created_at">) {
          calls.push("insert");
          return { select: () => ({ single: async () => {
            if (failInsert) return { data: null, error: { message: "Lost response" } };
            const saved = { ...row, created_at: "2026-10-13T10:00:00.000Z" };
            rows.push(saved);
            return { data: saved, error: null };
          } }) };
        },
        update(patch: { product_id: string | null }) {
          assert.deepEqual(Object.keys(patch), ["product_id"]);
          return { eq: (_column: string, id: string) => ({ select: () => ({ maybeSingle: async () => {
            const row = rows.find((row) => row.id === id);
            if (row) row.product_id = patch.product_id;
            return { data: row ?? null, error: null };
          } }) }) };
        },
      };
    },
    storage: { from(bucket: string) {
      assert.equal(bucket, "product-media");
      return {
        upload: async (path: string, bytes: Uint8Array, options: { upsert: boolean }) => {
          assert.equal(options.upsert, false);
          calls.push("upload"); objects.set(path, bytes);
          return { data: {}, error: null };
        },
        createSignedUrl: async (path: string, seconds: number) => {
          assert.equal(seconds, 300);
          if (failSigning) throw new Error("Offline");
          assert.ok(objects.has(path));
          return { data: { signedUrl: `https://local-fixture.invalid/${path}?signature=test` }, error: null };
        },
      };
    } },
  } as unknown as ProductMediaClient;
  return { client, rows, objects, calls, failInsert: () => { failInsert = true; }, failSigning: () => { failSigning = true; } };
}

test("multi-upload persists three real photos and one H.264 MP4; fresh reads preview and filter the test product", async () => {
  const db = memoryClient();
  const result = await uploadProductMediaBatch(db.client, [fixture("jpg"), fixture("png"), fixture("webp"), fixture("mp4")], "media-test-product");
  assert.equal(result.filter(({ result }) => result.ok).length, 4);
  assert.equal(db.rows.filter((row) => row.media_type === "photo").length, 3);
  const video = db.rows.find((row) => row.media_type === "video")!;
  assert.equal(video.mime_type, "video/mp4"); assert.equal(video.duration_ms, 1000);
  assert.equal(video.width, 160); assert.equal(video.height, 120);
  const reload = await listMediaForProduct(db.client, "media-test-product");
  assert.ok(reload.ok);
  assert.equal(reload.value.length, 4);
  assert.ok(reload.value.every((item) => item.previewUrl?.includes("signature=test")));
  assert.ok(db.rows.every((row) => !("previewUrl" in row) && row.product_id === "media-test-product"));
  assert.deepEqual(db.calls, ["upload", "insert", "upload", "insert", "upload", "insert", "upload", "insert"]);
  const other = await listMediaForProduct(db.client, "other-product");
  assert.ok(other.ok); assert.equal(other.value.length, 0);
});

test("Unassigned survives reload and product changes update only the association", async () => {
  const db = memoryClient();
  const added = await uploadProductMedia(db.client, fixture("png"), null);
  assert.ok(added.ok); assert.equal(added.value.productId, null);
  assert.ok((await listMediaForProduct(db.client, null)).ok);
  const before = { ...db.rows[0] };
  const changed = await changeMediaProduct(db.client, added.value.id, "media-test-product");
  assert.ok(changed.ok); assert.equal(changed.value.productId, "media-test-product");
  assert.deepEqual(db.rows[0], { ...before, product_id: "media-test-product" });
  const none = await listMediaForProduct(db.client, null);
  assert.ok(none.ok); assert.equal(none.value.length, 0);
  assert.ok((await changeMediaProduct(db.client, added.value.id, null)).ok);
  const unassigned = await listMediaForProduct(db.client, null);
  assert.ok(unassigned.ok); assert.equal(unassigned.value.length, 1);
});

test("MOV, HEVC MP4, invalid photos and unsupported formats reject individually without disrupting a batch", async () => {
  const db = memoryClient();
  const hevc = readFileSync(new URL("./fixtures/product-media/test-pattern.mp4", import.meta.url));
  const codec = hevc.indexOf("avc1", hevc.indexOf("stsd"));
  assert.ok(codec > 0); hevc.write("hvc1", codec, "ascii");
  const result = await uploadProductMediaBatch(db.client, [
    fixture("jpg"), fixture("mp4", "phone.MOV"), new File([hevc], "phone-hevc.mp4"),
    new File(["invalid"], "broken.jpg"), new File(["GIF89a"], "unsupported.gif"), fixture("png"),
  ], null);
  assert.deepEqual(result.map(({ result }) => result.ok), [true, false, false, false, false, true]);
  assert.match(result[1].result.ok ? "" : result[1].result.message, /MOV/);
  assert.match(result[2].result.ok ? "" : result[2].result.message, /HEVC/);
  assert.equal(db.objects.size, 2);
});

test("oversized and empty files never write storage; filename/MIME cannot disguise bytes", async () => {
  const db = memoryClient();
  for (const file of [new File([], "empty.png"), new File([new Uint8Array(10485761)], "large.jpg"), new File(["fake"], "fake.mp4", { type: "video/mp4" }), fixture("mp4", "disguised.jpg")]) {
    assert.equal((await uploadProductMedia(db.client, file, null)).ok, false);
  }
  assert.deepEqual(db.calls, []);
});

test("an ambiguous metadata failure preserves the private upload; signing failure preserves the saved record", async () => {
  const db = memoryClient(); db.failInsert();
  const failed = await uploadProductMedia(db.client, fixture("png"), null);
  assert.ok(!failed.ok); assert.match(failed.message, /Reload/);
  assert.equal(db.objects.size, 1);
  const savedDb = memoryClient();
  await uploadProductMedia(savedDb.client, fixture("jpg"), null);
  savedDb.failSigning();
  const list = await listMediaForProduct(savedDb.client);
  assert.ok(list.ok); assert.equal(list.value.length, 1); assert.equal(list.value[0].previewUrl, null);
});

test("missing setup and failed reads report an owner-facing error", async () => {
  const client = { from: () => ({ select: () => ({ order() { return this; }, then(resolve: (v: unknown) => void) { resolve({ data: null, error: { code: "PGRST205", message: "Missing table" } }); } }) }) } as unknown as ProductMediaClient;
  const result = await listMediaForProduct(client);
  assert.ok(!result.ok); assert.match(result.message, /one-time setup/);
});

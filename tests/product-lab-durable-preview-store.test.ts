import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CountPreview } from "../scripts/inventory-operator/core.ts";
import { createDurableInventoryCountArtifactStore } from "../scripts/product-lab/inventory-count-service.ts";
import { ProductLabError } from "../scripts/product-lab/auth.ts";

const PREVIEW_ID = "pc_00000000000000000001";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function preview(overrides: Partial<CountPreview> = {}): CountPreview {
  return {
    version: 1,
    kind: "physical_count_preview",
    preview_id: PREVIEW_ID,
    approval_code: "ABCD-1234",
    payload_hash: "a".repeat(64),
    operation_id: "10000000-0000-4000-8000-000000000001",
    source: { name: "test", fingerprint: "f".repeat(64), occurrence_id: "occ-1" },
    rows: [],
    can_apply: true,
    errors: [],
    created_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  } as CountPreview;
}

type Row = Record<string, unknown>;
// db is keyed by owner_id, one submap of preview_id -> row per owner -- this is the fake-double
// equivalent of the migration's (owner_id, preview_id) primary key PLUS its RLS: a session for one
// owner can only ever see or write into that owner's own submap, exactly as
// `using (owner_id = auth.uid())` restricts a real Postgres session to its own rows regardless of the
// WHERE clause the application issued.
type Database = Map<string, Map<string, Row>>;

// A minimal fake Supabase client double bound to ONE owner_id, modeling the call chain
// createDurableInventoryCountArtifactStore uses (.from(table).select(...).eq(...).maybeSingle() and
// .from(table).upsert(row, {onConflict})). `db` is shared across independently-constructed clients so
// tests can simulate two separate serverless invocations (or an MCP process restart) reading back
// what a prior invocation wrote, and two different owner sessions never touching each other's rows.
function fakeClient(db: Database, ownerId: string): SupabaseClient {
  const rows = () => {
    let submap = db.get(ownerId);
    if (!submap) {
      submap = new Map();
      db.set(ownerId, submap);
    }
    return submap;
  };
  return {
    from(name: string) {
      assert.equal(name, "product_lab_mcp_previews");
      return {
        select() {
          return {
            eq(column: string, value: string) {
              assert.equal(column, "preview_id");
              return {
                async maybeSingle() {
                  return { data: rows().get(value) ?? null, error: null };
                },
              };
            },
          };
        },
        async upsert(row: Row, options: { onConflict: string }) {
          assert.equal(options.onConflict, "owner_id,preview_id");
          const previewId = row.preview_id as string;
          const existing = rows().get(previewId) ?? {};
          rows().set(previewId, { ...existing, ...row });
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
}

test("durable preview artifact store (Slice 2.1A)", async (t) => {
  await t.test("an invalid preview id is rejected before any client call", async () => {
    const store = createDurableInventoryCountArtifactStore(fakeClient(new Map(), OWNER_A));
    await assert.rejects(
      () => store.read("not-a-preview-id"),
      (error: unknown) => error instanceof ProductLabError && error.code === "preview_error",
    );
  });

  await t.test("reading a preview that was never saved fails closed", async () => {
    const store = createDurableInventoryCountArtifactStore(fakeClient(new Map(), OWNER_A));
    await assert.rejects(
      () => store.read(PREVIEW_ID),
      (error: unknown) => error instanceof ProductLabError && error.code === "preview_error",
    );
  });

  await t.test("a preview survives across two independently-constructed store instances", async () => {
    const db: Database = new Map();
    const writer = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_A));
    await writer.save({ preview: preview() });

    // A fresh store, built from a fresh client object, with no reference to `writer` -- exactly what
    // a second serverless invocation (or a restarted MCP process) constructs.
    const reader = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_A));
    const artifact = await reader.read(PREVIEW_ID);
    assert.equal(artifact.preview.preview_id, PREVIEW_ID);
    assert.equal(artifact.apply_result, undefined);
    assert.equal(artifact.verified_at, undefined);
  });

  await t.test("apply, then verify, preserve each other's fields through the same preview_id", async () => {
    const db: Database = new Map();
    const store = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_A));
    await store.save({ preview: preview() });

    const afterPreview = await store.read(PREVIEW_ID);
    const applyResult = {
      operation_id: afterPreview.preview.operation_id,
      payload_hash: afterPreview.preview.payload_hash,
      applied_reconciliation_events: 1,
      rows: [],
    };
    await store.save({ ...afterPreview, apply_result: applyResult });

    const afterApply = await store.read(PREVIEW_ID);
    assert.deepEqual(afterApply.apply_result, applyResult);
    assert.equal(afterApply.verified_at, undefined);

    await store.save({ ...afterApply, verified_at: "2026-09-14T01:00:00.000Z" });
    const afterVerify = await store.read(PREVIEW_ID);
    // Verify must not have erased the apply result that made verification possible in the first place.
    assert.deepEqual(afterVerify.apply_result, applyResult);
    assert.equal(afterVerify.verified_at, "2026-09-14T01:00:00.000Z");
  });

  await t.test("a preview past its retention window is refused rather than silently applied", async () => {
    const db: Database = new Map();
    const submap = new Map<string, Row>([[PREVIEW_ID, {
      preview: preview(),
      apply_result: null,
      verified_at: null,
      expires_at: "2020-01-01T00:00:00.000Z",
    }]]);
    db.set(OWNER_A, submap);
    const store = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_A));
    await assert.rejects(
      () => store.read(PREVIEW_ID),
      (error: unknown) => error instanceof ProductLabError && error.code === "preview_error" && /expired/.test(error.message),
    );
  });

  // Reviewer fix: preview_id is content-derived, so two different owner accounts counting identical
  // items independently derive the SAME preview_id. The table's primary key is (owner_id, preview_id)
  // precisely so this is not a collision -- see the migration's own commentary.
  await t.test("two owners saving an identical preview_id both succeed and never see or overwrite the other's row", async () => {
    const db: Database = new Map();
    const storeA = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_A));
    const storeB = createDurableInventoryCountArtifactStore(fakeClient(db, OWNER_B));

    // 1 & 2: both owners save the identical content-derived preview.
    await storeA.save({ preview: preview() });
    await storeB.save({ preview: preview() });

    // 3: both succeeded (no throw above) -- neither was refused by a duplicate-key error.
    const readA = await storeA.read(PREVIEW_ID);
    const readB = await storeB.read(PREVIEW_ID);
    // 4: each reads its own row back.
    assert.equal(readA.preview.preview_id, PREVIEW_ID);
    assert.equal(readB.preview.preview_id, PREVIEW_ID);

    // 6: apply/verify-shaped mutation on owner A alone -- unchanged mechanics.
    const applyResult = {
      operation_id: readA.preview.operation_id,
      payload_hash: readA.preview.payload_hash,
      applied_reconciliation_events: 1,
      rows: [],
    };
    await storeA.save({ ...readA, apply_result: applyResult });

    // 5: owner B's independently-stored row must be completely unaffected by owner A's write to the
    // SAME preview_id -- this is the actual "no overwrite" property the composite key exists for.
    const readBAfterAApply = await storeB.read(PREVIEW_ID);
    assert.equal(readBAfterAApply.apply_result, undefined);

    // Owner A's own row did pick up the apply result.
    const readAAfterApply = await storeA.read(PREVIEW_ID);
    assert.deepEqual(readAAfterApply.apply_result, applyResult);

    // Neither owner's fake client (RLS's stand-in here) exposes a way to read the other owner's
    // submap at all -- storeA/storeB are permanently bound to OWNER_A/OWNER_B respectively, exactly
    // as a real authenticated Supabase client is permanently bound to one auth.uid() for its lifetime.
    assert.equal(db.get(OWNER_A)?.size, 1);
    assert.equal(db.get(OWNER_B)?.size, 1);
    assert.notEqual(db.get(OWNER_A), db.get(OWNER_B));
  });
});

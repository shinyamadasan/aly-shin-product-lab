import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SQL = readFileSync(new URL("../supabase-add-batch-with-costing-rpc.sql", import.meta.url), "utf8");
const STATEMENTS = SQL.replaceAll(/--.*$/gm, "");
const FUNCTION_BODY = STATEMENTS.match(/create or replace function create_batch_with_costing\([\s\S]*?\nend \$\$;/i)?.[0] ?? "";

test("create_batch_with_costing is a security-invoker RPC with explicit execute grants", () => {
  assert.notEqual(FUNCTION_BODY, "");
  assert.match(FUNCTION_BODY, /language plpgsql/i);
  assert.match(FUNCTION_BODY, /security invoker/i);
  assert.match(STATEMENTS, /revoke execute on function create_batch_with_costing\(jsonb, jsonb, jsonb, jsonb, jsonb\) from public;/i);
  assert.match(STATEMENTS, /grant execute on function create_batch_with_costing\(jsonb, jsonb, jsonb, jsonb, jsonb\) to authenticated;/i);
});

test("create_batch_with_costing writes the full new-version graph inside one function", () => {
  for (const table of ["product_batches", "costing_entries", "costing_summaries", "selling_formats", "selling_format_packaging_lines"]) {
    assert.match(FUNCTION_BODY, new RegExp(`insert into ${table}`, "i"));
  }

  assert.match(FUNCTION_BODY, /return jsonb_build_object\('batch_id', v_batch_id, 'costing_id', v_costing_id\)/i);
});

test("create_batch_with_costing validates parent-child ownership before writing children", () => {
  assert.match(FUNCTION_BODY, /Costing product_id must match batch product_id/);
  assert.match(FUNCTION_BODY, /Costing batch_id must match batch id/);
  assert.match(FUNCTION_BODY, /Every costing entry must match the new batch product and batch id/);
  assert.match(FUNCTION_BODY, /Every selling format must match the new costing id/);
  assert.match(FUNCTION_BODY, /Every selling format packaging line must belong to a submitted selling format/);
});

test("duplicate version rejection is left to the existing batch-version unique index", () => {
  const uniquenessSql = readFileSync(new URL("../supabase-add-batch-version-uniqueness.sql", import.meta.url), "utf8");

  assert.match(uniquenessSql, /create unique index if not exists product_batches_version_unique_idx\s+on product_batches \(product_id, lower\(trim\(batch_version\)\)\)/i);
  assert.doesNotMatch(FUNCTION_BODY, /on conflict/i);
});

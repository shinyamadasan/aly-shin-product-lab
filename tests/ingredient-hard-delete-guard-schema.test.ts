import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260917090000_ingredient_hard_delete_guard.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

function functionBody(schema: string, name: string) {
  const match = sqlStatementsOnly.match(new RegExp(`create or replace function ${schema}\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `missing function ${schema}.${name}`);
  return match[0];
}

// The real implementation lives in inventory_private -- see the "smallest change to follow the
// existing pattern" round. guardBody is that implementation (auth check, reference count, legacy
// gate, delete). wrapperBody is the thin public.-schema pass-through PostgREST actually exposes.
const guardBody = functionBody("inventory_private", "hard_delete_ingredient_if_unreferenced");
const wrapperBody = functionBody("public", "hard_delete_ingredient_if_unreferenced");
const normalizeBody = functionBody("public", "normalize_ingredient_name_for_delete_guard");
const batchFormulaBody = functionBody("public", "batch_formula_ingredient_names");

// Required test 1 + 2: SECURITY DEFINER, search_path hardened.
test("hard_delete_ingredient_if_unreferenced is SECURITY DEFINER with search_path hardened to empty", () => {
  assert.match(guardBody, /language plpgsql\s+security definer\s+set search_path = ''/i);
  assert.doesNotMatch(guardBody, /security invoker/i);
});

// Required test 3: every table/function reference inside the function body is schema-qualified.
// With search_path = '', an unqualified reference to any of these would fail to resolve at all --
// this is a correctness requirement, not a style preference, so it's asserted exhaustively rather
// than spot-checked.
test("every table and function reference inside hard_delete_ingredient_if_unreferenced is fully schema-qualified", () => {
  for (const ref of [
    "public.ingredients",
    "public.ingredient_hard_delete_policy",
    "public.supply_entries",
    "public.inventory_transactions",
    "public.ingredient_aliases",
    "public.purchase_import_rows",
    "public.selling_format_packaging_lines",
    "public.costing_entries",
    "public.product_batches",
    "public.normalize_ingredient_name_for_delete_guard",
    "public.batch_formula_ingredient_names",
    "public.is_product_lab_owner",
  ]) {
    assert.match(guardBody, new RegExp(ref.replace(".", "\\."), "i"), `missing fully-qualified reference to ${ref}`);
  }

  // Negative check: no bare (unqualified) table name appears anywhere a qualified one is expected
  // -- every `from X`/`into X`/`delete from X` uses the public.-prefixed form.
  for (const bareTable of ["from ingredients ", "from supply_entries ", "from inventory_transactions ", "from ingredient_aliases ", "from purchase_import_rows ", "from selling_format_packaging_lines ", "from costing_entries ", "from product_batches ", "from ingredient_hard_delete_policy "]) {
    assert.doesNotMatch(guardBody, new RegExp(bareTable, "i"), `found an unqualified reference: "${bareTable.trim()}"`);
  }
});

// Required test 4 + 5 (schema-level): owner authorization is checked, and it runs before any
// reference check or mutation -- an unauthorized caller's request never reaches the DELETE
// statement, or any other table access, at all. Whether an unauthorized caller is ACTUALLY
// rejected end-to-end is a live-database behavior (see the live-test checklist) -- this proves the
// check exists and is ordered correctly in the source.
test("hard_delete_ingredient_if_unreferenced checks public.is_product_lab_owner() before any reference check or mutation", () => {
  assert.match(guardBody, /if auth\.uid\(\) is null or public\.is_product_lab_owner\(\) is not true then/i);
  assert.match(guardBody, /raise exception 'Only the product lab owner may permanently delete an ingredient' using errcode = '42501';/i);

  const beginIndex = guardBody.search(/\bbegin\b/i);
  const authCheckIndex = guardBody.search(/if auth\.uid\(\) is null or public\.is_product_lab_owner\(\) is not true then/i);
  const firstTableAccessIndex = guardBody.search(/select name, created_at into v_name, v_created_at from public\.ingredients/i);
  const deleteIndex = guardBody.search(/delete from public\.ingredients where id = p_ingredient_id;/i);
  assert.ok(
    beginIndex !== -1 && authCheckIndex !== -1 && firstTableAccessIndex !== -1 && deleteIndex !== -1 && beginIndex < authCheckIndex && authCheckIndex < firstTableAccessIndex && firstTableAccessIndex < deleteIndex,
    "the owner check must be the first statement after `begin`, before any table access",
  );
});

// Required tests 6 + 7 + 8: EXECUTE is revoked from PUBLIC and anon, granted only to authenticated
// -- on BOTH layers. The wrapper is SECURITY INVOKER, so a caller's own grant on the wrapper is
// what's checked when they call it; the private function's grant is what's checked for the
// wrapper's own inner call, which still runs as the calling role, not the definer's.
test("EXECUTE is revoked from PUBLIC and anon, and granted only to authenticated, on both the private implementation and the public wrapper", () => {
  for (const schema of ["inventory_private", "public"]) {
    const revokePattern = new RegExp(`revoke all on function ${schema}\\.hard_delete_ingredient_if_unreferenced\\(uuid\\) from public, anon, authenticated;`, "i");
    const grantPattern = new RegExp(`grant execute on function ${schema}\\.hard_delete_ingredient_if_unreferenced\\(uuid\\) to authenticated;`, "i");
    assert.match(sqlStatementsOnly, revokePattern, `missing revoke-all on ${schema}.hard_delete_ingredient_if_unreferenced`);
    assert.match(sqlStatementsOnly, grantPattern, `missing grant-to-authenticated on ${schema}.hard_delete_ingredient_if_unreferenced`);

    const revokeIndex = sqlStatementsOnly.search(revokePattern);
    const grantIndex = sqlStatementsOnly.search(grantPattern);
    assert.ok(revokeIndex !== -1 && grantIndex !== -1 && revokeIndex < grantIndex, `revoke must precede grant for ${schema}.hard_delete_ingredient_if_unreferenced`);

    assert.doesNotMatch(
      sqlStatementsOnly,
      new RegExp(`grant execute on function ${schema}\\.hard_delete_ingredient_if_unreferenced\\(uuid\\) to (public|anon)`, "i"),
      `something re-grants execute on ${schema}.hard_delete_ingredient_if_unreferenced to public or anon`,
    );
  }
});

// Confirms the "smallest change to follow the existing pattern" conclusion: the real
// implementation is inventory_private (unreachable via PostgREST regardless of grants, since REST
// only exposes the public schema), exposed through a thin, logic-free public wrapper -- the exact
// shape every other privileged mutation in this schema already uses (see the file header comment
// for the full list of precedents).
test("the public wrapper is a thin, logic-free SECURITY INVOKER pass-through to the inventory_private implementation", () => {
  assert.match(wrapperBody, /language sql\s+security invoker\s+set search_path = ''/i);
  assert.doesNotMatch(wrapperBody, /security definer/i);
  assert.match(wrapperBody, /select inventory_private\.hard_delete_ingredient_if_unreferenced\(p_ingredient_id\);/i);

  // Logic-free: no owner check, no reference-count logic, no table access of its own -- all of
  // that lives only in the private implementation.
  assert.doesNotMatch(wrapperBody, /is_product_lab_owner|v_reference_count|for update/i);
});

// Required test 10: legacy ingredient remains blocked -- unchanged logic, only now schema-qualified.
test("hard_delete_ingredient_if_unreferenced blocks a legacy Item (created before rename-history protection) unconditionally, before checking any reference category", () => {
  assert.match(guardBody, /select protection_active_since into v_protection_active_since from public\.ingredient_hard_delete_policy limit 1;/i);
  assert.match(guardBody, /if v_created_at < v_protection_active_since then\s+raise exception 'Ingredient % was created before rename-history protection was active/i);

  const legacyGateIndex = guardBody.search(/if v_created_at < v_protection_active_since then/i);
  const referenceCountIndex = guardBody.search(/select\s+\(select count\(\*\) from public\.supply_entries/i);
  assert.ok(legacyGateIndex !== -1 && referenceCountIndex !== -1 && legacyGateIndex < referenceCountIndex, "the legacy gate must run before the reference-count check");
});

test("hard_delete_ingredient_if_unreferenced fails loud if the legacy-cutoff policy table has no row, instead of silently treating every Item as new", () => {
  assert.match(guardBody, /if v_protection_active_since is null then\s+raise exception 'ingredient_hard_delete_policy has no row/i);
});

// Required test 12 (existing coverage, preserved): independently re-checks every reference
// category the client guard counts -- unchanged logic, schema-qualified.
test("hard_delete_ingredient_if_unreferenced independently re-checks every reference category the client guard counts", () => {
  for (const table of ["public.supply_entries", "public.inventory_transactions", "public.ingredient_aliases", "public.purchase_import_rows", "public.selling_format_packaging_lines", "public.costing_entries", "public.product_batches"]) {
    assert.match(guardBody, new RegExp(`from ${table.replace(".", "\\.")}`, "i"), `missing reference check against ${table}`);
  }
  assert.match(guardBody, /from public\.supply_entries where ingredient_id = p_ingredient_id/i);
  assert.match(guardBody, /from public\.supply_entries\s+where ingredient_id is null\s+and public\.normalize_ingredient_name_for_delete_guard\(ingredient_name\) = v_normalized_name/i);
  assert.match(guardBody, /from public\.costing_entries\s+where public\.normalize_ingredient_name_for_delete_guard\(ingredient_name\) = v_normalized_name/i);
  assert.match(guardBody, /from public\.product_batches b\s+cross join lateral public\.batch_formula_ingredient_names\(b\.ingredients_notes\)/i);
});

// Required test 9: reference-blocked ingredient remains blocked, writes nothing.
test("hard_delete_ingredient_if_unreferenced blocks deletion when any reference exists and writes nothing", () => {
  assert.match(guardBody, /if v_reference_count > 0 then[\s\S]*raise exception 'Ingredient % cannot be permanently deleted: % existing reference\(s\) found'/i);
  assert.match(guardBody, /existing reference\(s\) found', v_name, v_reference_count;[\s\S]*delete from public\.ingredients where id = p_ingredient_id;/i);
});

// Required test 11: clean ingredient reaches the DELETE path.
test("hard_delete_ingredient_if_unreferenced only deletes when unreferenced, and verifies the delete happened", () => {
  assert.match(guardBody, /delete from public\.ingredients where id = p_ingredient_id;[\s\S]*if not found then[\s\S]*raise exception 'Ingredient % was not found'/i);
});

test("normalize_ingredient_name_for_delete_guard strips package-size fragments, punctuation, and collapses whitespace -- unchanged by the authorization fix", () => {
  assert.match(normalizeBody, /lower\(coalesce\(p_name, ''\)\)/i);
  assert.match(normalizeBody, /\\y\\d\+\(\\\.\\d\+\)\?\\s\*\(g\|grams\?\|kg\|kilograms\?\|ml\|milliliters\?\|millilitres\?\|l\|liters\?\|litres\?\|pcs\?\|pieces\?\|packs\?\|bags\?\)\\y/);
  assert.match(normalizeBody, /\[\^a-z0-9\\s\]/);
  assert.match(normalizeBody, /\\s\+/);
  // Unchanged security posture: no search_path hardening was added here, since it touches no table.
  assert.doesNotMatch(normalizeBody, /security definer/i);
});

test("batch_formula_ingredient_names tolerates invalid JSON and both known ingredients_notes shapes -- unchanged by the authorization fix", () => {
  assert.match(batchFormulaBody, /exception when others then\s+return;/i);
  assert.match(batchFormulaBody, /jsonb_typeof\(v_parsed\) = 'array'/i);
  assert.match(batchFormulaBody, /jsonb_typeof\(v_parsed->'formula'\) = 'array'/i);
  assert.doesNotMatch(batchFormulaBody, /security definer/i);
});

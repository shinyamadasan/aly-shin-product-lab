import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const purchaseImportWizardSource = readFileSync(new URL("../src/components/purchase-import-wizard.tsx", import.meta.url), "utf8");
const bakePageSource = readFileSync(new URL("../src/components/bake-page.tsx", import.meta.url), "utf8");

const sql = readFileSync(new URL("../supabase/migrations/20260917090100_ingredient_rename_history.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

function functionBody(name: string) {
  const match = sqlStatementsOnly.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const ownershipTriggerBody = functionBody("forbid_rename_alias_ownership_change");
const renameTriggerBody = functionBody("preserve_ingredient_rename_history");

test("round 4: rename_ingredient_with_history no longer exists in this file -- superseded by a table-level trigger, not kept alongside it", () => {
  assert.doesNotMatch(sqlStatementsOnly, /rename_ingredient_with_history/);
});

test("the ownership trigger blocks reassignment only of aliases whose CURRENT source is 'rename'", () => {
  assert.match(ownershipTriggerBody, /if old\.source = 'rename' and new\.ingredient_id <> old\.ingredient_id then/i);
  assert.match(ownershipTriggerBody, /raise exception 'Cannot reassign rename-history alias/i);
  // Anything else (a non-rename alias being reassigned, or the SAME ingredient_id) must fall
  // through to `return new;` unchanged -- confirms the trigger does not touch ordinary
  // purchase_import/bake alias reassignment.
  assert.match(ownershipTriggerBody, /return new;/i);
});

test("the ownership trigger is installed BEFORE UPDATE on ingredient_aliases, for every writer", () => {
  assert.match(sqlStatementsOnly, /drop trigger if exists ingredient_aliases_protect_rename_ownership on ingredient_aliases;/i);
  assert.match(
    sqlStatementsOnly,
    /create trigger ingredient_aliases_protect_rename_ownership\s+before update on ingredient_aliases\s+for each row\s+execute function forbid_rename_alias_ownership_change\(\);/i,
  );
});

// Distinct from the test above on purpose: this asserts the NEGATIVE space -- that nothing narrows
// the trigger to a particular caller, role, or app version -- which is the actual property that
// makes a stale deployed frontend, a direct SQL/REST update, or any future code that forgets any
// special API all equally unable to bypass this. A table-level trigger with no WHEN clause and no
// role restriction cannot distinguish "the app called this" from "psql called this" -- there is no
// mechanism by which a caller's identity could ever reach this trigger to opt out.
test("no writer -- old frontend, direct SQL, or future code -- can bypass rename-history preservation: the trigger has no WHEN clause, role filter, or app-specific condition", () => {
  const triggerInstallMatch = sqlStatementsOnly.match(/create trigger ingredients_preserve_rename_history[\s\S]*?execute function preserve_ingredient_rename_history\(\);/i);
  assert.ok(triggerInstallMatch, "expected the ingredients_preserve_rename_history trigger installation statement");
  const triggerInstall = triggerInstallMatch[0];

  assert.doesNotMatch(triggerInstall, /\bwhen\s*\(/i, "a WHEN clause could exempt certain updates -- none exists, so every UPDATE OF name is covered");
  assert.doesNotMatch(triggerInstall, /\bto\s+\w+\s*$/im, "triggers have no role-scoping syntax to begin with, confirming there is no per-caller carve-out");

  // The function itself takes no arguments identifying a caller, session, or app version -- it can
  // only ever see OLD/NEW row data, which is identical regardless of who issued the UPDATE.
  assert.doesNotMatch(renameTriggerBody, /current_user|session_user|application_name/i);
});

test("preserve_ingredient_rename_history is installed as BEFORE UPDATE OF name ON ingredients -- fires for every writer, not only the app", () => {
  assert.match(sqlStatementsOnly, /drop trigger if exists ingredients_preserve_rename_history on ingredients;/i);
  assert.match(
    sqlStatementsOnly,
    /create trigger ingredients_preserve_rename_history\s+before update of name on ingredients\s+for each row\s+execute function preserve_ingredient_rename_history\(\);/i,
  );
});

test("preserve_ingredient_rename_history is a no-op for anything that isn't a genuine (normalized) rename", () => {
  assert.match(renameTriggerBody, /v_normalized_old := normalize_ingredient_name_for_delete_guard\(old\.name\);/i);
  assert.match(renameTriggerBody, /v_normalized_new := normalize_ingredient_name_for_delete_guard\(new\.name\);/i);
  assert.match(renameTriggerBody, /if v_normalized_old = v_normalized_new then\s+[\s\S]*?return new;/i);
});

// Required test 1: no existing alias for OLD.name -> insert a fresh rename alias.
test("no existing alias for OLD.name: preserve_ingredient_rename_history inserts a fresh 'rename'-sourced alias tied to OLD.id", () => {
  assert.match(renameTriggerBody, /insert into ingredient_aliases \(raw_text, normalized_text, ingredient_id, source\)\s+values \(old\.name, v_normalized_old, old\.id, 'rename'\);/i);

  // The alias preservation block must appear BEFORE the final `return new;` that lets the rename
  // through -- so an exception raised while preserving history (either the explicit conflict check
  // below, or the ownership trigger firing on the promotion-in-place update) propagates out of this
  // trigger function and aborts the whole `ingredients` UPDATE statement before NEW.name is ever
  // committed.
  const aliasBlockIndex = renameTriggerBody.search(/select id, ingredient_id into v_existing_alias_id, v_existing_alias_ingredient_id/i);
  const finalReturnIndex = renameTriggerBody.lastIndexOf("return new;");
  assert.ok(aliasBlockIndex !== -1 && finalReturnIndex !== -1 && aliasBlockIndex < finalReturnIndex, "alias preservation must precede the final return that allows the rename");
});

// Required test 2: existing alias for OLD.name already belongs to this same ingredient -> promote
// it in place (no ingredient_id change needed, since it already matches), rename succeeds.
test("existing alias for OLD.name already belongs to the SAME ingredient: preserve_ingredient_rename_history promotes it in place, does not insert a duplicate", () => {
  assert.match(renameTriggerBody, /update ingredient_aliases\s+set source = 'rename', normalized_text = v_normalized_old\s+where id = v_existing_alias_id;/i);

  // This promotion branch must never touch ingredient_id -- it's only reachable when
  // v_existing_alias_ingredient_id already equals old.id (see the conflict check below), so
  // reassigning it would be a no-op at best and is deliberately not attempted.
  const promotionUpdateMatch = renameTriggerBody.match(/update ingredient_aliases\s+set source = 'rename', normalized_text = v_normalized_old\s+where id = v_existing_alias_id;/i);
  assert.ok(promotionUpdateMatch, "expected the same-ingredient promotion update");
  assert.doesNotMatch(promotionUpdateMatch[0], /ingredient_id\s*=/i);
});

// Required tests 3-5: existing alias for OLD.name belongs to a DIFFERENT ingredient (regardless of
// its source) -> abort the rename outright, before ever attempting to touch ingredient_aliases.
// Since the whole rename is one `ingredients` UPDATE statement and this raise happens in a BEFORE
// trigger, NEW.name is never committed (test 4) and the existing alias row is never touched at all
// -- not even attempted -- so it keeps pointing at its original ingredient (test 5). The exact
// rollback/no-write behavior is a Postgres transaction guarantee that requires live verification;
// what's provable here is that the code path that would touch ingredient_aliases is never reached.
test("existing alias for OLD.name belongs to a DIFFERENT ingredient: preserve_ingredient_rename_history raises before touching ingredient_aliases at all", () => {
  assert.match(
    renameTriggerBody,
    /if v_existing_alias_id is not null and v_existing_alias_ingredient_id <> old\.id then\s+[\s\S]*?raise exception 'Cannot rename ingredient/i,
  );

  // The conflict check must appear BEFORE both the promotion-in-place update and the insert
  // branch, so neither is ever reached when the alias belongs to someone else.
  const conflictCheckIndex = renameTriggerBody.search(/if v_existing_alias_id is not null and v_existing_alias_ingredient_id <> old\.id then/i);
  const promotionIndex = renameTriggerBody.search(/update ingredient_aliases\s+set source = 'rename', normalized_text = v_normalized_old/i);
  const insertIndex = renameTriggerBody.search(/insert into ingredient_aliases \(raw_text, normalized_text, ingredient_id, source\)/i);
  assert.ok(
    conflictCheckIndex !== -1 && promotionIndex !== -1 && insertIndex !== -1 && conflictCheckIndex < promotionIndex && conflictCheckIndex < insertIndex,
    "the conflict check must run before either write path",
  );
});

// Required test 6: this is the SAME conflict check as above -- it does not distinguish by source,
// so an existing rename-sourced alias owned by another ingredient is caught by this exact same
// condition (v_existing_alias_ingredient_id <> old.id), not only by the separate ownership trigger.
// Confirms the two mechanisms are consistent, not competing: this function now catches the conflict
// earlier and with a clearer, rename-specific message; the ownership trigger remains as independent
// defense-in-depth against any OTHER direct write to ingredient_aliases (e.g. purchase-import or
// bake-resolution) attempting to steal a rename alias.
test("the conflict check does not distinguish by source -- an existing rename-sourced alias owned by another ingredient is rejected the same way", () => {
  assert.doesNotMatch(renameTriggerBody.match(/if v_existing_alias_id is not null and v_existing_alias_ingredient_id <> old\.id then[\s\S]*?end if;/i)![0], /source/i);
});

test("preserve_ingredient_rename_history locks any existing alias row for the outgoing name before touching it, to serialize concurrent renames/imports/bakes on the same text", () => {
  assert.match(renameTriggerBody, /where lower\(trim\(raw_text\)\) = lower\(trim\(old\.name\)\)\s+for update;/i);
});

test("ingredient_hard_delete_policy is created and seeded AFTER both triggers in this same file -- the cutoff cannot predate the protection it gates", () => {
  const ownershipTriggerIndex = sqlStatementsOnly.search(/create trigger ingredient_aliases_protect_rename_ownership/i);
  const renameTriggerIndex = sqlStatementsOnly.search(/create trigger ingredients_preserve_rename_history/i);
  const policyTableIndex = sqlStatementsOnly.search(/create table if not exists ingredient_hard_delete_policy/i);
  const seedIndex = sqlStatementsOnly.search(/insert into ingredient_hard_delete_policy \(id\)/i);

  assert.ok(
    ownershipTriggerIndex !== -1 && renameTriggerIndex !== -1 && policyTableIndex !== -1 && seedIndex !== -1,
    "expected both triggers, the policy table, and its seed to all exist in this file",
  );
  assert.ok(ownershipTriggerIndex < policyTableIndex, "the alias-ownership trigger must be created before the cutoff table");
  assert.ok(renameTriggerIndex < policyTableIndex, "the ingredients rename-preserving trigger must be created before the cutoff table");
  assert.ok(policyTableIndex < seedIndex, "the table must exist before it is seeded");
});

test("ingredient_hard_delete_policy is a true singleton table (boolean PK checked to always be true)", () => {
  assert.match(sqlStatementsOnly, /id boolean primary key default true,/i);
  assert.match(sqlStatementsOnly, /constraint ingredient_hard_delete_policy_singleton check \(id\)/i);
});

test("the cutoff is seeded once via on conflict do nothing, defaulting to now() at insert time -- never a moving target", () => {
  assert.match(sqlStatementsOnly, /protection_active_since timestamptz not null default now\(\),/i);
  assert.match(sqlStatementsOnly, /insert into ingredient_hard_delete_policy \(id\)\s+values \(true\)\s+on conflict \(id\) do nothing;/i);
});

test("ingredient_hard_delete_policy grants SELECT only -- not even authenticated can write to it", () => {
  assert.match(sqlStatementsOnly, /grant select on table ingredient_hard_delete_policy to authenticated;/i);
  assert.doesNotMatch(sqlStatementsOnly, /grant\s+(?:select,\s*)?(?:insert|update|delete)[^;]*on table ingredient_hard_delete_policy/i);
  assert.match(sqlStatementsOnly, /create policy "Authenticated users can read the hard-delete policy"\s+on ingredient_hard_delete_policy for select/i);
});

// Required tests 7-8: this round's fix lives entirely inside preserve_ingredient_rename_history
// and touches nothing else -- confirming purchase-import and bake-resolution's own call sites are
// byte-for-byte unchanged is what proves their ability to intentionally reassign an ORDINARY
// (non-rename) alias wasn't narrowed by this fix. The actual runtime proof that a reassignment
// still succeeds requires a live database (see the live-test checklist) -- this only proves the
// code path making that call was not touched.
test("purchase-import's ordinary alias-reassignment call sites are unchanged by this round's fix", () => {
  assert.match(purchaseImportWizardSource, /saveIngredientAlias\(row\.rawItemName, ingredientId, "purchase_import"\);/);
  assert.match(purchaseImportWizardSource, /saveIngredientAlias\(row\.rawItemName, newIngredientId, "purchase_import"\);/);
});

test("bake-resolution's ordinary alias-reassignment call site is unchanged by this round's fix", () => {
  assert.match(bakePageSource, /saveIngredientAlias\(row\.ingredientName, ingredientId, "bake"\);/);
});

// Required tests 9-10: this round touches only preserve_ingredient_rename_history. Confirming
// hard_delete_ingredient_if_unreferenced and the client-side guard were not touched (already
// covered by their own, unmodified test files -- tests/ingredient-hard-delete-guard-schema.test.ts
// and tests/inventory-safety.test.ts, both still passing) is what proves acceptance cases #9
// (never-used/never-renamed -> deletable) and #10 (renamed -> permanently blocked, via its own
// alias) still hold. Restated here as an explicit regression guard against this file specifically.
test("this file does not touch hard_delete_ingredient_if_unreferenced or any reference-counting logic -- those guarantees are unchanged", () => {
  assert.doesNotMatch(sqlStatementsOnly, /hard_delete_ingredient_if_unreferenced/);
});

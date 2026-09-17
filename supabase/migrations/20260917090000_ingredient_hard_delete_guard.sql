-- Server-side safety net for permanently deleting an Item (ingredient). The reference-count guard
-- that decides whether an Item is safe to hard-delete already exists client-side
-- (getItemReferenceSummary / canHardDeleteItem, src/lib/inventory-safety.ts) and is what produces
-- the operator's specific, itemized "blocked because X" message. hard_delete_ingredient_if_
-- unreferenced re-runs that SAME check directly against the database, inside the same transaction
-- as the delete, so a reference created between the client's check and this call (a second tab
-- logging a purchase, a bake confirming, etc.) still blocks the delete instead of silently
-- succeeding.
--
-- It mirrors every one of the eight reference categories inventory-safety.ts already counts --
-- durable ids first, then the name-matched "legacy text" categories that have no foreign key at
-- all (supply_entries can carry an unmatched ingredient_name with a null ingredient_id;
-- costing_entries and product_batches.ingredients_notes reference ingredients purely by name,
-- never by id). Keep this file's reference categories in sync with getItemReferenceSummary if that
-- function ever changes.
--
-- Renamed ingredients: the three name-matched categories above compare against the ingredient's
-- CURRENT name only -- if it was ever renamed, a costing/batch/purchase record still holding its
-- OLD name would no longer match and would silently look safe to delete. This file does not solve
-- that by itself; a BEFORE UPDATE OF name trigger on `ingredients`
-- (ingredients_preserve_rename_history, see the ingredient_rename_history migration -- apply that
-- one after this one) does, by preserving every genuine rename's outgoing name as a permanent,
-- ownership-immutable ingredient_aliases row (source "rename") inside the SAME statement as the
-- name change -- enforced at the table level, for every writer, not only the app. This function's
-- durable.aliases check (below) already blocks a delete for ANY alias regardless of source, so a
-- renamed ingredient is correctly, permanently blocked with no change needed to that check itself.
--
-- That still leaves ingredients that already existed, and may already have been renamed, before
-- that trigger existed to record it -- for those, "no reference found" cannot be trusted, because a
-- prior rename could have happened with nothing recording it. This function closes that gap by
-- refusing to hard-delete anything created before rename-history protection was ACTUALLY active
-- (see the created_at check below and public.ingredient_hard_delete_policy, whose single seeded row
-- is defined at the end of the ingredient_rename_history migration, textually after both of that
-- migration's triggers -- specifically so the cutoff it records can never predate the protection
-- it's meant to gate).
--
-- Authorization: SECURITY DEFINER, hardened per this repo's established convention (see
-- inventory_private.apply_raw_inventory_adjustment in
-- 20260909132327_selling_wave_0a_raw_authority.sql) -- `set search_path = ''` so the function
-- cannot be redirected by a caller's search_path, every table/function reference fully schema-
-- qualified as a result, and the same public.is_product_lab_owner() ownership check the ingredients
-- table's own DELETE RLS policy already uses, re-implemented explicitly here because a SECURITY
-- DEFINER function's underlying table access bypasses RLS entirely -- the RLS policy is simply
-- never consulted for this function's own DELETE statement, so the equivalent check must happen in
-- the function body itself, before any reference check or mutation. Previously SECURITY INVOKER:
-- that was the actual production defect this migration fixes -- `authenticated` was never granted
-- DELETE on public.ingredients directly (see 20260909132327_selling_wave_0a_raw_authority.sql's
-- revoke of the original blanket grant), so a real authenticated app call could never reach the
-- DELETE statement at all, regardless of how safe the target ingredient was. A SQL-Editor test
-- (running as postgres/superuser) would not have caught this, since superuser bypasses grants
-- entirely.
--
-- Placement: the real implementation lives in inventory_private, not public, exposed through a
-- thin public.hard_delete_ingredient_if_unreferenced wrapper (SECURITY INVOKER, does nothing but
-- delegate). This is not an added layer for its own sake -- it is the SAME shape every other
-- privileged mutation in this schema already uses (inventory_private.apply_raw_inventory_
-- adjustment / public.apply_raw_inventory_adjustment; inventory_private.update_posted_purchase_
-- metadata / public.X; confirm_purchase_import_v2, confirm_bake_v2/v3, confirm_order_with_
-- reservation, cancel_order_with_release, complete_order_with_fulfillment, record_finished_stock_
-- exception, certify_ingredient_cost_baseline, apply_inventory_physical_count_batch -- all
-- inventory_private + public pairs, all across 20260909132327 through 20260912193053). Matching it
-- here instead of leaving this as the one privileged mutation living directly in public is what
-- "smallest change that follows the existing pattern" means in this repo: PostgREST only exposes
-- the public schema at all, so inventory_private.X can never be reached over the REST API
-- regardless of any grant -- a mistake in this function's own grants stays contained to a schema
-- the network surface cannot address in the first place, on top of (not instead of) the in-body
-- owner check and the EXECUTE grants below. inventory_private's schema-level USAGE grant to
-- authenticated already exists (granted once, in 20260909132327_selling_wave_0a_raw_authority.sql)
-- -- nothing here needs to touch it again.
--
-- EXECUTE is explicitly revoked from PUBLIC and anon and granted only to authenticated on BOTH the
-- private implementation and the public wrapper -- required for any SECURITY DEFINER function,
-- since it runs with elevated privilege regardless of who calls it; the in-body owner check is what
-- actually gates who may use that privilege, but the grant itself must not let an anonymous caller
-- reach the function in the first place. The wrapper needs its own matching grant too: it is
-- SECURITY INVOKER, so calling it (and its inner call to the private function) still runs as
-- whichever role calls it -- the grant chain matters at both layers, not just the definer one.
--
-- Safe to run more than once (create or replace function). Purely additive: no existing table,
-- column, or FK is altered.

-- Mirrors src/lib/ingredient-normalization.ts normalizeIngredientName exactly (lowercase, strip
-- package-size fragments, strip punctuation, collapse whitespace, trim) so a name match here means
-- the same thing it means in the client-side reference summary. \y is Postgres's word-boundary
-- escape (its \b means backspace, unlike JavaScript's \b). Keep both in sync if
-- normalizeIngredientName ever changes.
--
-- Unchanged from its original definition -- touches no table, so its security/search_path posture
-- is not part of this migration's authorization fix.
create or replace function public.normalize_ingredient_name_for_delete_guard(p_name text)
returns text
language sql
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(coalesce(p_name, '')),
          '\y\d+(\.\d+)?\s*(g|grams?|kg|kilograms?|ml|milliliters?|millilitres?|l|liters?|litres?|pcs?|pieces?|packs?|bags?)\y',
          ' ',
          'g'
        ),
        '[^a-z0-9\s]', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

grant execute on function public.normalize_ingredient_name_for_delete_guard(text) to authenticated;

-- Extracts every formula-row ingredient name out of a product_batches.ingredients_notes value,
-- tolerating both JSON shapes that column has ever held (a bare array of formula rows, or
-- {formula: [...], steps: [...]}) and any non-JSON/invalid text -- mirrors parseBatchRecord's
-- try/catch-then-empty behavior (src/lib/batches.ts) exactly: anything that isn't parseable
-- yields zero rows rather than raising.
--
-- Unchanged from its original definition, same reasoning as above.
create or replace function public.batch_formula_ingredient_names(p_notes text)
returns setof text
language plpgsql
as $$
declare
  v_parsed jsonb;
  v_formula jsonb;
begin
  if p_notes is null or btrim(p_notes) = '' then
    return;
  end if;

  begin
    v_parsed := p_notes::jsonb;
  exception when others then
    return;
  end;

  if jsonb_typeof(v_parsed) = 'array' then
    v_formula := v_parsed;
  elsif jsonb_typeof(v_parsed) = 'object' and jsonb_typeof(v_parsed->'formula') = 'array' then
    v_formula := v_parsed->'formula';
  else
    return;
  end if;

  return query
    select elem->>'ingredient'
    from jsonb_array_elements(v_formula) as elem
    where nullif(elem->>'ingredient', '') is not null;
end;
$$;

grant execute on function public.batch_formula_ingredient_names(text) to authenticated;

create or replace function inventory_private.hard_delete_ingredient_if_unreferenced(p_ingredient_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_created_at timestamptz;
  v_protection_active_since timestamptz;
  v_normalized_name text;
  v_reference_count integer;
begin
  -- Authorization first, before any reference check or mutation. Re-implements the same rule as
  -- public.ingredients' own DELETE RLS policy (using (public.is_product_lab_owner())), because a
  -- SECURITY DEFINER function's own statements run as this function's owner and bypass RLS on the
  -- tables it touches entirely -- that policy is never actually consulted for the DELETE below, so
  -- this check is what makes the ownership rule real for this path.
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may permanently delete an ingredient' using errcode = '42501';
  end if;

  if p_ingredient_id is null then
    raise exception 'Ingredient id is required';
  end if;

  -- Locks the row for the rest of this transaction: a concurrent archive/restore/save/delete on
  -- the same Item waits behind this call (or this call waits behind it), so those writers can
  -- never interleave. It does not, by itself, stop a *different* table gaining a brand-new
  -- reference row mid-check -- every id-based category is backstopped by its own FK
  -- (RESTRICT/CASCADE/SET NULL) should this check ever be bypassed, including supply_entries (see
  -- the supply_entries_ingredient_fk migration -- RESTRICT, added NOT VALID so it only protects
  -- writes from that migration onward). The three name-only categories (costing_entries,
  -- product_batches formula text, unmatched supply_entries text) have no id to backstop with an FK
  -- at all; they rely entirely on this check and the client-side one matching.
  select name, created_at into v_name, v_created_at from public.ingredients where id = p_ingredient_id for update;

  if v_name is null then
    raise exception 'Ingredient % was not found', p_ingredient_id;
  end if;

  -- Legacy gate, checked before the reference count: an ingredient created before rename-history
  -- protection existed may already have been renamed with nothing recording it (see this file's
  -- header comment). "No reference found under the current name" cannot be trusted for it, so it
  -- is archive-only, unconditionally -- regardless of what the reference count below would say.
  -- There is no override for this. public.ingredient_hard_delete_policy holds exactly one row,
  -- seeded once with the moment this protection went live; it is never updated by the application.
  select protection_active_since into v_protection_active_since from public.ingredient_hard_delete_policy limit 1;

  if v_protection_active_since is null then
    raise exception 'ingredient_hard_delete_policy has no row -- apply the ingredient_rename_history migration (creates and seeds it) before this function can be used';
  end if;

  if v_created_at < v_protection_active_since then
    raise exception 'Ingredient % was created before rename-history protection was active and cannot be permanently deleted: its usage under any earlier name cannot be verified. Archive it instead', v_name;
  end if;

  v_normalized_name := public.normalize_ingredient_name_for_delete_guard(v_name);

  select
    (select count(*) from public.supply_entries where ingredient_id = p_ingredient_id) +
    (select count(*) from public.supply_entries
       where ingredient_id is null
         and public.normalize_ingredient_name_for_delete_guard(ingredient_name) = v_normalized_name) +
    (select count(*) from public.inventory_transactions where ingredient_id = p_ingredient_id) +
    (select count(*) from public.ingredient_aliases where ingredient_id = p_ingredient_id) +
    (select count(*) from public.purchase_import_rows where ingredient_id = p_ingredient_id) +
    (select count(*) from public.selling_format_packaging_lines where ingredient_id = p_ingredient_id) +
    (select count(*) from public.costing_entries
       where public.normalize_ingredient_name_for_delete_guard(ingredient_name) = v_normalized_name) +
    (select count(*)
       from public.product_batches b
       cross join lateral public.batch_formula_ingredient_names(b.ingredients_notes) as formula_ingredient
       where public.normalize_ingredient_name_for_delete_guard(formula_ingredient) = v_normalized_name)
  into v_reference_count;

  if v_reference_count > 0 then
    raise exception 'Ingredient % cannot be permanently deleted: % existing reference(s) found', v_name, v_reference_count;
  end if;

  delete from public.ingredients where id = p_ingredient_id;

  if not found then
    raise exception 'Ingredient % was not found', p_ingredient_id;
  end if;
end;
$$;

revoke all on function inventory_private.hard_delete_ingredient_if_unreferenced(uuid) from public, anon, authenticated;
grant execute on function inventory_private.hard_delete_ingredient_if_unreferenced(uuid) to authenticated;

-- Thin, deliberately dumb: no logic, no auth check of its own -- see the file header comment for
-- why this wrapper exists at all. Mirrors inventory_private.update_posted_purchase_metadata /
-- public.update_posted_purchase_metadata exactly, including the void-returning SQL-language
-- pass-through shape.
create or replace function public.hard_delete_ingredient_if_unreferenced(p_ingredient_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select inventory_private.hard_delete_ingredient_if_unreferenced(p_ingredient_id);
$$;

revoke all on function public.hard_delete_ingredient_if_unreferenced(uuid) from public, anon, authenticated;
grant execute on function public.hard_delete_ingredient_if_unreferenced(uuid) to authenticated;

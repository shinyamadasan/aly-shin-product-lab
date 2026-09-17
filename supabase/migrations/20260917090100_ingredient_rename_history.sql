-- Round 3 added rename_ingredient_with_history, an RPC that atomically preserved an ingredient's
-- outgoing name as a permanent alias in the same transaction as the name change. That closed the
-- two-step-client-coordination gap, but the safety invariant still depended on every writer
-- CHOOSING to call that RPC -- a plain supabase.from("ingredients").update({ name }) (which
-- saveIngredient's own general field-save already issues on every save, rename or not), a stale
-- deployed frontend that predates the RPC, a direct SQL/REST call, or any future code that forgets
-- the special API would all rename an ingredient with no history preserved at all, silently
-- defeating the whole guard.
--
-- Round 4 moves the invariant into the table itself: ingredients_preserve_rename_history is a
-- BEFORE UPDATE OF name trigger on `ingredients`. It fires for every writer, unconditionally,
-- regardless of what issued the UPDATE -- the app, an old cached frontend, psql, curl against the
-- REST API, anything. Genuine renames can no longer commit without their old name being preserved;
-- non-renames (including saveIngredient re-affirming the unchanged name on every ordinary edit) are
-- a no-op. This makes rename_ingredient_with_history redundant -- a database invariant every writer
-- automatically obeys is strictly simpler and more robust than an API every writer must remember to
-- call, so that RPC has been removed rather than kept alongside a competing mechanism. saveIngredient
-- (src/app/product-lab.tsx) now issues one plain update again, exactly as it did before round 2.
--
-- This still leaves ingredient_aliases' existing "find by raw text, update in place" pattern
-- (saveIngredientAlias, used by CSV-import matching and bake-formula resolution, and now also by
-- this file's own trigger) able to silently reassign an alias from one ingredient to another.
-- That's fine -- intentional, even -- for an ordinary matching alias (correcting a mismatch IS the
-- point), but not for a "rename" alias: once ingredient_aliases.source = 'rename', that row is the
-- only durable evidence that this exact ingredient once had this exact name, and reassigning it to
-- a different ingredient would silently destroy that evidence (example: ingredient A is renamed
-- from "Old Name", which protects A from hard-delete; later, an unrelated CSV import or bake
-- resolves the text "Old Name" to ingredient B; without the trigger below, that would silently
-- steal the alias away from A). forbid_rename_alias_ownership_change makes rename-sourced aliases
-- immutable in ownership, enforced at the table level for every writer to ingredient_aliases too --
-- only an alias whose CURRENT source is 'rename' is protected; nothing here restricts the two
-- existing workflows from reassigning each other's ordinary aliases as before. Unchanged from round
-- 3 -- kept exactly as it was.
--
-- Requires public.normalize_ingredient_name_for_delete_guard, defined in the
-- ingredient_hard_delete_guard migration -- apply that one first.
--
-- Unrelated to the authorization fix in ingredient_hard_delete_guard: both triggers here stay
-- SECURITY INVOKER, unqualified, exactly as originally written. ingredient_aliases was never
-- locked down the way ingredients/inventory_transactions/supply_entries were (Wave 0A), so
-- `authenticated` still has its original direct grants there and these triggers need no privilege
-- escalation to do their job. Not touched by this authorization-repair pass.
--
-- Safe to run more than once (create or replace function/trigger; the policy seed at the bottom
-- uses `on conflict do nothing`).

create or replace function forbid_rename_alias_ownership_change()
returns trigger
language plpgsql
as $$
begin
  if old.source = 'rename' and new.ingredient_id <> old.ingredient_id then
    raise exception 'Cannot reassign rename-history alias "%" from ingredient % to ingredient %: rename-history aliases are immutable once created', old.raw_text, old.ingredient_id, new.ingredient_id;
  end if;
  return new;
end;
$$;

drop trigger if exists ingredient_aliases_protect_rename_ownership on ingredient_aliases;

create trigger ingredient_aliases_protect_rename_ownership
  before update on ingredient_aliases
  for each row
  execute function forbid_rename_alias_ownership_change();

-- The actual invariant: "it is impossible for Postgres to commit a genuine ingredient rename
-- without preserving its old name." BEFORE UPDATE OF name fires whenever an UPDATE statement's SET
-- clause mentions `name` at all -- including saveIngredient's general field save, which always
-- re-sends the current name whether or not it changed -- so the normalized-name comparison below,
-- not "did the trigger fire," is what decides whether this is a genuine rename. Raising here aborts
-- the entire triggering UPDATE statement; there is no path from a raised exception back to a
-- committed name change.
--
-- ingredient_aliases_raw_text_idx (supabase-add-inventory.sql) is a unique index on
-- lower(trim(raw_text)) -- the collision key below matches that exactly, not an assumption. An
-- existing row for OLD.name can belong to: (a) this same ingredient already (some earlier
-- purchase-import/bake resolution happened to alias this exact text to itself, or a previous
-- rename already claimed it) -- safe to promote in place; or (b) a DIFFERENT ingredient. The
-- ownership-immutability trigger above only blocks reassigning an alias whose CURRENT source is
-- already 'rename' -- deliberately, so purchase-import and bake-resolution keep the ability to
-- reassign an ORDINARY alias between ingredients, which is a real, relied-on feature (correcting a
-- wrong auto-match). That means an ordinary, non-rename alias belonging to a different ingredient
-- would sail straight through that trigger if this function tried to repoint it -- silently
-- stealing it from whichever ingredient it actually belonged to, just because this ingredient
-- happened to be renamed away from the same text. The explicit ingredient_id check below is what
-- stops that: it aborts the rename outright rather than ever attempting that update, so this
-- function never even asks the other trigger to make the call.
create or replace function preserve_ingredient_rename_history()
returns trigger
language plpgsql
as $$
declare
  v_normalized_old text;
  v_normalized_new text;
  v_existing_alias_id uuid;
  v_existing_alias_ingredient_id uuid;
begin
  v_normalized_old := normalize_ingredient_name_for_delete_guard(old.name);
  v_normalized_new := normalize_ingredient_name_for_delete_guard(new.name);

  if v_normalized_old = v_normalized_new then
    -- Not a genuine rename -- identical, or only a case/whitespace/punctuation edit that
    -- normalizes to the same text. Nothing to preserve; let the update proceed untouched.
    return new;
  end if;

  -- Preserve OLD.name BEFORE allowing NEW.name through. Locks any existing alias row for this raw
  -- text first so a concurrent write to the SAME text (another rename, a purchase-import match, a
  -- bake resolution) can't race this check.
  select id, ingredient_id into v_existing_alias_id, v_existing_alias_ingredient_id
    from ingredient_aliases
    where lower(trim(raw_text)) = lower(trim(old.name))
    for update;

  if v_existing_alias_id is not null and v_existing_alias_ingredient_id <> old.id then
    -- Belongs to someone else -- rename-history preservation must never silently steal it,
    -- regardless of its current source. Abort here, before attempting any write to
    -- ingredient_aliases at all: old.id keeps old.name, and NEW.name is never committed.
    raise exception 'Cannot rename ingredient "%" to "%": its previous name "%" is currently mapped to a different ingredient (%). Resolve the alias conflict first.', old.name, new.name, old.name, v_existing_alias_ingredient_id;
  end if;

  if v_existing_alias_id is not null then
    -- Already belongs to this same ingredient (an earlier resolution or an earlier rename already
    -- claimed this exact text for it) -- safe to promote in place. Whatever workflow created it,
    -- it now becomes durable rename-history evidence going forward; findAliasMatch
    -- (src/lib/ingredient-matching.ts) matches purely on normalized raw text and never reads
    -- source, so this promotion changes nothing about how CSV import or bake resolution match
    -- against it -- the only effect is that ingredient_aliases_protect_rename_ownership will not
    -- let it be reassigned away from this ingredient from this point on.
    update ingredient_aliases
    set source = 'rename', normalized_text = v_normalized_old
    where id = v_existing_alias_id;
  else
    insert into ingredient_aliases (raw_text, normalized_text, ingredient_id, source)
    values (old.name, v_normalized_old, old.id, 'rename');
  end if;

  return new;
end;
$$;

drop trigger if exists ingredients_preserve_rename_history on ingredients;

create trigger ingredients_preserve_rename_history
  before update of name on ingredients
  for each row
  execute function preserve_ingredient_rename_history();

-- ingredient_hard_delete_policy's single row records the moment hard-delete can start trusting
-- "no reference found" for an ingredient's ENTIRE lifetime. That moment is NOT "whenever this
-- table happens to get created" -- it is the moment the trigger directly above this comment
-- actually exists and is enforcing, because that trigger is what guarantees no rename can happen
-- unrecorded from here on. This table and its seed are placed at the END of this same file,
-- textually after both triggers, specifically so that when this migration is applied, `now()`
-- below cannot possibly be captured before ingredients_preserve_rename_history exists. Do not move
-- this section above the triggers, and do not apply it as a separate, earlier migration -- an
-- earlier iteration of this guard did exactly that (a standalone legacy-cutoff file, applied
-- first, on a different branch that never reached main) and that ordering is exactly the bug this
-- section fixes: it left a window where an ingredient could be created and classified "new" before
-- rename protection actually existed for it. See the ingredient_hard_delete_guard migration for how
-- this value is used.
--
-- Grants SELECT only, nothing else -- not even to `authenticated` -- unlike every other table in
-- this schema. Nothing in this app should ever be able to move this cutoff, and the grants
-- themselves enforce that regardless of what any future RLS policy might say. id is a boolean,
-- checked to always equal true, specifically to make this a true singleton table -- a second row
-- is a primary-key violation, not merely a convention. Seeded once via `on conflict do nothing`, so
-- re-running this migration later never moves the cutoff forward.
create table if not exists ingredient_hard_delete_policy (
  id boolean primary key default true,
  protection_active_since timestamptz not null default now(),
  constraint ingredient_hard_delete_policy_singleton check (id)
);

insert into ingredient_hard_delete_policy (id)
values (true)
on conflict (id) do nothing;

alter table ingredient_hard_delete_policy enable row level security;

grant select on table ingredient_hard_delete_policy to authenticated;

drop policy if exists "Authenticated users can read the hard-delete policy" on ingredient_hard_delete_policy;

create policy "Authenticated users can read the hard-delete policy"
  on ingredient_hard_delete_policy for select
  to authenticated
  using (true);

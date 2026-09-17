-- Safe Purchase Delete single-shot assertions. Everything here runs inside one transaction and
-- rolls back, same convention as selling-wave-0b-safe-mutations.assertions.sql.
begin;

create temporary table spd_ids as select
  gen_random_uuid() as flour_id, gen_random_uuid() as new_item_id, gen_random_uuid() as unpriced_id,
  gen_random_uuid() as blocked_id, gen_random_uuid() as csv_id, gen_random_uuid() as import_id,
  gen_random_uuid() as zero_certified_id, gen_random_uuid() as zero_zero_id, gen_random_uuid() as zero_null_id,
  gen_random_uuid() as legacy_id, gen_random_uuid() as legacy_ambiguous_id, gen_random_uuid() as tie_high_id,
  gen_random_uuid() as tie_low_id, gen_random_uuid() as other_id;
grant select on spd_ids to authenticated;

insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
  select flour_id, 'SPD Flour', 'g', 1000, 2.0, now() from spd_ids
  union all select new_item_id, 'SPD New Item', 'g', 0, 0, now() from spd_ids
  union all select unpriced_id, 'SPD Unpriced', 'g', 500, 1.5, now() from spd_ids
  union all select blocked_id, 'SPD Blocked', 'g', 1000, 2.0, now() from spd_ids
  union all select csv_id, 'SPD CSV Item', 'g', 400, 1.0, now() from spd_ids
  -- Simulates Cost Baseline Repair's own documented state: current_quantity = 0 with a durably
  -- certified, positive average_unit_cost -- certify_ingredient_cost_baseline permits exactly this
  -- (it never requires positive quantity), independent of whichever migration certified it.
  union all select zero_certified_id, 'SPD Zero Certified', 'g', 0, 2.0, now() from spd_ids
  union all select zero_zero_id, 'SPD Zero Zero', 'g', 0, 0, now() from spd_ids
  union all select zero_null_id, 'SPD Zero Null', 'g', 0, null, now() from spd_ids
  union all select legacy_id, 'SPD Legacy', 'g', 0, 5.0, now() from spd_ids
  union all select legacy_ambiguous_id, 'SPD Legacy Ambiguous', 'g', 20, 10.0, now() from spd_ids
  union all select tie_high_id, 'SPD Tie High', 'g', 1000, 2.0, now() from spd_ids
  union all select tie_low_id, 'SPD Tie Low', 'g', 1000, 2.0, now() from spd_ids
  union all select other_id, 'SPD Other', 'g', 100, 1.0, now() from spd_ids;

insert into public.purchase_imports (id, file_name, status, supplier_name, receipt_number, purchase_date)
  select import_id, 'spd.csv', 'draft', 'SM', 'R-1', current_date from spd_ids;

insert into public.purchase_import_rows (import_id, row_index, raw_item_name, raw_quantity, raw_unit, raw_total_price,
  parsed_quantity, parsed_total_price, ingredient_id, match_method, converted_quantity, row_status, brand_name)
  select import_id, 0, 'CSV Item', '100', 'g', '100', 100, 100, csv_id, 'exact', 100, 'matched', 'Local' from spd_ids;

-- supply_entries has no direct authenticated grants (Wave 0A) -- these fixture rows (already-
-- existing purchases predating this migration, or never matched to an Item) are inserted as
-- superuser, the same way every other fixture row above is, since the RPC under test is what's
-- being exercised, not the (already fully revoked) direct-insert path.
create temporary table spd_unmatched as select gen_random_uuid() as supply_id, gen_random_uuid() as malformed_supply_id;
grant select on spd_unmatched to authenticated;
insert into public.supply_entries (id, ingredient_id, ingredient_name, supplier_name, pack_quantity, unit, total_cost)
  select supply_id, null::uuid, 'Unknown Thing', 'SM', 1, 'g', 10 from spd_unmatched
  union all select malformed_supply_id, null::uuid, 'Malformed Thing', 'SM', 1, 'g', 10 from spd_unmatched;

-- A legacy purchase: what post_raw_purchase produced BEFORE purchase_reversal_snapshot existed --
-- same shape (a real supply_entries row plus its matching ledger row, quantity_before = 0, priced),
-- just with purchase_reversal_snapshot left null, exactly as every pre-migration row's would be.
create temporary table spd_legacy as select gen_random_uuid() as supply_id;
grant select on spd_legacy to authenticated;
insert into public.supply_entries (id, ingredient_id, ingredient_name, supplier_name, pack_quantity, unit, total_cost)
  select supply_id, legacy_id, 'SPD Legacy', 'SM', 200, 'g', 1000 from spd_legacy, spd_ids;
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before,
  quantity_after, source_type, source_id, note, created_at, purchase_reversal_snapshot)
  select legacy_id, 'purchase', 200, 0, 200, 'manual', supply_id::text, '', now(), null from spd_legacy, spd_ids;
update public.ingredients set current_quantity = 200, average_unit_cost = 5.0 where id = (select legacy_id from spd_ids);

-- A legacy purchase (no snapshot) with quantity_before > 0, constructed so the algebraic
-- reconstruction lands on exactly 0 -- current_quantity 20, average_unit_cost 10.0 (= total_cost /
-- current_quantity, i.e. exactly what the forward formula produces whether the true prior average
-- was NULL or was genuinely 0; average_unit_cost is nullable and the forward formula always reads
-- it through coalesce(..., 0), so both backstories are literally indistinguishable from this
-- post-purchase state alone -- (20*10.0 - 200)/10 = 0). Stands for BOTH the "prior was null" and
-- the "prior was genuinely 0" cases at once: there is no way to construct a fixture that is
-- specifically one and not the other, which is exactly the point being tested.
create temporary table spd_legacy_ambiguous as select gen_random_uuid() as supply_id;
grant select on spd_legacy_ambiguous to authenticated;
insert into public.supply_entries (id, ingredient_id, ingredient_name, supplier_name, pack_quantity, unit, total_cost)
  select supply_id, legacy_ambiguous_id, 'SPD Legacy Ambiguous', 'SM', 10, 'g', 200 from spd_legacy_ambiguous, spd_ids;
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before,
  quantity_after, source_type, source_id, note, created_at, purchase_reversal_snapshot)
  select legacy_ambiguous_id, 'purchase', 10, 10, 20, 'manual', supply_id::text, '', now(), null from spd_legacy_ambiguous, spd_ids;

-- A malformed/legacy ledger row that carries an unmatched purchase's id as its source_id --
-- source_id is a loose text column, not a foreign key to supply_entries, so this must be possible
-- to construct and must be caught, not merely assumed impossible.
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before,
  quantity_after, source_type, source_id, note, created_at)
  select other_id, 'purchase', 10, 100, 110, 'manual', malformed_supply_id::text, 'stray', now() from spd_unmatched, spd_ids;
update public.ingredients set current_quantity = 110 where id = (select other_id from spd_ids);

set local role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  ids record; op uuid; r jsonb;
  supply_id uuid; tx_id uuid;
  qty numeric; avgc numeric; supply_count bigint; tx_count bigint;
begin
  select * into ids from spd_ids;

  -- ============================== Exact reversal: ordinary purchase ==============================
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.flour_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'ok');
  supply_id := (r->>'supply_id')::uuid;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.flour_id;
  if qty <> 1500 or avgc <> 2.0 then raise exception 'TEST FAILED: setup purchase produced wrong state (qty % / avg %)', qty, avgc; end if;

  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  if (r->>'reversed')::boolean is not true then raise exception 'TEST FAILED: ordinary reversible purchase was not reversed'; end if;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.flour_id;
  if qty <> 1000 or avgc <> 2.0 then raise exception 'TEST FAILED: exact reversal produced wrong state (qty % / avg %)', qty, avgc; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 0 then raise exception 'TEST FAILED: deleted purchase row still exists'; end if;
  select count(*) into tx_count from public.inventory_transactions where ingredient_id = ids.flour_id;
  if tx_count <> 0 then raise exception 'TEST FAILED: deleted purchase left a ledger row behind'; end if;

  -- =============== Exact reversal: first-ever purchase, previous average genuinely 0 ===============
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.new_item_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'first');
  supply_id := (r->>'supply_id')::uuid;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.new_item_id;
  if qty <> 500 or avgc <> 2.0 then raise exception 'TEST FAILED: first-purchase setup produced wrong state (qty % / avg %)', qty, avgc; end if;

  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.new_item_id;
  if qty <> 0 or avgc <> 0 then raise exception 'TEST FAILED: reversing a first-ever purchase (previous average genuinely 0) left qty/avg at % / % (expected 0/0)', qty, avgc; end if;

  -- ===== REGRESSION: zero prior quantity, positive CERTIFIED prior average (Cost Baseline Repair) =====
  -- The exact defect independent review found: quantity_before = 0 does not prove the previous
  -- average_unit_cost was 0. Must restore 2.0 exactly, never guess/reset to 0.
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.zero_certified_id, 100, 'g', 100, 300, 'Local', 'SM', current_date, 5, 'from-certified-zero');
  supply_id := (r->>'supply_id')::uuid;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.zero_certified_id;
  if qty <> 100 or avgc <> 3.0 then raise exception 'TEST FAILED: certified-zero-quantity purchase setup produced wrong state (qty % / avg %)', qty, avgc; end if;

  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.zero_certified_id;
  if qty <> 0 or avgc <> 2.0 then raise exception 'TEST FAILED: reversing a purchase from certified-zero-quantity did not restore the exact prior average (qty % / avg %, expected 0/2.0)', qty, avgc; end if;

  -- ============ Snapshot restores a genuinely-0 or genuinely-null prior average exactly ============
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.zero_zero_id, 50, 'g', 50, 100, 'Local', 'SM', current_date, 5, 'from-zero-zero');
  supply_id := (r->>'supply_id')::uuid;
  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.zero_zero_id;
  if qty <> 0 or avgc <> 0 then raise exception 'TEST FAILED: snapshot-based reversal of a genuinely-0 prior average produced % / % (expected 0/0)', qty, avgc; end if;

  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.zero_null_id, 50, 'g', 50, 100, 'Local', 'SM', current_date, 5, 'from-zero-null');
  supply_id := (r->>'supply_id')::uuid;
  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.zero_null_id;
  if qty <> 0 or avgc is not null then raise exception 'TEST FAILED: snapshot-based reversal of a genuinely-null prior average produced % / % (expected 0/null)', qty, avgc; end if;

  -- =========================== Exact reversal: unpriced purchase leaves cost alone ===========================
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.unpriced_id, 200, 'g', 200, 0, 'Local', 'SM', current_date, 5, 'unpriced');
  supply_id := (r->>'supply_id')::uuid;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.unpriced_id;
  if qty <> 700 or avgc <> 1.5 then raise exception 'TEST FAILED: unpriced purchase setup produced wrong state (qty % / avg %)', qty, avgc; end if;

  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.unpriced_id;
  if qty <> 500 or avgc <> 1.5 then raise exception 'TEST FAILED: reversing an unpriced purchase changed cost (qty % / avg %, expected 500/1.5)', qty, avgc; end if;

  -- ============== Legacy purchase (no snapshot), quantity_before = 0: refused, never guessed ==============
  select spd_legacy.supply_id into supply_id from spd_legacy;
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: a legacy zero-prior-quantity purchase without a snapshot was deleted';
  exception when check_violation then null; end;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.legacy_id;
  if qty <> 200 or avgc <> 5.0 then raise exception 'TEST FAILED: rejected legacy delete still mutated stock (qty % / avg %, expected 200/5.0)', qty, avgc; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 1 then raise exception 'TEST FAILED: rejected legacy delete still removed the purchase row'; end if;

  -- === REGRESSION: legacy (no snapshot), quantity_before > 0, but reconstruction is ambiguous ===
  -- (prior average could have been NULL or genuinely 0 -- see the fixture's own comment). Must
  -- block rather than restore a guessed 0.
  select spd_legacy_ambiguous.supply_id into supply_id from spd_legacy_ambiguous;
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: a legacy purchase with an ambiguous (null-or-zero) reconstructed prior average was deleted';
  exception when check_violation then null; end;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.legacy_ambiguous_id;
  if qty <> 20 or avgc <> 10.0 then raise exception 'TEST FAILED: rejected ambiguous-legacy delete still mutated stock (qty % / avg %, expected 20/10.0)', qty, avgc; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 1 then raise exception 'TEST FAILED: rejected ambiguous-legacy delete still removed the purchase row'; end if;

  -- ========================== Blocked: later inventory activity exists ==========================
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.blocked_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'to-be-blocked');
  supply_id := (r->>'supply_id')::uuid;
  tx_id := (r->>'transaction_id')::uuid;
  perform public.apply_raw_inventory_adjustment(ids.blocked_id, -50, 'delta', 'household_use', 'later activity', 1500, tx_id, 'g');
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: delete succeeded despite later inventory activity';
  exception when check_violation then null; end;
  select current_quantity into qty from public.ingredients where id = ids.blocked_id;
  if qty <> 1450 then raise exception 'TEST FAILED: rejected delete still mutated stock (qty %, expected 1450)', qty; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 1 then raise exception 'TEST FAILED: rejected delete still removed the purchase row'; end if;

  -- ===================== Blocked: CSV-imported purchase cannot be isolated =====================
  r := public.confirm_purchase_import_v2(gen_random_uuid(), ids.import_id);
  select id into supply_id from public.supply_entries where ingredient_id = ids.csv_id and notes like 'Imported via CSV%';
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: a CSV-imported purchase was deleted';
  exception when check_violation then null; end;
  select current_quantity into qty from public.ingredients where id = ids.csv_id;
  if qty <> 500 then raise exception 'TEST FAILED: rejected CSV-purchase delete still mutated stock (qty %, expected 500)', qty; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 1 then raise exception 'TEST FAILED: rejected CSV-purchase delete still removed the row'; end if;

  -- ========================= Unmatched purchase: safe, no reversal needed =========================
  select spd_unmatched.supply_id into supply_id from spd_unmatched;
  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  if (r->>'reversed')::boolean is not false then raise exception 'TEST FAILED: unmatched-purchase delete reported a reversal'; end if;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 0 then raise exception 'TEST FAILED: unmatched purchase was not deleted'; end if;

  -- ============ Unmatched purchase with a stray ledger reference: refused, never guessed ============
  select spd_unmatched.malformed_supply_id into supply_id from spd_unmatched;
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: an unmatched purchase with a stray ledger reference was deleted';
  exception when check_violation then null; end;
  select count(*) into supply_count from public.supply_entries where id = supply_id;
  if supply_count <> 1 then raise exception 'TEST FAILED: rejected malformed-unmatched delete still removed the purchase row'; end if;
  select current_quantity into qty from public.ingredients where id = ids.other_id;
  if qty <> 110 then raise exception 'TEST FAILED: rejected malformed-unmatched delete mutated an unrelated Item (qty %, expected 110)', qty; end if;

  -- ============ Latest-movement tie-break: created_at DESC, id DESC, never timestamp alone ============
  -- Same instant for both rows on purpose -- id is the only thing that can decide the tie, so the
  -- outcome only matches "created_at desc, id desc" if that exact clause is what runs.
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.tie_high_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'tie-high');
  supply_id := (r->>'supply_id')::uuid;
  tx_id := (r->>'transaction_id')::uuid;
  -- A stray same-instant row whose id sorts ABOVE the purchase's own -- ties resolve to it, so the
  -- purchase is correctly no longer "latest" and must be refused. inventory_transactions has no
  -- direct INSERT grant to authenticated (Wave 0A), so this fixture row is inserted as superuser,
  -- same as every other raw ledger-row fixture in this file -- RESET ROLE/SET ROLE (not the LOCAL
  -- variant used to enter authenticated further up) toggle for exactly this one statement.
  execute 'reset role';
  insert into public.inventory_transactions (id, ingredient_id, transaction_type, quantity_change,
    quantity_before, quantity_after, source_type, source_id, note, created_at)
    select 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, ids.tie_high_id, 'adjustment', 0, 1500, 1500,
      'manual', null, 'tie-breaker-above', t.created_at
    from public.inventory_transactions t where t.id = tx_id;
  execute 'set role authenticated';
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
    raise exception 'TEST FAILED: delete succeeded despite a same-instant row whose id sorts later';
  exception when check_violation then null; end;

  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.tie_low_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'tie-low');
  supply_id := (r->>'supply_id')::uuid;
  tx_id := (r->>'transaction_id')::uuid;
  -- A stray same-instant row whose id sorts BELOW the purchase's own -- the purchase still wins the
  -- tie and must remain deletable.
  execute 'reset role';
  insert into public.inventory_transactions (id, ingredient_id, transaction_type, quantity_change,
    quantity_before, quantity_after, source_type, source_id, note, created_at)
    select '00000000-0000-0000-0000-000000000000'::uuid, ids.tie_low_id, 'adjustment', 0, 1500, 1500,
      'manual', null, 'tie-breaker-below', t.created_at
    from public.inventory_transactions t where t.id = tx_id;
  execute 'set role authenticated';
  r := public.delete_posted_purchase_if_reversible(gen_random_uuid(), supply_id);
  if (r->>'reversed')::boolean is not true then raise exception 'TEST FAILED: a same-instant row whose id sorts earlier incorrectly blocked the delete'; end if;
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.tie_low_id;
  if qty <> 1000 or avgc <> 2.0 then raise exception 'TEST FAILED: tie-break-won reversal produced wrong state (qty % / avg %)', qty, avgc; end if;

  -- ===================================== Idempotent retry =====================================
  op := gen_random_uuid();
  r := public.post_raw_purchase(op, ids.flour_id, 100, 'g', 100, 200, 'Local', 'SM', current_date, 5, 'retry-setup');
  supply_id := (r->>'supply_id')::uuid;
  op := gen_random_uuid();
  r := public.delete_posted_purchase_if_reversible(op, supply_id);
  if (public.delete_posted_purchase_if_reversible(op, supply_id)) <> r then
    raise exception 'TEST FAILED: retrying the same delete operation id did not replay the stored result';
  end if;
  select current_quantity into qty from public.ingredients where id = ids.flour_id;
  if qty <> 1000 then raise exception 'TEST FAILED: retried delete double-reversed (qty %, expected 1000)', qty; end if;

  -- ===================================== Not found =====================================
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), gen_random_uuid());
    raise exception 'TEST FAILED: deleting a nonexistent purchase was accepted';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
end;
$$;

-- ===================================== Owner-only =====================================
do $$
declare ids record;
begin
  select * into ids from spd_ids;
  perform set_config('request.jwt.claim.app_role', 'staff', true);
  begin
    perform public.delete_posted_purchase_if_reversible(gen_random_uuid(), gen_random_uuid());
    raise exception 'TEST FAILED: a non-owner deleted a purchase';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.app_role', 'owner', true);
end;
$$;

reset role;
rollback;
select 'safe_purchase_delete_assertions_passed';

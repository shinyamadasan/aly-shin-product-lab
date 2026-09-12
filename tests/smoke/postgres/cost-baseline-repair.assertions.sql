-- Cost Baseline Repair single-shot invariants: certification RPC correctness (including every
-- rejection path), the auto-backfill's exact eligibility rule against six representative fixture
-- classes, and confirm_bake_v3's new cost-readiness guard (A-F from the implementation mandate).
-- Concurrency (certification race, certification-vs-purchase race) and the safe-purchase-after-
-- certification test run in the .test.ts file (they need real overlapping connections / a second
-- RPC call after this transaction's own certifications commit). Everything here rolls back.
begin;

create temporary table cbr as select
  gen_random_uuid() as product_id_holder, -- unused; products.id is text
  'cbr-product'::text as product_id,
  gen_random_uuid() as batch_id,
  -- Auto-backfill fixture classes (see migration's own eligibility-rule comment):
  gen_random_uuid() as clean_single,      -- 1 linked purchase, unit matches, cost matches exactly
  gen_random_uuid() as clean_multi,       -- 2 linked purchases, same price, cost matches exactly
  gen_random_uuid() as reject_target,     -- no purchase evidence (never backfill-eligible); used only to exercise the RPC's rejection paths in isolation
  gen_random_uuid() as stale_positive,    -- egg-like: no linked purchase evidence at all
  gen_random_uuid() as missing_cost,      -- average_unit_cost is null
  gen_random_uuid() as mismatched,        -- linked purchase evidence disagrees with live cost
  gen_random_uuid() as drift,             -- brown-sugar-like: clean cost math, proven ledger drift
  gen_random_uuid() as incompatible_unit, -- linked purchase in a unit that doesn't match base_unit
  -- Auto-backfill unit-completeness fixtures (Reviewer-mandated Cases B/C/D; A/E/F are covered by
  -- clean_single/clean_multi, mismatched, and drift above):
  gen_random_uuid() as unit_mismatch_single, -- single valid purchase, unit kg, base_unit g
  gen_random_uuid() as unit_mismatch_mixed,  -- one valid g purchase + one valid kg purchase
  gen_random_uuid() as unit_invalid_kg_row,  -- one valid g purchase + one INVALID (unpriced) kg row
  -- Bake-guard fixture classes:
  gen_random_uuid() as guard_a, -- cost_reconciled_at null, average_unit_cost positive (egg class)
  gen_random_uuid() as guard_b, -- cost_reconciled_at null, average_unit_cost null
  gen_random_uuid() as guard_c, -- cost_reconciled_at set, average_unit_cost <= 0
  gen_random_uuid() as guard_d, -- cost_reconciled_at set, average_unit_cost positive (allowed)
  -- Physical-count / cost-certification interaction fixtures (Reviewer-mandated Cases A/B/C):
  gen_random_uuid() as count_positive, -- 100 -> 200, no purchase explains the extra 100
  gen_random_uuid() as count_negative, -- 100 -> 95, shrinkage
  gen_random_uuid() as count_zero;     -- 100 -> 100, exact-match recount
grant select on cbr to authenticated;

insert into public.products (id, name) select product_id, 'CBR Product' from cbr;
insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select batch_id, product_id, 'v1', 'completed', 10 from cbr;

insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
  select clean_single, 'CBR Clean Single', 'g', 1000, 0.5, now() from cbr
  union all select clean_multi, 'CBR Clean Multi', 'g', 2000, 0.4, now() from cbr
  union all select reject_target, 'CBR Reject Target', 'g', 1000, 0.4, now() from cbr
  union all select stale_positive, 'CBR Stale Positive', 'pcs', 20, 167.97, now() from cbr
  union all select missing_cost, 'CBR Missing Cost', 'g', 500, null, now() from cbr
  union all select mismatched, 'CBR Mismatched', 'pcs', 30, 5.0, now() from cbr
  union all select drift, 'CBR Drift', 'g', 4000, 0.075, now() from cbr
  union all select incompatible_unit, 'CBR Incompatible Unit', 'g', 300, 0.03, now() from cbr
  union all select unit_mismatch_single, 'CBR Unit Mismatch Single', 'g', 1000, 30, now() from cbr
  union all select unit_mismatch_mixed, 'CBR Unit Mismatch Mixed', 'g', 2000, 0.5, now() from cbr
  union all select unit_invalid_kg_row, 'CBR Unit Invalid Kg Row', 'g', 1000, 0.5, now() from cbr
  union all select guard_a, 'CBR Guard A', 'g', 500, 167.97, now() from cbr
  union all select guard_b, 'CBR Guard B', 'g', 500, null, now() from cbr
  union all select guard_c, 'CBR Guard C', 'g', 500, 0, now() from cbr
  union all select guard_d, 'CBR Guard D', 'g', 500, 2.0, now() from cbr
  union all select count_positive, 'CBR Count Positive', 'g', 100, 10, now() from cbr
  union all select count_negative, 'CBR Count Negative', 'g', 100, 10, now() from cbr
  union all select count_zero, 'CBR Count Zero', 'g', 100, 10, now() from cbr;

-- guard_c is seeded with cost_reconciled_at ALREADY set (simulating "was certified, something
-- later drove the cost to zero") -- direct fixture write, not through the RPC, since the RPC
-- itself refuses to certify a non-positive cost (that path is asserted separately below).
update public.ingredients set cost_reconciled_at = now() where id = (select guard_c from cbr);
-- guard_d is certified directly (no purchase evidence exists for it, so the backfill would not
-- reach it) so it represents the "allowed" case: cost_reconciled_at set, average_unit_cost valid.
update public.ingredients set cost_reconciled_at = now() where id = (select guard_d from cbr);
-- All three count fixtures start certified (direct fixture write -- no purchase evidence exists
-- for any of them, so the backfill would never reach them either) so each test can observe
-- whether that certification survives its own physical count.
update public.ingredients set cost_reconciled_at = now()
  where id in (select count_positive from cbr union select count_negative from cbr union select count_zero from cbr);

-- One prior ledger row per count fixture, purely so apply_raw_inventory_adjustment's
-- p_expected_latest_id optimistic-concurrency check has a real transaction id to match against --
-- mirrors how every real ingredient reaches its first physical count only after at least one
-- purchase already exists.
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type, source_id, created_at)
  select count_positive, 'purchase', 100, 0, 100, 'manual', null, now() - interval '1 day' from cbr
  union all select count_negative, 'purchase', 100, 0, 100, 'manual', null, now() - interval '1 day' from cbr
  union all select count_zero, 'purchase', 100, 0, 100, 'manual', null, now() - interval '1 day' from cbr;

-- Auto-backfill fixture: purchase evidence. clean_single/clean_multi/mismatched/drift/
-- incompatible_unit each get supply_entries; stale_positive and missing_cost get NONE (matching
-- Egg's real defect: the only Egg purchase on file had ingredient_id = null, i.e. NOT linked).
insert into public.supply_entries (ingredient_id, ingredient_name, supplier_name, purchase_date, pack_quantity, unit, total_cost, quality_rating)
  select clean_single, 'CBR Clean Single', 'S', current_date, 1000, 'g', 500, 5 from cbr -- 500/1000 = 0.5, matches
  union all select clean_multi, 'CBR Clean Multi', 'S', current_date, 1000, 'g', 400, 5 from cbr -- 400/1000 = 0.4
  union all select clean_multi, 'CBR Clean Multi', 'S', current_date, 1000, 'g', 400, 5 from cbr -- + 400/1000 = 0.4 -> avg stays 0.4
  union all select mismatched, 'CBR Mismatched', 'S', current_date, 30, 'pcs', 186.75, 5 from cbr -- 6.225/pc, live is 5.0 -> mismatch
  union all select drift, 'CBR Drift', 'S', current_date, 3000, 'g', 225, 5 from cbr -- 225/3000 = 0.075, matches live exactly
  union all select incompatible_unit, 'CBR Incompatible Unit', 'S', current_date, 1, 'kg', 30, 5 from cbr -- base_unit is 'g', purchase unit is 'kg' -> excluded
  -- Case B: the only evidence is a single valid purchase in a non-matching unit -> excluded (same
  -- shape as incompatible_unit above, kept as its own named fixture per the reviewer's exact letter scheme).
  union all select unit_mismatch_single, 'CBR Unit Mismatch Single', 'S', current_date, 1, 'kg', 30, 5 from cbr
  -- Case C: one valid matching-unit purchase (0.4/g, matches live average exactly) PLUS one valid
  -- non-matching-unit purchase. Without the completeness rule, the matching-unit subset alone
  -- would look clean (400/1000 = 0.4, live average is 0.4) and wrongly auto-certify -- proving the
  -- completeness check, not just the plain unit filter, is load-bearing.
  union all select unit_mismatch_mixed, 'CBR Unit Mismatch Mixed', 'S', current_date, 1000, 'g', 400, 5 from cbr
  union all select unit_mismatch_mixed, 'CBR Unit Mismatch Mixed', 'S', current_date, 1, 'kg', 500, 5 from cbr
  -- Case D: one valid matching-unit purchase (0.5/g, matches live average exactly) PLUS one
  -- INVALID non-matching-unit row (total_cost = 0 -- not "relevant valid evidence" under the same
  -- predicate isValidSupplyForCosting already uses client-side). The invalid row must NOT count as
  -- conflicting evidence -- this ingredient should still auto-certify.
  union all select unit_invalid_kg_row, 'CBR Unit Invalid Kg Row', 'S', current_date, 1000, 'g', 500, 5 from cbr
  union all select unit_invalid_kg_row, 'CBR Unit Invalid Kg Row', 'S', current_date, 1, 'kg', 0, 5 from cbr; -- total_cost = 0: invalid, not evidence of anything

-- Ledger rows. clean_single/clean_multi/mismatched/incompatible_unit: a plain purchase whose
-- quantity_after matches current_quantity (no drift). drift: a purchase leaving quantity_after =
-- 3000, but the ingredient's current_quantity is 4000 (seeded above) -- an untracked +1000 g,
-- exactly Brown Sugar's real signature -- captured via a reconciliation_snapshot recording BOTH
-- numbers, exactly as apply_raw_inventory_adjustment's count mode does in production.
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type, source_id, created_at)
  select clean_single, 'purchase', 1000, 0, 1000, 'manual', null, now() - interval '2 days' from cbr
  union all select clean_multi, 'purchase', 1000, 0, 1000, 'manual', null, now() - interval '2 days' from cbr
  union all select clean_multi, 'purchase', 1000, 1000, 2000, 'manual', null, now() - interval '1 day' from cbr
  union all select reject_target, 'purchase', 1000, 0, 1000, 'manual', null, now() - interval '2 days' from cbr -- no matching supply_entries row -> never backfill-eligible
  union all select mismatched, 'purchase', 30, 0, 30, 'manual', null, now() - interval '1 day' from cbr
  union all select drift, 'purchase', 3000, 0, 3000, 'manual', null, now() - interval '2 days' from cbr
  union all select incompatible_unit, 'purchase', 300, 0, 300, 'manual', null, now() - interval '2 days' from cbr
  union all select unit_mismatch_single, 'purchase', 1000, 0, 1000, 'manual', null, now() - interval '2 days' from cbr
  union all select unit_mismatch_mixed, 'purchase', 2000, 0, 2000, 'manual', null, now() - interval '2 days' from cbr
  union all select unit_invalid_kg_row, 'purchase', 1000, 0, 1000, 'manual', null, now() - interval '2 days' from cbr;

-- This mirrors Brown Sugar's real reconciliation_snapshot exactly: quantity_before/quantity_after
-- on this row are both 4000 (a physical count that happened to confirm the already-drifted cache,
-- so the ledger-facing quantity_after ends up matching current_quantity and does NOT by itself
-- exclude this fixture from the backfill's plain "latest ledger quantity_after = current_quantity"
-- check) while the snapshot payload records that the ledger's own PRIOR transaction only ever
-- accounted for 3000 -- an untracked +1000 g that the ledger cannot explain. This isolates the
-- test to the reconciliation_snapshot drift check specifically, the same signature Brown Sugar's
-- real data showed.
insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type, source_id, reason, created_at, reconciliation_snapshot)
  select drift, 'adjustment', 0, 4000, 4000, 'manual', null, 'stock_count_correction', now(),
    jsonb_build_object('cache_quantity', 4000, 'latest_ledger_quantity', 3000, 'verified_quantity', 4000) from cbr;

-- Run the exact same eligibility rule the migration itself ran once at apply time (before any of
-- these fixtures existed) -- as the superuser, the same way every other fixture-setup statement
-- above already bypasses RLS, since the function is deliberately not granted to `authenticated`.
select inventory_private.backfill_clean_cost_baselines();

set local role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  c record;
  v_id uuid;
  v_before_count bigint;
  v_row public.ingredients%rowtype;
  v_tx public.inventory_transactions%rowtype;
  v_result jsonb;
  v_latest_id uuid;
begin
  select * into c from cbr;

  -- ============================================================================================
  -- Certification RPC: happy path, then every rejection path.
  -- ============================================================================================
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.clean_single
    order by created_at desc, id desc limit 1;
  v_id := public.certify_ingredient_cost_baseline(c.clean_single, 0.55, 'test evidence: receipt #1', 0.5, 1000, v_latest_id);
  select * into v_row from public.ingredients where id = c.clean_single;
  if v_row.average_unit_cost <> 0.55 then raise exception 'TEST FAILED: certify did not update average_unit_cost, got %', v_row.average_unit_cost; end if;
  if v_row.cost_reconciled_at is null then raise exception 'TEST FAILED: certify did not set cost_reconciled_at'; end if;
  if v_row.current_quantity <> 1000 then raise exception 'TEST FAILED: certify changed current_quantity'; end if;
  if v_row.inventory_reconciled_at is null then raise exception 'TEST FAILED: certify cleared inventory_reconciled_at'; end if;

  select * into v_tx from public.inventory_transactions where id = v_id;
  if v_tx.transaction_type <> 'cost_certification' then raise exception 'TEST FAILED: audit row has wrong transaction_type'; end if;
  if v_tx.quantity_change <> 0 then raise exception 'TEST FAILED: audit row has nonzero quantity_change'; end if;
  if v_tx.quantity_before <> 1000 or v_tx.quantity_after <> 1000 then raise exception 'TEST FAILED: audit row quantity_before/after must equal current_quantity unchanged'; end if;
  if v_tx.note <> 'test evidence: receipt #1' then raise exception 'TEST FAILED: audit row did not store the evidence note'; end if;
  if (v_tx.cost_certification_snapshot->>'previous_average_unit_cost')::numeric <> 0.5 then
    raise exception 'TEST FAILED: audit snapshot did not preserve the previous cost'; end if;
  if (v_tx.cost_certification_snapshot->>'certified_unit_cost')::numeric <> 0.55 then
    raise exception 'TEST FAILED: audit snapshot did not record the certified cost'; end if;

  -- All of the following use reject_target, a fixture with no purchase evidence at all (so it is
  -- never touched by the backfill and stays cost_reconciled_at = null throughout), to test the
  -- RPC's rejection paths in isolation from backfill state.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.reject_target
    order by created_at desc, id desc limit 1;

  -- null / zero / negative cost rejected
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, null, 'note', 0.4, 1000, v_latest_id);
    raise exception 'TEST FAILED: null certified cost accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0, 'note', 0.4, 1000, v_latest_id);
    raise exception 'TEST FAILED: zero certified cost accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, -1, 'note', 0.4, 1000, v_latest_id);
    raise exception 'TEST FAILED: negative certified cost accepted';
  exception when sqlstate '22023' then null; end;

  -- blank evidence rejected
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0.4, '   ', 0.4, 1000, v_latest_id);
    raise exception 'TEST FAILED: blank evidence note accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0.4, null, 0.4, 1000, v_latest_id);
    raise exception 'TEST FAILED: null evidence note accepted';
  exception when sqlstate '22023' then null; end;

  -- expected-value stale submission rejected (wrong expected quantity, wrong expected cost, wrong
  -- expected latest ledger id -- each test keeps the OTHER two expected values correct so it
  -- isolates the one mismatch it names)
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0.45, 'note', 0.4, 999999, v_latest_id);
    raise exception 'TEST FAILED: stale expected_quantity accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0.45, 'note', 99, 1000, v_latest_id);
    raise exception 'TEST FAILED: stale expected_current_cost accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.certify_ingredient_cost_baseline(c.reject_target, 0.45, 'note', 0.4, 1000, gen_random_uuid());
    raise exception 'TEST FAILED: stale expected_latest_id accepted';
  exception when sqlstate '40001' then null; end;
  -- confirm none of the eight rejected attempts above changed anything
  select * into v_row from public.ingredients where id = c.reject_target;
  if v_row.average_unit_cost <> 0.4 or v_row.cost_reconciled_at is not null then
    raise exception 'TEST FAILED: a rejected certification attempt still mutated the ingredient'; end if;
  if exists (select 1 from public.inventory_transactions where ingredient_id = c.reject_target and transaction_type = 'cost_certification') then
    raise exception 'TEST FAILED: a rejected certification attempt still wrote an audit row'; end if;

  -- certifying an ingredient with a currently-null average_unit_cost (the Biscoff-Spread/White-
  -- Chocolate-Buttons case): expected_current_cost must be passed as null, matching IS DISTINCT FROM.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.missing_cost
    order by created_at desc, id desc limit 1; -- null: no transactions exist yet for this fixture
  v_id := public.certify_ingredient_cost_baseline(c.missing_cost, 0.61, 'test evidence: never-applied purchase now certified', null, 500, null);
  select * into v_row from public.ingredients where id = c.missing_cost;
  if v_row.average_unit_cost <> 0.61 or v_row.cost_reconciled_at is null then
    raise exception 'TEST FAILED: certifying a null-cost ingredient did not work'; end if;

  -- ============================================================================================
  -- Direct-write authority: ordinary client cannot bypass the RPC.
  -- ============================================================================================
  begin
    update public.ingredients set average_unit_cost = 1, cost_reconciled_at = now() where id = c.stale_positive;
    raise exception 'TEST FAILED: direct ingredients cost write accepted (RLS/grant should block this)';
  exception when insufficient_privilege then null; end;

  -- ============================================================================================
  -- Auto-backfill: exact eligibility rule against six fixture classes, re-run (as superuser,
  -- above) against these fixtures using the same function the migration itself calls once at
  -- apply time -- assert its result here.
  -- ============================================================================================
  -- clean_single was certified manually above (via the RPC, cost 0.55) before the backfill's
  -- eligibility could matter -- clean_multi is the fixture that actually proves the backfill path.
  if (select cost_reconciled_at from public.ingredients where id = c.clean_multi) is null then
    raise exception 'TEST FAILED: clean_multi (clean, multi-purchase, matching weighted average) should have been auto-certified by the backfill';
  end if;
  if (select average_unit_cost from public.ingredients where id = c.clean_multi) <> 0.4 then
    raise exception 'TEST FAILED: backfill must not change average_unit_cost, only set cost_reconciled_at';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.stale_positive) is not null then
    raise exception 'TEST FAILED: stale_positive (egg-class: no linked purchase evidence) must NOT be auto-certified';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.missing_cost) is not null and
     (select average_unit_cost from public.ingredients where id = c.missing_cost) is null then
    raise exception 'TEST FAILED: a null-cost ingredient must never be auto-certified with a null cost';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.mismatched) is not null then
    raise exception 'TEST FAILED: mismatched (own purchase evidence disagrees with live cost) must NOT be auto-certified';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.drift) is not null then
    raise exception 'TEST FAILED: drift (brown-sugar-class: clean cost math but proven ledger drift) must NOT be auto-certified';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.incompatible_unit) is not null then
    raise exception 'TEST FAILED: incompatible_unit (purchase unit does not match base_unit) must NOT be auto-certified';
  end if;

  -- Auto-backfill unit-completeness: Cases B/C/D.
  if (select cost_reconciled_at from public.ingredients where id = c.unit_mismatch_single) is not null then
    raise exception 'TEST FAILED: Case B (single valid purchase, non-matching unit) must NOT be auto-certified';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.unit_mismatch_mixed) is not null then
    raise exception 'TEST FAILED: Case C (one matching + one non-matching valid purchase, matching-only subset looks clean) must NOT be auto-certified -- completeness rule must reject partial evidence';
  end if;
  if (select cost_reconciled_at from public.ingredients where id = c.unit_invalid_kg_row) is null then
    raise exception 'TEST FAILED: Case D (one matching valid purchase + one INVALID non-matching row) should still be auto-certified -- an invalid row is not relevant evidence of anything';
  end if;

  -- ============================================================================================
  -- Bake guard: A-F.
  -- ============================================================================================
  -- A: cost_reconciled_at null + positive average cost -> blocked (egg class)
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', c.guard_a, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake against an uncertified positive-cost ingredient was accepted (guard A)';
  exception when sqlstate '23514' then
    if sqlerrm not like '%Cost baseline is not certified%' then raise; end if;
  end;

  -- B: cost_reconciled_at null + average null -> blocked
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', c.guard_b, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake against a null-cost ingredient was accepted (guard B)';
  exception when sqlstate '23514' then
    if sqlerrm not like '%Cost baseline is not certified%' then raise; end if;
  end;

  -- C: cost_reconciled_at set + average <= 0 -> blocked
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', c.guard_c, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake against a certified-but-zero-cost ingredient was accepted (guard C)';
  exception when sqlstate '23514' then
    if sqlerrm not like '%Cost baseline is not certified%' then raise; end if;
  end;

  -- D: cost_reconciled_at set + valid positive average -> allowed
  v_result := public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
    jsonb_build_array(jsonb_build_object('ingredient_id', c.guard_d, 'quantity', 10)));
  if (v_result->>'quantity_produced_pieces')::integer <> 5 then
    raise exception 'TEST FAILED: Bake with a certified valid-cost ingredient should have been accepted (guard D)'; end if;

  -- E: one bad ingredient among several -> the whole Bake is rejected atomically
  select count(*) into v_before_count from public.production_executions where product_id = c.product_id;
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
      jsonb_build_array(
        jsonb_build_object('ingredient_id', c.guard_d, 'quantity', 10),
        jsonb_build_object('ingredient_id', c.guard_a, 'quantity', 5)));
    raise exception 'TEST FAILED: a Bake with one uncertified ingredient among several was accepted (guard E)';
  exception when sqlstate '23514' then null; end;

  -- F: no partial writes after rejection -- raw consumption, production execution, finished-stock
  -- receipt, and mutation receipt must all be exactly as before the rejected attempts above.
  if (select current_quantity from public.ingredients where id = c.guard_a) <> 500 then
    raise exception 'TEST FAILED: rejected Bake consumed guard_a raw stock'; end if;
  if (select current_quantity from public.ingredients where id = c.guard_d) <> 490 then -- 500 - 10 from the ONE accepted Bake (D)
    raise exception 'TEST FAILED: guard_d raw stock does not reflect exactly the one accepted Bake, got %', (select current_quantity from public.ingredients where id = c.guard_d); end if;
  if (select count(*) from public.production_executions where product_id = c.product_id) <> v_before_count then
    raise exception 'TEST FAILED: a rejected Bake (guard E) left a stray production_execution'; end if;
  if exists (select 1 from public.inventory_transactions where source_type = 'bake' and source_id = c.batch_id::text and ingredient_id = c.guard_a) then
    raise exception 'TEST FAILED: a rejected Bake left a consume row for the blocking ingredient'; end if;

  -- ============================================================================================
  -- Physical-count / cost-certification interaction: Cases A/B/C.
  -- ============================================================================================
  -- Case B: 100 -> 95 (shrinkage). Certification must survive unchanged.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.count_negative
    order by created_at desc, id desc limit 1;
  perform public.apply_raw_inventory_adjustment(c.count_negative, 95, 'count', null, 'recount: shrinkage', 100, v_latest_id, 'g');
  select * into v_row from public.ingredients where id = c.count_negative;
  if v_row.current_quantity <> 95 then raise exception 'TEST FAILED: Case B did not update quantity to 95, got %', v_row.current_quantity; end if;
  if v_row.average_unit_cost <> 10 then raise exception 'TEST FAILED: Case B changed average_unit_cost'; end if;
  if v_row.cost_reconciled_at is null then raise exception 'TEST FAILED: Case B (shrinkage) incorrectly cleared cost_reconciled_at'; end if;
  if v_row.inventory_reconciled_at is null then raise exception 'TEST FAILED: Case B did not set inventory_reconciled_at'; end if;

  -- Case C: 100 -> 100 (exact-match recount, zero delta). Certification must survive unchanged.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.count_zero
    order by created_at desc, id desc limit 1;
  perform public.apply_raw_inventory_adjustment(c.count_zero, 100, 'count', null, 'recount: exact match', 100, v_latest_id, 'g');
  select * into v_row from public.ingredients where id = c.count_zero;
  if v_row.current_quantity <> 100 then raise exception 'TEST FAILED: Case C did not keep quantity at 100, got %', v_row.current_quantity; end if;
  if v_row.average_unit_cost <> 10 then raise exception 'TEST FAILED: Case C changed average_unit_cost'; end if;
  if v_row.cost_reconciled_at is null then raise exception 'TEST FAILED: Case C (zero-delta recount) incorrectly cleared cost_reconciled_at'; end if;

  -- Case A: 100 -> 200, no purchase explains the extra 100. Quantity/average_unit_cost update
  -- normally; cost_reconciled_at must be cleared; a subsequent Bake against this ingredient must
  -- be blocked exactly like any other uncertified ingredient, with no special-case error message.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.count_positive
    order by created_at desc, id desc limit 1;
  perform public.apply_raw_inventory_adjustment(c.count_positive, 200, 'count', null, 'recount: unexplained surplus', 100, v_latest_id, 'g');
  select * into v_row from public.ingredients where id = c.count_positive;
  if v_row.current_quantity <> 200 then raise exception 'TEST FAILED: Case A did not update quantity to 200, got %', v_row.current_quantity; end if;
  if v_row.average_unit_cost <> 10 then raise exception 'TEST FAILED: Case A must preserve average_unit_cost as historical context, got %', v_row.average_unit_cost; end if;
  if v_row.cost_reconciled_at is not null then raise exception 'TEST FAILED: Case A (unexplained surplus) must clear cost_reconciled_at'; end if;
  if v_row.inventory_reconciled_at is null then raise exception 'TEST FAILED: Case A did not set inventory_reconciled_at'; end if;

  begin
    perform public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', c.count_positive, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake against count_positive was accepted after its certification was cleared by an unexplained surplus count';
  exception when sqlstate '23514' then
    if sqlerrm not like '%Cost baseline is not certified%' then raise; end if;
  end;

  -- Re-certification after a cleared positive count is the same generic RPC, no special repair
  -- path: expected_quantity is now 200 (the post-count value), expected_current_cost is the
  -- preserved historical 10, expected_latest_id is the count adjustment's own transaction row.
  select id into v_latest_id from public.inventory_transactions where ingredient_id = c.count_positive
    order by created_at desc, id desc limit 1;
  perform public.certify_ingredient_cost_baseline(c.count_positive, 12, 're-certified after unexplained-surplus count: fresh receipt reviewed', 10, 200, v_latest_id);
  select * into v_row from public.ingredients where id = c.count_positive;
  if v_row.cost_reconciled_at is null then raise exception 'TEST FAILED: re-certification after a cleared positive count did not set cost_reconciled_at'; end if;
  if v_row.average_unit_cost <> 12 then raise exception 'TEST FAILED: re-certification after a cleared positive count did not update average_unit_cost'; end if;
  -- And the Bake that was blocked a moment ago now succeeds with no special path.
  v_result := public.confirm_bake_v3(gen_random_uuid(), c.batch_id, c.product_id, 'x', 1, 3,
    jsonb_build_array(jsonb_build_object('ingredient_id', c.count_positive, 'quantity', 10)));
  if (v_result->>'quantity_produced_pieces')::integer <> 3 then
    raise exception 'TEST FAILED: Bake against count_positive should succeed after re-certification'; end if;
end;
$$;

reset role;
rollback;
select 'cost_baseline_repair_assertions_passed';

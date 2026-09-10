-- Wave 1: Production Execution + Finished Stock.
--
-- Turns a successful real Bake into one atomic production event: raw ingredients consumed (the
-- Wave 0B contract, folded in here so there is no partial-failure boundary) -> one
-- production_executions row -> one finished_stock_movements 'production_receipt' -> raw
-- production cost frozen -> the proof/version completion timestamp set once if still null.
-- All of it commits together or none of it does.
--
-- product_batches stays recipe/version/proof truth. A real physical Bake is production_executions.
-- Finished stock is pieces, tracked in one append-only movement ledger whose shape already has
-- room for Wave 2's reserve/release/fulfill (not implemented here).
--
-- The finished quantity is the operator's PHYSICALLY OBSERVED usable-piece count for the run,
-- submitted with the Bake -- round(usable_pieces x multiplier) is kept only as frozen expected
-- reference. Finished stock and cost-per-piece follow the observed number.
--
-- Security matches Wave 0A/0B: new tables get SELECT-only for the owner and no write path at all
-- for any client role; the private confirm_bake_v3 function (security definer, fixed empty
-- search_path) is the only writer, behind a narrowly-granted public invoker wrapper. Wave 0B's
-- confirm_bake_v2 is retained for history but its execute grant is withdrawn so the client can
-- only reach the full production contract.
--
-- NOT APPLIED. Created with `supabase migration new`; leave unapplied until independent Wave 1
-- review. Integration tests run against disposable Postgres containers only.
do $$
begin
  if to_regprocedure('inventory_private.confirm_bake_v2(uuid,text,text,numeric,jsonb)') is null
     or to_regclass('inventory_private.mutation_receipts') is null then
    raise exception 'Wave 1 requires Wave 0B (confirm_bake_v2 + mutation_receipts)';
  end if;
  if to_regclass('public.production_executions') is not null then
    raise exception 'Wave 1 objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. production_executions -- one row per successful physical Bake. Immutable: no client role
-- gets insert/update/delete, and confirm_bake_v3 only ever inserts. operation_id is UNIQUE, so
-- even a bug in the idempotency helper could not produce two executions for one Bake intent.
-- quantity/cost are frozen facts: a later recipe edit cannot rewrite what a past Bake produced
-- or cost.
--
-- quantity_produced_pieces is the operator's PHYSICALLY OBSERVED usable-piece count for this run,
-- submitted with the Bake -- not a projection. expected_pieces is round(usable_pieces x multiplier)
-- frozen at Bake time, kept only as "what the recipe predicted" reference beside the real count.
-- The two differ whenever a run yields more or fewer sellable pieces than the recipe projects,
-- which is normal; finished stock and cost-per-piece follow the observed number.
-- ============================================================================================
create table public.production_executions (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id),
  product_batch_id uuid not null references public.product_batches(id),
  batch_version_snapshot text not null,
  operation_id uuid not null unique,
  multiplier numeric not null check (multiplier > 0),
  quantity_produced_pieces integer not null check (quantity_produced_pieces > 0),
  expected_pieces integer not null check (expected_pieces >= 0),
  frozen_ingredient_cost_total numeric not null check (frozen_ingredient_cost_total >= 0),
  frozen_cost_per_piece numeric not null check (frozen_cost_per_piece >= 0),
  note text,
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index production_executions_product_completed_idx
  on public.production_executions (product_id, completed_at desc);
create index production_executions_batch_idx on public.production_executions (product_batch_id);

comment on table public.production_executions is
  'One actual physical Bake. product_batch_id is the recipe/version used; quantity_produced_pieces and the frozen cost columns are historical facts and never change. Not a lifecycle table -- a successful Bake is atomic and immediately complete, so there is no status column.';

-- ============================================================================================
-- 2. finished_stock_movements -- append-only finished-inventory ledger, in PIECES. on_hand and
-- reserved are derived (SUM of the deltas), never cached. Wave 1 only ever writes
-- 'production_receipt' (on_hand +pieces, reserved 0). The movement_type check already lists the
-- Wave 2 verbs so that wave adds behaviour, not a constraint change; it does NOT implement them.
-- ============================================================================================
create table public.finished_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id),
  -- null only for a future movement that genuinely does not originate from a production Bake.
  production_execution_id uuid references public.production_executions(id),
  movement_type text not null check (movement_type in ('production_receipt', 'reserve', 'release', 'fulfill')),
  on_hand_delta integer not null default 0,
  reserved_delta integer not null default 0,
  operation_id uuid not null,
  note text,
  created_at timestamptz not null default now(),
  -- Defensive shape check. A production_receipt is always a positive on-hand addition tied to its
  -- execution and never touches reserved. reserve/release/fulfill (Wave 2) are unconstrained here
  -- so that wave adds their own behaviour without a constraint migration.
  constraint finished_stock_movements_production_receipt_shape check (
    movement_type <> 'production_receipt'
    or (on_hand_delta > 0 and reserved_delta = 0 and production_execution_id is not null)
  )
);
create index finished_stock_movements_product_idx
  on public.finished_stock_movements (product_id, created_at);
create index finished_stock_movements_execution_idx
  on public.finished_stock_movements (production_execution_id);

comment on table public.finished_stock_movements is
  'Append-only finished-stock ledger in pieces. on_hand = SUM(on_hand_delta), reserved = SUM(reserved_delta), available = on_hand - reserved. Wave 1 writes only production_receipt; reserve/release/fulfill are Wave 2 and not implemented.';

-- ============================================================================================
-- 3. Authority: SELECT for the owner only, no write path for any client role. The definer
-- function below bypasses this as the table owner, exactly as Wave 0A's confirm_bake_v2 already
-- does for inventory_transactions.
-- ============================================================================================
alter table public.production_executions enable row level security;
alter table public.finished_stock_movements enable row level security;
revoke all on public.production_executions, public.finished_stock_movements
  from public, anon, authenticated;
grant select on public.production_executions, public.finished_stock_movements to authenticated;

create policy "wave1 owner reads production executions" on public.production_executions
  for select to authenticated using (public.is_product_lab_owner());
create policy "wave1 owner reads finished stock movements" on public.finished_stock_movements
  for select to authenticated using (public.is_product_lab_owner());

-- ============================================================================================
-- 4. confirm_bake_v3 -- the complete atomic production Bake. Supersedes confirm_bake_v2's
-- raw-consumption-only contract. Steps, all in one transaction:
--   auth -> validate multiplier + observed pieces -> claim operation identity -> lock+read the
--   recipe/version batch -> validate product/yield -> lock every ingredient row (order by id) ->
--   Wave 0A reconciliation gate -> all-or-nothing sufficiency -> freeze cost from the locked
--   ingredient state -> deduct raw + append consume movements -> production_executions row ->
--   finished_stock_movements receipt -> set product_batches.completed_at once if null -> store the
--   receipt result. Any failure rolls the whole thing back; the operation id stays retryable.
--
-- p_actual_pieces_produced is the operator's physically observed usable-piece count. It is the
-- authoritative finished quantity for this run: finished stock receives exactly it, and
-- frozen_cost_per_piece divides the raw cost by it. round(usable_pieces x multiplier) is still
-- computed but only as frozen expected_pieces reference metadata. Because the observed count
-- changes the production fact, it is part of the idempotency payload hash -- a retry with a
-- different count is a changed-payload rejection, not a silent rewrite.
-- ============================================================================================
create or replace function inventory_private.confirm_bake_v3(
  p_operation_id uuid, p_batch_id uuid, p_product_id text, p_batch_label text,
  p_multiplier numeric, p_actual_pieces_produced numeric, p_deductions jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_batch public.product_batches%rowtype;
  v_ids uuid[]; v_total_count integer; v_matched_count integer; v_distinct_count integer;
  v_unreconciled text; v_short text; d record;
  v_before numeric; v_after numeric; v_tx_id uuid; v_tx_ids uuid[] := '{}';
  v_pieces integer; v_expected_pieces integer; v_cost_total numeric; v_cost_per_piece numeric;
  v_note text; v_exec_id uuid; v_fsm_id uuid; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may confirm a Bake' using errcode = '42501';
  end if;
  if p_multiplier is null or p_multiplier::text = any(array['NaN','Infinity','-Infinity'])
     or p_multiplier <= 0 then
    raise exception 'Batches made must be a number greater than zero' using errcode = '22023';
  end if;
  if p_actual_pieces_produced is null then
    raise exception 'Enter the actual usable pieces produced for this Bake' using errcode = '22023';
  end if;
  if p_actual_pieces_produced::text = any(array['NaN','Infinity','-Infinity'])
     or p_actual_pieces_produced <> trunc(p_actual_pieces_produced)
     or p_actual_pieces_produced < 1 then
    raise exception 'Actual usable pieces produced must be a whole number of at least 1' using errcode = '22023';
  end if;
  if p_batch_id is null then raise exception 'A batch is required' using errcode = '22023'; end if;
  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception 'A product is required' using errcode = '22023';
  end if;
  if p_deductions is null or jsonb_typeof(p_deductions) <> 'array' or jsonb_array_length(p_deductions) = 0 then
    raise exception 'No ingredients to deduct' using errcode = '22023';
  end if;

  select count(*), count(distinct elem->>'ingredient_id')
  into v_total_count, v_distinct_count
  from jsonb_array_elements(p_deductions) as elem;
  if v_distinct_count <> v_total_count then
    raise exception 'Duplicate Item in Bake deductions' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_batch_id::text, p_product_id, p_multiplier,
    p_actual_pieces_produced, p_deductions::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'bake_produce', v_hash);
  if v_replay is not null then return v_replay; end if;

  -- Resolve and lock the recipe/version. The lock also serializes two Bakes of the same batch.
  select * into v_batch from public.product_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch not found' using errcode = '22023'; end if;
  if v_batch.product_id is distinct from p_product_id then
    raise exception 'This batch does not belong to the given product' using errcode = '22023';
  end if;
  if v_batch.voided_at is not null or v_batch.status = 'voided' then
    raise exception 'This batch is voided and cannot be baked' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found' using errcode = '22023';
  end if;
  if v_batch.usable_pieces is null or v_batch.usable_pieces <= 0 then
    raise exception 'This recipe version has no usable-pieces yield recorded. Set it on the batch before baking for production.' using errcode = '22023';
  end if;

  -- Finished quantity is the operator's observed usable-piece count, NOT a projection. A batch
  -- with a recorded yield is still required (a proven recipe/version), but yield * multiplier only
  -- becomes frozen reference metadata; a later edit to usable_pieces never touches either number.
  v_expected_pieces := round(v_batch.usable_pieces * p_multiplier)::integer;
  v_pieces := p_actual_pieces_produced::integer;

  select array_agg((elem->>'ingredient_id')::uuid) into v_ids from jsonb_array_elements(p_deductions) as elem;
  select count(*) into v_matched_count from public.ingredients where id = any(v_ids);
  if v_matched_count <> v_total_count then
    raise exception 'One of the resolved Items could not be found' using errcode = '22023';
  end if;

  -- Lock every affected ingredient in one deterministic order (same order confirm_bake_v2 and
  -- confirm_purchase_import_v2 use), before any check or write.
  perform id from public.ingredients where id = any(v_ids) order by id for update;

  select string_agg(distinct ing.name, ', ') into v_unreconciled
  from public.ingredients ing where ing.id = any(v_ids) and ing.inventory_reconciled_at is null;
  if v_unreconciled is not null then
    raise exception 'Verify the physical stock of the following Item(s) before this Bake can consume them: %.', v_unreconciled using errcode = '23514';
  end if;

  select string_agg(format('%s (have %s, need %s)', ing.name, ing.current_quantity, dd.quantity), '; ') into v_short
  from (select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
        from jsonb_array_elements(p_deductions) as elem) dd
  join public.ingredients ing on ing.id = dd.ingredient_id
  where dd.quantity > ing.current_quantity;
  if v_short is not null then
    raise exception 'Not enough stock for this Bake: %.', v_short using errcode = '23514';
  end if;

  -- Freeze the raw production cost from the locked, authoritative ingredient state. This is the
  -- cost of the Bake at the moment it happened -- not sale COGS. A later average_unit_cost change
  -- cannot rewrite it.
  select coalesce(sum(dd.quantity * coalesce(ing.average_unit_cost, 0)), 0) into v_cost_total
  from (select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
        from jsonb_array_elements(p_deductions) as elem) dd
  join public.ingredients ing on ing.id = dd.ingredient_id;
  -- Per-piece cost is the raw cost spread over the pieces that actually came out usable, not the
  -- projected yield -- the economically useful production number. Still production cost, not COGS.
  v_cost_per_piece := v_cost_total / v_pieces;

  v_note := format('Bake: %s x%s -> %s pcs', coalesce(nullif(trim(p_batch_label), ''), 'batch'), p_multiplier, v_pieces);

  for d in select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
    from jsonb_array_elements(p_deductions) as elem order by (elem->>'ingredient_id')::uuid
  loop
    select current_quantity into v_before from public.ingredients where id = d.ingredient_id;
    v_after := v_before - d.quantity;
    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
      quantity_before, quantity_after, source_type, source_id, note, created_at)
    values (d.ingredient_id, 'consume', -d.quantity, v_before, v_after, 'bake', p_batch_id::text, v_note, v_now)
    returning id into v_tx_id;
    v_tx_ids := v_tx_ids || v_tx_id;
    update public.ingredients set current_quantity = v_after, updated_at = v_now where id = d.ingredient_id;
  end loop;

  insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot,
    operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total,
    frozen_cost_per_piece, completed_at)
  values (p_product_id, p_batch_id, v_batch.batch_version, p_operation_id, p_multiplier, v_pieces,
    v_expected_pieces, v_cost_total, v_cost_per_piece, v_now)
  returning id into v_exec_id;

  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type,
    on_hand_delta, reserved_delta, operation_id, note)
  values (p_product_id, v_exec_id, 'production_receipt', v_pieces, 0, p_operation_id, v_note)
  returning id into v_fsm_id;

  -- Proof/version completion timestamp: set once, never overwrite a valid historical value.
  -- Individual physical runs are production_executions now, not this field.
  if v_batch.completed_at is null then
    update public.product_batches set completed_at = v_now, updated_at = v_now
      where id = p_batch_id and completed_at is null;
  end if;

  v_result := jsonb_build_object(
    'batch_id', p_batch_id, 'product_id', p_product_id, 'production_execution_id', v_exec_id,
    'finished_stock_movement_id', v_fsm_id, 'quantity_produced_pieces', v_pieces,
    'expected_pieces', v_expected_pieces,
    'frozen_ingredient_cost_total', v_cost_total, 'frozen_cost_per_piece', v_cost_per_piece,
    'transaction_ids', to_jsonb(v_tx_ids));
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)
  from public, anon, authenticated;
grant execute on function inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb) to authenticated;

create or replace function public.confirm_bake_v3(
  p_operation_id uuid, p_batch_id uuid, p_product_id text, p_batch_label text,
  p_multiplier numeric, p_actual_pieces_produced numeric, p_deductions jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.confirm_bake_v3(p_operation_id, p_batch_id, p_product_id, p_batch_label,
    p_multiplier, p_actual_pieces_produced, p_deductions);
$$;
revoke all on function public.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb) to authenticated;

-- Retire the Wave 0B raw-consumption-only Bake from client use -- it is not a complete
-- production event. Definitions stay for history/inspection; only the execute grant is withdrawn,
-- the same way Wave 0A retired the pre-authority RPCs.
revoke execute on function public.confirm_bake_v2(uuid,text,text,numeric,jsonb) from authenticated;
revoke execute on function inventory_private.confirm_bake_v2(uuid,text,text,numeric,jsonb) from authenticated;

notify pgrst, 'reload schema';

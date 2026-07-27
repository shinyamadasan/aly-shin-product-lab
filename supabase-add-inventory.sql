-- Milestone 1 of the Supply Inventory Loop: the ingredient master table only.
-- Purchase import, bake deduction, and the transaction ledger arrive in later milestones
-- and will extend this same file.

create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_unit text not null,
  current_quantity numeric not null default 0,
  low_stock_threshold numeric not null default 0,
  target_stock_quantity numeric not null default 0,
  nearest_expiration_date date,
  average_unit_cost numeric,
  notes text,
  is_active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ingredients_name_unique_idx on ingredients (lower(trim(name)));

alter table ingredients enable row level security;

grant select, insert, update, delete on table ingredients to authenticated;

drop policy if exists "Authenticated users can manage ingredients" on ingredients;

create policy "Authenticated users can manage ingredients"
  on ingredients for all
  to authenticated
  using (true)
  with check (true);

-- Milestone 2: CSV purchase import, ingredient aliases, and the inventory transaction ledger.
-- The ledger starts here, not in a later "atomicity" milestone -- every confirmed inventory
-- change is recorded from day one. Confirmation itself is still sequential writes in this
-- milestone (see RPC note below); Milestone 5 wraps the same logic in a Postgres function for
-- real transaction atomicity, without changing what gets recorded.

create table if not exists ingredient_aliases (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  normalized_text text not null,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  -- Free-form origin tag ("purchase_import", "bake", ...), not a constrained enum -- an alias is
  -- "raw text -> ingredient id" regardless of where the raw text came from, and this column is
  -- audit-only, never read by the matching logic itself.
  source text,
  created_at timestamptz not null default now()
);

create unique index if not exists ingredient_aliases_raw_text_idx on ingredient_aliases (lower(trim(raw_text)));

alter table ingredient_aliases enable row level security;

grant select, insert, update, delete on table ingredient_aliases to authenticated;

drop policy if exists "Authenticated users can manage ingredient aliases" on ingredient_aliases;

create policy "Authenticated users can manage ingredient aliases"
  on ingredient_aliases for all
  to authenticated
  using (true)
  with check (true);


create table if not exists purchase_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  -- draft | confirmed | discarded. Plain text, no check constraint -- matches this app's existing
  -- convention for classification columns (see product_batches.launch_decision).
  status text not null default 'draft',
  imported_at timestamptz,
  row_count integer not null default 0,
  total_value numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table purchase_imports enable row level security;

grant select, insert, update, delete on table purchase_imports to authenticated;

drop policy if exists "Authenticated users can manage purchase imports" on purchase_imports;

create policy "Authenticated users can manage purchase imports"
  on purchase_imports for all
  to authenticated
  using (true)
  with check (true);


create table if not exists purchase_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references purchase_imports(id) on delete cascade,
  row_index integer not null,
  raw_item_name text not null,
  raw_quantity text not null,
  raw_unit text not null,
  raw_total_price text,
  raw_expiration_date text,
  parsed_quantity numeric,
  parsed_total_price numeric,
  parsed_expiration_date date,
  ingredient_id uuid references ingredients(id) on delete set null,
  -- alias | exact | normalized | manual | none.
  match_method text,
  converted_quantity numeric,
  -- pending | matched | excluded | invalid.
  row_status text not null default 'pending',
  exclude_reason text,
  validation_errors text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchase_import_rows_import_idx on purchase_import_rows (import_id);

alter table purchase_import_rows enable row level security;

grant select, insert, update, delete on table purchase_import_rows to authenticated;

drop policy if exists "Authenticated users can manage purchase import rows" on purchase_import_rows;

create policy "Authenticated users can manage purchase import rows"
  on purchase_import_rows for all
  to authenticated
  using (true)
  with check (true);


create table if not exists inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  -- purchase | consume | adjustment | waste. Only "purchase" is produced starting this
  -- milestone; the other three are reserved for later milestones (bake deduction, manual
  -- adjustment/waste) so no migration is needed when they're added.
  transaction_type text not null,
  -- Signed, always in the ingredient's base unit.
  quantity_change numeric not null,
  quantity_before numeric not null,
  quantity_after numeric not null,
  -- purchase_import | bake | manual.
  source_type text not null,
  source_id text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists inventory_transactions_ingredient_idx on inventory_transactions (ingredient_id, created_at desc);
create index if not exists inventory_transactions_source_idx on inventory_transactions (source_type, source_id);

alter table inventory_transactions enable row level security;

grant select, insert, update, delete on table inventory_transactions to authenticated;

drop policy if exists "Authenticated users can manage inventory transactions" on inventory_transactions;

create policy "Authenticated users can manage inventory transactions"
  on inventory_transactions for all
  to authenticated
  using (true)
  with check (true);

-- Milestone 5: atomic persistence for the two confirmations above. No new tables, no new
-- business logic -- applyPurchaseImportConfirmation/applyBakeConfirmation (src/lib) remain the
-- only place that decides *what* changes; these functions only apply an already-computed result
-- (ingredient updates + ledger rows) as one Postgres transaction, replacing the sequential
-- .update()/.insert() calls Milestones 2-4 used. A plpgsql function body is one implicit
-- transaction: any unhandled exception rolls back everything it already did, including earlier
-- iterations of the loops below -- that's the atomicity guarantee this milestone adds. Both
-- functions are `security invoker` (run with the calling user's own privileges/RLS, same as
-- every direct table call elsewhere in this app) -- no elevated privilege is needed since RLS
-- already grants `authenticated` full access to every table touched here.

create or replace function confirm_purchase_import(
  p_import_id uuid,
  -- [{ id, current_quantity, average_unit_cost, nearest_expiration_date }, ...] -- the exact
  -- per-ingredient result of applyPurchaseImportConfirmation, one entry per affected ingredient.
  p_ingredient_updates jsonb,
  -- [{ ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
  --    source_type, source_id, note }, ...] -- toInventoryTransactionRow's own shape, unchanged.
  p_transactions jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_status text;
  v_update jsonb;
  v_transaction jsonb;
begin
  -- Same guard confirmPurchaseImport already applies client-side before calling this function --
  -- re-checked here, against the real row, so two overlapping confirms (two tabs, a stale client)
  -- can't both apply. `for update` locks the row for the rest of this transaction.
  select status into v_status from purchase_imports where id = p_import_id for update;

  if v_status is null then
    raise exception 'Purchase import % not found', p_import_id;
  end if;

  if v_status <> 'draft' then
    raise exception 'Purchase import % is not a draft (status: %)', p_import_id, v_status;
  end if;

  for v_update in select * from jsonb_array_elements(p_ingredient_updates)
  loop
    update ingredients
    set
      current_quantity = (v_update->>'current_quantity')::numeric,
      average_unit_cost = (v_update->>'average_unit_cost')::numeric,
      nearest_expiration_date = nullif(v_update->>'nearest_expiration_date', '')::date,
      updated_at = now()
    where id = (v_update->>'id')::uuid;
  end loop;

  for v_transaction in select * from jsonb_array_elements(p_transactions)
  loop
    insert into inventory_transactions (
      ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
      source_type, source_id, note
    ) values (
      (v_transaction->>'ingredient_id')::uuid,
      v_transaction->>'transaction_type',
      (v_transaction->>'quantity_change')::numeric,
      (v_transaction->>'quantity_before')::numeric,
      (v_transaction->>'quantity_after')::numeric,
      v_transaction->>'source_type',
      v_transaction->>'source_id',
      v_transaction->>'note'
    );
  end loop;

  update purchase_imports
  set status = 'confirmed', imported_at = now(), updated_at = now()
  where id = p_import_id;
end;
$$;

grant execute on function confirm_purchase_import(uuid, jsonb, jsonb) to authenticated;

create or replace function confirm_bake(
  -- [{ id, current_quantity }, ...] -- bake never touches average_unit_cost or
  -- nearest_expiration_date, so this payload (unlike purchase import's) carries only the one
  -- field applyBakeConfirmation ever changes.
  p_ingredient_updates jsonb,
  p_transactions jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_update jsonb;
  v_transaction jsonb;
begin
  for v_update in select * from jsonb_array_elements(p_ingredient_updates)
  loop
    update ingredients
    set current_quantity = (v_update->>'current_quantity')::numeric, updated_at = now()
    where id = (v_update->>'id')::uuid;
  end loop;

  for v_transaction in select * from jsonb_array_elements(p_transactions)
  loop
    insert into inventory_transactions (
      ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
      source_type, source_id, note
    ) values (
      (v_transaction->>'ingredient_id')::uuid,
      v_transaction->>'transaction_type',
      (v_transaction->>'quantity_change')::numeric,
      (v_transaction->>'quantity_before')::numeric,
      (v_transaction->>'quantity_after')::numeric,
      v_transaction->>'source_type',
      v_transaction->>'source_id',
      v_transaction->>'note'
    );
  end loop;
end;
$$;

grant execute on function confirm_bake(jsonb, jsonb) to authenticated;

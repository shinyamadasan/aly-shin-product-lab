-- CSV Purchase Import v2: package-quantity math (N packages x pack size), a receipt-level header
-- (supplier/receipt number/purchase date), and confirming an import now also writes a SupplyEntry
-- per row (previously CSV imports only ever touched ingredients/inventory_transactions -- they
-- were invisible to Costing's auto-pricing and the Purchases > Supplier Comparison list, which
-- only ever read supply_entries).
--
-- Safe to run more than once (all statements are IF NOT EXISTS / CREATE OR REPLACE). Purely
-- additive -- no column is dropped, no existing row is changed, no existing table/RPC behavior
-- changes unless the app now sends the new fields.

alter table purchase_imports add column if not exists supplier_name text;
alter table purchase_imports add column if not exists receipt_number text;
alter table purchase_imports add column if not exists purchase_date date;

alter table purchase_import_rows add column if not exists raw_package_count text;
alter table purchase_import_rows add column if not exists raw_package_size text;
alter table purchase_import_rows add column if not exists raw_package_unit text;
alter table purchase_import_rows add column if not exists raw_category text;
alter table purchase_import_rows add column if not exists raw_supplier text;
alter table purchase_import_rows add column if not exists raw_receipt_number text;
alter table purchase_import_rows add column if not exists raw_purchase_date text;
alter table purchase_import_rows add column if not exists raw_unit_price text;
alter table purchase_import_rows add column if not exists parsed_package_count numeric;
alter table purchase_import_rows add column if not exists parsed_package_size numeric;
alter table purchase_import_rows add column if not exists parsed_unit_price numeric;
alter table purchase_import_rows add column if not exists is_quantity_overridden boolean not null default false;
-- Purchase-level, not ingredient-level -- see PROP-010 in planning/PROPOSALS.md. Required (app-side,
-- not a NOT NULL column here -- a draft row can exist mid-review before the operator has picked a
-- brand) before a row can be confirmed, so every SupplyEntry this importer creates has a real brand.
alter table purchase_import_rows add column if not exists brand_name text;

-- Milestone 6: confirm_purchase_import now also inserts one supply_entries row per confirmed
-- purchase-import row, in the same atomic transaction as the ingredient/ledger updates it already
-- applied -- so a CSV import and a manual "Log a purchase" entry are equally visible to Costing and
-- Supplier Comparison. p_ingredient_updates and p_transactions are unchanged; p_supply_entries is
-- new. A 4-argument signature is a different overload from the original 3-argument one in
-- Postgres, not a replacement of it -- drop the old signature explicitly first so exactly one
-- version of this function exists (the app always calls with all 4 arguments after this ships).
drop function if exists confirm_purchase_import(uuid, jsonb, jsonb);

create or replace function confirm_purchase_import(
  p_import_id uuid,
  p_ingredient_updates jsonb,
  p_transactions jsonb,
  -- [{ ingredient_id, ingredient_name, brand_name, supplier_name, purchase_date, pack_quantity, unit,
  --    total_cost, notes }, ...] -- one per confirmed row. No `id`: matches inventory_transactions'
  -- convention of letting Postgres's own gen_random_uuid() default assign it, since nothing else
  -- needs to reference a supply_entries row's id synchronously. quality_rating is intentionally
  -- absent too (a CSV receipt carries no quality signal; the column keeps its own default).
  p_supply_entries jsonb default '[]'::jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_status text;
  v_update jsonb;
  v_transaction jsonb;
  v_supply jsonb;
begin
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

  for v_supply in select * from jsonb_array_elements(p_supply_entries)
  loop
    insert into supply_entries (
      ingredient_id, ingredient_name, brand_name, supplier_name, purchase_date,
      pack_quantity, unit, total_cost, notes
    ) values (
      nullif(v_supply->>'ingredient_id', '')::uuid,
      v_supply->>'ingredient_name',
      v_supply->>'brand_name',
      v_supply->>'supplier_name',
      -- purchase_date is NOT NULL on supply_entries; the app always sends a real date (defaults to
      -- "today" when the CSV/header supplied none), so nullif/cast is defensive, not load-bearing.
      coalesce(nullif(v_supply->>'purchase_date', '')::date, current_date),
      (v_supply->>'pack_quantity')::numeric,
      v_supply->>'unit',
      (v_supply->>'total_cost')::numeric,
      v_supply->>'notes'
    );
  end loop;

  update purchase_imports
  set status = 'confirmed', imported_at = now(), updated_at = now()
  where id = p_import_id;
end;
$$;

grant execute on function confirm_purchase_import(uuid, jsonb, jsonb, jsonb) to authenticated;

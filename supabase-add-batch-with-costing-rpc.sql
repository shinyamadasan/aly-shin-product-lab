-- Atomic batch + costing creation.
--
-- Used by Product Lab's "Duplicate as new version" flow: the app computes the copied batch,
-- refreshed costing entries, costing totals, selling formats, and packaging lines, then this
-- function writes the graph in one transaction. It deliberately contains no costing formulas.

create or replace function create_batch_with_costing(
  p_batch jsonb,
  p_costing jsonb,
  p_costing_entries jsonb default '[]'::jsonb,
  p_selling_formats jsonb default '[]'::jsonb,
  p_selling_format_packaging_lines jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch_id uuid := (p_batch->>'id')::uuid;
  v_costing_id uuid := (p_costing->>'id')::uuid;
  v_product_id text := p_batch->>'product_id';
begin
  if auth.uid() is null then
    raise exception 'create_batch_with_costing requires an authenticated user';
  end if;

  if v_batch_id is null or v_costing_id is null or nullif(v_product_id, '') is null then
    raise exception 'create_batch_with_costing requires batch id, costing id, and product id';
  end if;

  if p_costing->>'product_id' is distinct from v_product_id then
    raise exception 'Costing product_id must match batch product_id';
  end if;

  if (p_costing->>'batch_id')::uuid is distinct from v_batch_id then
    raise exception 'Costing batch_id must match batch id';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_costing_entries, '[]'::jsonb)) as entry
    where entry->>'product_id' is distinct from v_product_id
       or (entry->>'batch_id')::uuid is distinct from v_batch_id
  ) then
    raise exception 'Every costing entry must match the new batch product and batch id';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_selling_formats, '[]'::jsonb)) as format
    where (format->>'costing_id')::uuid is distinct from v_costing_id
  ) then
    raise exception 'Every selling format must match the new costing id';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_selling_format_packaging_lines, '[]'::jsonb)) as line
    where not exists (
      select 1
      from jsonb_array_elements(coalesce(p_selling_formats, '[]'::jsonb)) as format
      where (format->>'id')::uuid = (line->>'selling_format_id')::uuid
    )
  ) then
    raise exception 'Every selling format packaging line must belong to a submitted selling format';
  end if;

  insert into product_batches (
    id,
    product_id,
    batch_version,
    date_made,
    ingredients_notes,
    prep_time_minutes,
    bake_time_minutes,
    cooling_time_minutes,
    usable_pieces,
    imperfect_pieces,
    stress_level,
    taste_notes,
    texture_notes,
    went_wrong,
    improve_next,
    launch_decision,
    status,
    completed_at,
    voided_at,
    void_reason
  )
  values (
    v_batch_id,
    v_product_id,
    p_batch->>'batch_version',
    (p_batch->>'date_made')::date,
    p_batch->>'ingredients_notes',
    coalesce((p_batch->>'prep_time_minutes')::integer, 0),
    coalesce((p_batch->>'bake_time_minutes')::integer, 0),
    coalesce((p_batch->>'cooling_time_minutes')::integer, 0),
    coalesce((p_batch->>'usable_pieces')::integer, 0),
    coalesce((p_batch->>'imperfect_pieces')::integer, 0),
    coalesce((p_batch->>'stress_level')::integer, 3),
    coalesce(p_batch->>'taste_notes', ''),
    coalesce(p_batch->>'texture_notes', ''),
    coalesce(p_batch->>'went_wrong', ''),
    coalesce(p_batch->>'improve_next', ''),
    coalesce(nullif(p_batch->>'launch_decision', ''), 'retest'),
    coalesce(nullif(p_batch->>'status', ''), 'draft'),
    nullif(p_batch->>'completed_at', '')::timestamptz,
    nullif(p_batch->>'voided_at', '')::timestamptz,
    nullif(p_batch->>'void_reason', '')
  );

  insert into costing_entries (
    id,
    product_id,
    batch_id,
    ingredient_name,
    quantity_used,
    unit,
    cost,
    supplier_note
  )
  select
    (entry->>'id')::uuid,
    entry->>'product_id',
    (entry->>'batch_id')::uuid,
    entry->>'ingredient_name',
    coalesce((entry->>'quantity_used')::numeric, 0),
    coalesce(entry->>'unit', ''),
    coalesce((entry->>'cost')::numeric, 0),
    coalesce(entry->>'supplier_note', '')
  from jsonb_array_elements(coalesce(p_costing_entries, '[]'::jsonb)) as entry;

  insert into costing_summaries (
    id,
    product_id,
    batch_id,
    ingredient_cost,
    packaging_cost,
    labor_estimate,
    water_cost,
    gas_cost,
    oven_electric_cost,
    refrigeration_cost,
    coffee_equipment_cost,
    waste_allowance,
    overhead_cost,
    equipment_cost,
    suggested_price,
    notes,
    updated_at
  )
  values (
    v_costing_id,
    v_product_id,
    v_batch_id,
    coalesce((p_costing->>'ingredient_cost')::numeric, 0),
    coalesce((p_costing->>'packaging_cost')::numeric, 0),
    coalesce((p_costing->>'labor_estimate')::numeric, 0),
    coalesce((p_costing->>'water_cost')::numeric, 0),
    coalesce((p_costing->>'gas_cost')::numeric, 0),
    coalesce((p_costing->>'oven_electric_cost')::numeric, 0),
    coalesce((p_costing->>'refrigeration_cost')::numeric, 0),
    coalesce((p_costing->>'coffee_equipment_cost')::numeric, 0),
    coalesce((p_costing->>'waste_allowance')::numeric, 0),
    coalesce((p_costing->>'overhead_cost')::numeric, 0),
    coalesce((p_costing->>'equipment_cost')::numeric, 0),
    coalesce((p_costing->>'suggested_price')::numeric, 0),
    coalesce(p_costing->>'notes', ''),
    coalesce((p_costing->>'updated_at')::timestamptz, now())
  );

  insert into selling_formats (
    id,
    costing_id,
    name,
    pieces_per_unit,
    selling_price,
    is_active,
    sort_order,
    notes
  )
  select
    (format->>'id')::uuid,
    (format->>'costing_id')::uuid,
    format->>'name',
    coalesce((format->>'pieces_per_unit')::numeric, 1),
    coalesce((format->>'selling_price')::numeric, 0),
    coalesce((format->>'is_active')::boolean, true),
    coalesce((format->>'sort_order')::integer, 0),
    coalesce(format->>'notes', '')
  from jsonb_array_elements(coalesce(p_selling_formats, '[]'::jsonb)) as format;

  insert into selling_format_packaging_lines (
    id,
    selling_format_id,
    ingredient_id,
    name,
    quantity,
    unit,
    unit_cost_snapshot,
    is_manual_cost,
    note,
    sort_order
  )
  select
    (line->>'id')::uuid,
    (line->>'selling_format_id')::uuid,
    nullif(line->>'ingredient_id', '')::uuid,
    line->>'name',
    coalesce((line->>'quantity')::numeric, 1),
    coalesce(line->>'unit', ''),
    coalesce((line->>'unit_cost_snapshot')::numeric, 0),
    coalesce((line->>'is_manual_cost')::boolean, false),
    coalesce(line->>'note', ''),
    coalesce((line->>'sort_order')::integer, 0)
  from jsonb_array_elements(coalesce(p_selling_format_packaging_lines, '[]'::jsonb)) as line;

  return jsonb_build_object('batch_id', v_batch_id, 'costing_id', v_costing_id);
end $$;

revoke execute on function create_batch_with_costing(jsonb, jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function create_batch_with_costing(jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;

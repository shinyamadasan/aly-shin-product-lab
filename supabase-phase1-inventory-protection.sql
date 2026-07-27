alter table ingredients
  add column if not exists archived_at timestamptz;

alter table product_batches
  add column if not exists status text not null default 'draft',
  add column if not exists completed_at timestamptz,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

do $$
declare
  constraint_name text;
begin
  select tc.constraint_name
  into constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_schema = kcu.constraint_schema
    and tc.constraint_name = kcu.constraint_name
  join information_schema.constraint_column_usage ccu
    on tc.constraint_schema = ccu.constraint_schema
    and tc.constraint_name = ccu.constraint_name
  where tc.table_schema = 'public'
    and tc.table_name = 'inventory_transactions'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'ingredient_id'
    and ccu.table_name = 'ingredients'
    and ccu.column_name = 'id'
  limit 1;

  if constraint_name is not null then
    execute format('alter table inventory_transactions drop constraint %I', constraint_name);
  end if;

  alter table inventory_transactions
    add constraint inventory_transactions_ingredient_id_fkey
    foreign key (ingredient_id) references ingredients(id) on delete restrict;
end $$;

notify pgrst, 'reload schema';

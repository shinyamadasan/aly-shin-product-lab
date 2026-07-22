create table if not exists supply_entries (
  id uuid primary key default gen_random_uuid(),
  ingredient_name text not null,
  supplier_name text not null,
  purchase_date date not null default current_date,
  pack_quantity numeric not null default 0,
  unit text,
  total_cost numeric not null default 0,
  quality_rating numeric not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table supply_entries enable row level security;

grant select, insert, update, delete on table supply_entries to authenticated;

drop policy if exists "Authenticated users can manage supply entries" on supply_entries;

create policy "Authenticated users can manage supply entries"
  on supply_entries for all
  to authenticated
  using (true)
  with check (true);

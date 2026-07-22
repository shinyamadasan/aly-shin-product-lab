create table if not exists equipment (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text,
  model text,
  purchase_price numeric not null default 0,
  purchase_date date not null default current_date,
  residual_value_percent numeric not null default 10,
  useful_life_years numeric not null default 5,
  batches_per_week numeric not null default 4,
  annual_maintenance_percent numeric not null default 3,
  batches_per_unit numeric not null default 0,
  calculation_mode text not null default 'depreciation',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table equipment
  add column if not exists batches_per_unit numeric not null default 0;

alter table equipment enable row level security;

grant select, insert, update, delete on table equipment to authenticated;

drop policy if exists "Authenticated users can manage equipment" on equipment;

create policy "Authenticated users can manage equipment"
  on equipment for all
  to authenticated
  using (true)
  with check (true);

insert into equipment (name, brand, model, purchase_price, residual_value_percent, useful_life_years, batches_per_week, annual_maintenance_percent, calculation_mode, is_active)
select 'Table Oven', 'La Germania', 'SL-100-10W', 8500, 10, 5, 4, 3, 'depreciation', true
where not exists (select 1 from equipment where brand = 'La Germania' and model = 'SL-100-10W');

insert into equipment (name, brand, model, purchase_price, residual_value_percent, useful_life_years, batches_per_week, annual_maintenance_percent, calculation_mode, is_active)
select 'Stand Mixer', 'Hanabishi', 'HPSTMIX50', 6500, 10, 5, 4, 3, 'depreciation', true
where not exists (select 1 from equipment where brand = 'Hanabishi' and model = 'HPSTMIX50');

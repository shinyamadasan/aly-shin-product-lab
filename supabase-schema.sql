create table if not exists products (
  id text primary key,
  name text not null,
  category text not null,
  product_role text not null,
  status text not null default 'testing',
  description text,
  notes text,
  main_photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_batches (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  batch_version text not null,
  date_made date not null,
  ingredients_notes text,
  prep_start_time time,
  prep_time_minutes integer,
  bake_time_minutes integer,
  cooling_time_minutes integer,
  usable_pieces integer,
  imperfect_pieces integer,
  stress_level integer check (stress_level between 1 and 5),
  taste_notes text,
  texture_notes text,
  went_wrong text,
  improve_next text,
  launch_decision text not null default 'retest',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists batch_photos (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references product_batches(id) on delete cascade,
  photo_url text not null,
  photo_type text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists costing_entries (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  batch_id uuid references product_batches(id) on delete set null,
  ingredient_name text not null,
  quantity_used numeric,
  unit text,
  cost numeric not null default 0,
  supplier_note text,
  created_at timestamptz not null default now()
);

create table if not exists costing_summaries (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  batch_id uuid references product_batches(id) on delete set null,
  ingredient_cost numeric not null default 0,
  packaging_cost numeric not null default 0,
  labor_estimate numeric not null default 0,
  utilities_estimate numeric not null default 0,
  water_cost numeric not null default 0,
  gas_cost numeric not null default 0,
  oven_electric_cost numeric not null default 0,
  refrigeration_cost numeric not null default 0,
  coffee_equipment_cost numeric not null default 0,
  waste_allowance numeric not null default 0,
  suggested_price numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasting_feedback (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  batch_id uuid references product_batches(id) on delete set null,
  taster_name text not null,
  rating integer check (rating between 1 and 10),
  liked text,
  improve text,
  would_buy text,
  willing_to_pay numeric,
  would_reorder text,
  packaging_reaction text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists content_journal (
  id uuid primary key default gen_random_uuid(),
  product_id text references products(id) on delete set null,
  batch_id uuid references product_batches(id) on delete set null,
  entry_date date not null default current_date,
  what_was_made text,
  what_was_tested text,
  media_captured text,
  reactions text,
  lesson_learned text,
  post_ideas text,
  reel_ideas text,
  caption_draft text,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table products enable row level security;
alter table product_batches enable row level security;
alter table batch_photos enable row level security;
alter table costing_entries enable row level security;
alter table costing_summaries enable row level security;
alter table tasting_feedback enable row level security;
alter table content_journal enable row level security;

drop policy if exists "Authenticated users can read products" on products;
drop policy if exists "Authenticated users can manage products" on products;
drop policy if exists "Authenticated users can manage product batches" on product_batches;
drop policy if exists "Authenticated users can manage batch photos" on batch_photos;
drop policy if exists "Authenticated users can manage costing entries" on costing_entries;
drop policy if exists "Authenticated users can manage costing summaries" on costing_summaries;
drop policy if exists "Authenticated users can manage tasting feedback" on tasting_feedback;
drop policy if exists "Authenticated users can manage content journal" on content_journal;

create policy "Authenticated users can read products"
  on products for select
  to authenticated
  using (true);

create policy "Authenticated users can manage products"
  on products for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage product batches"
  on product_batches for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage batch photos"
  on batch_photos for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage costing entries"
  on costing_entries for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage costing summaries"
  on costing_summaries for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage tasting feedback"
  on tasting_feedback for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage content journal"
  on content_journal for all
  to authenticated
  using (true)
  with check (true);

insert into products (id, name, category, product_role, status, description)
values
  ('brownies', 'Brownies', 'Baked goods', 'Hero candidate', 'testing', 'Fudgy brownie candidate for the first weekend dessert box.'),
  ('cookies', 'Cookies', 'Baked goods', 'Hero candidate', 'testing', 'Cookie candidate to test size, texture, freshness, and giftability.'),
  ('revel-bars', 'Revel Bars', 'Baked goods', 'Hero candidate', 'testing', 'Layered oat and chocolate bar candidate for the first box.'),
  ('burnt-cheesecake', 'Burnt Cheesecake', 'Cheesecake', 'Premium upgrade', 'testing', 'Premium candidate that needs careful costing, chilling, and packaging tests.'),
  ('caramel-macchiato', 'Bottled Caramel Macchiato', 'Coffee', 'Add-on candidate', 'paused', 'Coffee add-on candidate. Needs freshness and premium-feel proof before launch.'),
  ('spanish-latte', 'Bottled Spanish Latte', 'Coffee', 'Add-on candidate', 'paused', 'Coffee add-on candidate. Should not lead the first offer until tested.')
on conflict do nothing;

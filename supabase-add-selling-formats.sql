-- Selling Formats: lets one Costing express multiple ways a batch is actually sold (e.g. "Single
-- Brownie", "Box of 3", "Box of 6"), each with its own packaging line items, selling price, and
-- computed cost/profit/margin -- instead of one lump packaging cost averaged evenly across the
-- whole batch. See the approved plan ("Selling Formats: fixing how Costing handles per-package-
-- size packaging", Revision 3) for the full design.
--
-- Safe to run more than once (create table if not exists / create unique index if not exists).
-- Purely additive: no existing table is altered, no existing row is touched.
--
-- Ownership: selling_formats.costing_id references costing_summaries(id) directly -- not the
-- (batch_id, product_id) scoping costing_entries uses -- so a costing's selling formats can never
-- be orphaned by reassigning that costing to a different batch, and a deleted costing cleanly
-- cascades its formats and lines away with it.

create table if not exists selling_formats (
  id uuid primary key default gen_random_uuid(),
  costing_id uuid not null references costing_summaries(id) on delete cascade,
  name text not null,
  pieces_per_unit numeric not null check (pieces_per_unit > 0),
  selling_price numeric not null default 0 check (selling_price >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case- and whitespace-insensitive: "Box of 6" and " box of 6 " collide within one costing.
create unique index if not exists selling_formats_costing_name_unique_idx
  on selling_formats (costing_id, lower(trim(name)));

create table if not exists selling_format_packaging_lines (
  id uuid primary key default gen_random_uuid(),
  selling_format_id uuid not null references selling_formats(id) on delete cascade,
  ingredient_id uuid references ingredients(id) on delete set null,
  name text not null,
  quantity numeric not null default 1 check (quantity > 0),
  unit text,
  unit_cost_snapshot numeric not null default 0,
  is_manual_cost boolean not null default false,
  note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Re-picking the same catalog item within one format merges into the existing line instead of
-- duplicating it (enforced at the app layer); this index makes that the only possible outcome at
-- the database layer too. Manual lines (ingredient_id is null) are unrestricted -- free-text
-- names can't be reliably matched, so repeats are allowed there.
create unique index if not exists selling_format_packaging_lines_catalog_unique_idx
  on selling_format_packaging_lines (selling_format_id, ingredient_id)
  where ingredient_id is not null;

comment on column selling_format_packaging_lines.unit_cost_snapshot is 'Frozen per-unit cost at full precision -- do not round before storing. Bulk-purchased packaging (e.g. 1000 sheets for PHP 275) can have a genuine sub-centavo per-unit cost, and rounding here before multiplying by quantity would compound error across every line. Round only at final display.';

alter table selling_formats enable row level security;
alter table selling_format_packaging_lines enable row level security;

grant select, insert, update, delete on table selling_formats to authenticated;
grant select, insert, update, delete on table selling_format_packaging_lines to authenticated;

drop policy if exists "Authenticated users can manage selling formats" on selling_formats;
drop policy if exists "Authenticated users can manage selling format packaging lines" on selling_format_packaging_lines;

create policy "Authenticated users can manage selling formats"
  on selling_formats for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage selling format packaging lines"
  on selling_format_packaging_lines for all
  to authenticated
  using (true)
  with check (true);

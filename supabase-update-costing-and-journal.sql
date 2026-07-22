alter table costing_summaries
  add column if not exists ingredient_cost numeric not null default 0;

alter table costing_summaries
  add column if not exists water_cost numeric not null default 0,
  add column if not exists gas_cost numeric not null default 0,
  add column if not exists oven_electric_cost numeric not null default 0,
  add column if not exists refrigeration_cost numeric not null default 0,
  add column if not exists coffee_equipment_cost numeric not null default 0;

grant select, insert, update, delete on table costing_entries to authenticated;
grant select, insert, update, delete on table costing_summaries to authenticated;
grant select, insert, update, delete on table content_journal to authenticated;

drop policy if exists "Authenticated users can manage costing entries" on costing_entries;
drop policy if exists "Authenticated users can manage costing summaries" on costing_summaries;
drop policy if exists "Authenticated users can manage content journal" on content_journal;

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

create policy "Authenticated users can manage content journal"
  on content_journal for all
  to authenticated
  using (true)
  with check (true);

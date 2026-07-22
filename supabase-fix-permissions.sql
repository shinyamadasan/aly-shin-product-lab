grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on table products to authenticated;
grant select, insert, update, delete on table product_batches to authenticated;
grant select, insert, update, delete on table batch_photos to authenticated;
grant select, insert, update, delete on table costing_entries to authenticated;
grant select, insert, update, delete on table costing_summaries to authenticated;
grant select, insert, update, delete on table tasting_feedback to authenticated;
grant select, insert, update, delete on table content_journal to authenticated;

grant usage, select on all sequences in schema public to authenticated;

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

-- batch_photos TABLE already exists in supabase-schema.sql. This file only adds the
-- Storage bucket that actually holds the image files -- the table just stores the URL.
-- Bucket is public so the app can use getPublicUrl() directly with no signed-URL refresh
-- logic. Run this once in the Supabase SQL editor.

insert into storage.buckets (id, name, public)
values ('batch-photos', 'batch-photos', true)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can manage batch photo files" on storage.objects;

create policy "Authenticated users can manage batch photo files"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'batch-photos')
  with check (bucket_id = 'batch-photos');

-- batch_photos TABLE already exists in supabase-schema.sql. This file adds the Storage
-- bucket that actually holds the image files, plus a small follow-up column and a doc
-- comment picked up from a guardian-agent review. Run this once (or again, it's
-- idempotent) in the Supabase SQL editor.
--
-- Bucket is public so the app can use getPublicUrl() directly with no signed-URL refresh
-- logic. file_size_limit / allowed_mime_types are enforced by Supabase Storage itself, not
-- by app code -- this is the only check that still applies if someone calls the storage API
-- directly instead of going through the app's file input.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('batch-photos', 'batch-photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Authenticated users can manage batch photo files" on storage.objects;

create policy "Authenticated users can manage batch photo files"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'batch-photos')
  with check (bucket_id = 'batch-photos');

-- The app used to re-derive the storage object path from the public photo_url string on
-- delete -- fragile, and it silently skipped the storage removal (while still reporting
-- "Photo deleted") whenever the URL didn't match the expected shape. Storing the path
-- directly at upload time removes the guesswork.
alter table batch_photos add column if not exists storage_path text;

comment on column product_batches.ingredients_notes is
  'JSON: { formula: BatchFormulaRow[], steps: string[] }. Column name predates the steps field -- it is not freeform notes.';

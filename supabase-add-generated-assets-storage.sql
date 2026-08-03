-- PROP-025 generated Asset Storage bucket. Safe to run more than once in the Supabase SQL editor.
-- Apply after the PROP-023/024 Asset Job schema and before
-- supabase-add-asset-job-file-materialization.sql.
--
-- This migration is additive: it does not modify any shipped PROP-023/024 SQL file and creates
-- no public read policy, signed URL UI, provider table, approval table, publishing table, or
-- Creative Job dependency.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generated-assets', 'generated-assets', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Authenticated users can manage generated asset files" on storage.objects;

create policy "Authenticated users can manage generated asset files"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'generated-assets')
  with check (bucket_id = 'generated-assets');

-- Production MVP Wave A storage verification. READ-ONLY.
-- Catalog inspection only: no DDL, no DML, no bucket creation, no policy change, no upload.
-- Safe to run repeatedly, and safe to run BEFORE the migration (it reports the pre-migration state
-- rather than failing). Paste the whole file into the Supabase SQL Editor and return the output.
--
-- Verifies supabase-add-generated-assets-video.sql, and equally importantly verifies what that
-- migration must NOT have changed: visibility, policies, and the existing image MIME types.

with b as (
  select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
  where id = 'generated-assets'
)
select * from (

  -- 1. bucket still exists
  select 1 as n, 'generated-assets bucket exists' as check_name,
    case when exists (select 1 from b) then 'PASS' else 'FAIL' end as status,
    coalesce((select id from b), '(absent -- apply supabase-add-generated-assets-storage.sql first)') as detail

  -- 2. still private. The migration must never make generated assets publicly readable.
  union all select 2, 'bucket remains private (public = false)',
    case when (select public from b) = false then 'PASS' else 'FAIL' end,
    'public=' || coalesce((select public::text from b), '(absent)')

  -- 3. video/mp4 admitted -- the actual point of the migration
  union all select 3, 'video/mp4 is allowed',
    case when 'video/mp4' = any ((select allowed_mime_types from b)) then 'PASS' else 'FAIL (migration not applied yet)' end,
    coalesce(array_to_string((select allowed_mime_types from b), ', '), '(absent)')

  -- 4. every pre-existing image type still admitted. A replacement rather than an addition would
  -- break every Asset ever produced, so this is checked member by member.
  union all select 4, 'existing image MIME types still allowed',
    case when 'image/png' = any ((select allowed_mime_types from b))
              and 'image/jpeg' = any ((select allowed_mime_types from b))
              and 'image/webp' = any ((select allowed_mime_types from b))
         then 'PASS' else 'FAIL' end,
    'png=' || ('image/png' = any ((select allowed_mime_types from b)))::text
      || ' jpeg=' || ('image/jpeg' = any ((select allowed_mime_types from b)))::text
      || ' webp=' || ('image/webp' = any ((select allowed_mime_types from b)))::text

  -- 5. no unexpected MIME type crept in
  union all select 5, 'exactly the four intended MIME types',
    case when (select array_length(allowed_mime_types, 1) from b) = 4 then 'PASS' else 'REVIEW' end,
    coalesce((select array_length(allowed_mime_types, 1)::text from b), '(absent)') || ' type(s) allowed'

  -- 6. size limit raised to exactly 50 MB. Not merely ">= 10 MB": a value above 50 MB would exceed
  -- the Free-plan global object limit and is outside what Wave A authored.
  union all select 6, 'file_size_limit is 50 MB',
    case when (select file_size_limit from b) = 52428800 then 'PASS'
         when (select file_size_limit from b) = 10485760 then 'FAIL (migration not applied yet)'
         else 'REVIEW (unexpected value)' end,
    coalesce((select file_size_limit::text from b), '(absent)') || ' bytes'

  -- 7. the storage RLS policy is untouched -- same name, same table, still exactly one
  union all select 7, 'generated-assets storage policy unchanged',
    case when (select count(*) from pg_policies
               where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'Authenticated users can manage generated asset files') = 1
         then 'PASS' else 'REVIEW' end,
    (select count(*)::text from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'Authenticated users can manage generated asset files') || ' matching policy(ies)'

  -- 8. no video has been uploaded yet. Wave A produces no video; a non-zero count here means
  -- something ran that should not have.
  union all select 8, 'no video objects stored yet (Wave A produces none)',
    case when (select count(*) from storage.objects
               where bucket_id = 'generated-assets'
                 and (metadata ->> 'mimetype') = 'video/mp4') = 0
         then 'PASS' else 'REVIEW' end,
    (select count(*)::text from storage.objects
     where bucket_id = 'generated-assets' and (metadata ->> 'mimetype') = 'video/mp4') || ' video object(s); '
      || (select count(*)::text from storage.objects where bucket_id = 'generated-assets') || ' object(s) total'

  -- 9. asset_files remains image-only, confirming no short_video Asset was materialized
  union all select 9, 'no short_video asset rows exist yet',
    case when (select count(*) from asset_jobs where asset_kind <> 'image') = 0 then 'PASS' else 'REVIEW' end,
    (select count(*)::text from asset_jobs where asset_kind <> 'image') || ' non-image Asset Job(s); '
      || (select count(*)::text from asset_jobs) || ' Asset Job(s) total'

  -- 10. no Asset Job names a worker that cannot be claimed. This is the database-side mirror of the
  -- Wave A runtime activation boundary: image_provider and remotion have no executor, so a queued
  -- row carrying either would never complete.
  union all select 10, 'no Asset Job names an unregistered worker',
    case when (select count(*) from asset_jobs where worker_type not in ('mock', 'external')) = 0 then 'PASS' else 'FAIL' end,
    (select count(*)::text from asset_jobs where worker_type not in ('mock', 'external')) || ' row(s) with an unregistered worker_type; '
      || 'distinct present: ' || coalesce((select string_agg(distinct worker_type, ', ') from asset_jobs), '(none)')

) result
order by n;

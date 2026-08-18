-- Production MVP Wave A -- generated-assets bucket video support. Safe to run more than once in the
-- Supabase SQL editor.
--
-- This migration is CONFIG-ONLY. It creates no table, alters no column, adds no index, changes no
-- RLS policy, changes no bucket visibility, and rewrites no data. It updates exactly two settings on
-- the existing 'generated-assets' bucket created by supabase-add-generated-assets-storage.sql:
--
--   1. allowed_mime_types  -- adds video/mp4 alongside the existing three image types.
--   2. file_size_limit     -- raises 10 MB to 50 MB.
--
-- WHY BOTH, AND WHY NOW
--
-- Wave A widened the TypeScript asset-kind vocabulary to include short_video and taught the
-- candidate validator a video branch. Neither of those can put a byte in storage: the bucket rejects
-- video/mp4 at the storage layer before any application code runs, which is the correct place for
-- that gate and the reason this file exists separately from the code change.
--
-- 10 MB was sized for a single 1080x1080 still. A 1080x1920 H.264 Reel of six to ten seconds is
-- typically 2-8 MB, so 10 MB is not obviously too small -- it is too close. 50 MB is chosen because
-- it is the ceiling that holds on EVERY Supabase plan including Free, where the global per-object
-- limit is 50 MB and a bucket limit may not exceed the global one. Nothing here requires Pro.
--
-- NOT APPLIED BY THE BUILDER. Apply this before Wave C needs MP4 upload; Wave A and Wave B do not
-- depend on it. Verify with verify-production-wave-a-storage.sql, which is read-only.
--
-- PRECONDITION FIRST, AND FATAL. The bucket must already exist. This file must never create it --
-- supabase-add-generated-assets-storage.sql owns the bucket and owns its visibility and policy
-- decisions -- so a missing bucket is an operator error, not a state to paper over. It raises an
-- exception rather than a warning for two reasons: every other precondition guard in this repo
-- (supabase-add-asset-files.sql, supabase-add-asset-job-attempts.sql) uses raise exception, and a
-- warning lands in the SQL Editor notices pane where a no-op update reads as success. Nothing is
-- lost by aborting: when the bucket is absent the update below matches zero rows anyway.

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'generated-assets') then
    raise exception 'generated-assets bucket does not exist. Apply supabase-add-generated-assets-storage.sql first, then re-run this migration.';
  end if;
end $$;

update storage.buckets
set
  -- Existing image types are preserved verbatim. This is an addition, not a replacement: every
  -- Asset ever produced is a PNG/JPEG/WebP and must keep uploading and downloading unchanged.
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'video/mp4'],
  file_size_limit = 52428800
where id = 'generated-assets';

-- Idempotent by construction: the update above is an absolute assignment rather than an append, so
-- running it twice produces the same row. Re-running this file against an already-migrated bucket
-- passes the precondition and rewrites the same two settings to the same values.

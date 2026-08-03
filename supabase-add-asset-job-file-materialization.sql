-- PROP-025 byte-backed Asset Job completion + Asset/File materialization. Safe to run more than
-- once in the Supabase SQL editor after supabase-add-generated-assets-storage.sql.
--
-- This migration is additive: it does not modify shipped PROP-023/024 SQL files. It creates no
-- new status, no Creative Job coupling, no provider table, no approval table, no publishing table,
-- and no public Storage read path.

create or replace function complete_asset_job_with_files(
  p_asset_job_id uuid,
  p_result jsonb,
  p_files jsonb
)
returns table (
  job jsonb,
  asset jsonb,
  files jsonb
)
language plpgsql
as $$
declare
  job_record asset_jobs%rowtype;
  asset_record assets%rowtype;
  expected_asset_content jsonb;
  file_record record;
  existing_file_record asset_files%rowtype;
begin
  select *
    into job_record
  from asset_jobs
  where id = p_asset_job_id
    and status = 'running'
  for update;

  if not found then
    raise exception 'Asset Job % was not found in running state.', p_asset_job_id;
  end if;

  expected_asset_content := jsonb_build_object(
    'metadata',
    jsonb_build_object(
      'generatedFromCreativePackage', job_record.creative_package_id::text,
      'sourceAssetJobId', job_record.id::text,
      'generatorVersion', '1'
    )
  );

  insert into assets (asset_job_id, status, asset_kind, schema_version, content, updated_at)
  values (
    p_asset_job_id,
    'generated',
    job_record.asset_kind,
    'v1',
    expected_asset_content,
    now()
  )
  on conflict (asset_job_id) do nothing
  returning * into asset_record;

  if asset_record.id is null then
    select *
      into asset_record
    from assets
    where asset_job_id = p_asset_job_id
    for update;
  end if;

  if asset_record.asset_job_id <> p_asset_job_id
    or asset_record.status <> 'generated'
    or asset_record.asset_kind <> job_record.asset_kind
    or asset_record.schema_version <> 'v1'
    or asset_record.content is distinct from expected_asset_content then
    raise exception 'idempotency-conflict: Asset % for Asset Job % has incompatible immutable identity.', asset_record.id, p_asset_job_id;
  end if;

  for file_record in
    select *
    from jsonb_to_recordset(p_files) as proposed_file(
      position integer,
      storage_bucket text,
      storage_path text,
      public_url text,
      mime_type text,
      file_size_bytes integer,
      width integer,
      height integer,
      duration_ms integer,
      checksum_sha256 text
    )
    order by proposed_file.position
  loop
    select *
      into existing_file_record
    from asset_files
    where asset_id = asset_record.id
      and position = file_record.position
    for update;

    if found then
      if existing_file_record.storage_bucket <> file_record.storage_bucket
        or existing_file_record.storage_path <> file_record.storage_path
        or existing_file_record.public_url is distinct from file_record.public_url
        or existing_file_record.mime_type <> file_record.mime_type
        or existing_file_record.file_size_bytes <> file_record.file_size_bytes
        or existing_file_record.width is distinct from file_record.width
        or existing_file_record.height is distinct from file_record.height
        or existing_file_record.duration_ms is distinct from file_record.duration_ms
        or existing_file_record.checksum_sha256 is distinct from file_record.checksum_sha256 then
        raise exception 'idempotency-conflict: Asset File at position % for Asset % has incompatible immutable identity.', file_record.position, asset_record.id;
      end if;
    else
      insert into asset_files (
        asset_id,
        position,
        storage_bucket,
        storage_path,
        public_url,
        mime_type,
        file_size_bytes,
        width,
        height,
        duration_ms,
        checksum_sha256
      )
      values (
        asset_record.id,
        file_record.position,
        file_record.storage_bucket,
        file_record.storage_path,
        file_record.public_url,
        file_record.mime_type,
        file_record.file_size_bytes,
        file_record.width,
        file_record.height,
        file_record.duration_ms,
        file_record.checksum_sha256
      );
    end if;
  end loop;

  update asset_jobs
  set
    status = 'completed',
    result = p_result,
    last_error = null,
    completed_at = now(),
    failed_at = null,
    updated_at = now()
  where id = p_asset_job_id
    and status = 'running'
  returning * into job_record;

  if not found then
    raise exception 'Asset Job % could not be completed for file materialization.', p_asset_job_id;
  end if;

  return query
  select
    to_jsonb(job_record),
    to_jsonb(asset_record),
    coalesce(jsonb_agg(to_jsonb(asset_files.*) order by asset_files.position), '[]'::jsonb)
  from asset_files
  where asset_files.asset_id = asset_record.id;
end;
$$;

revoke execute on function public.complete_asset_job_with_files(uuid, jsonb, jsonb) from public;
grant execute on function public.complete_asset_job_with_files(uuid, jsonb, jsonb) to authenticated;

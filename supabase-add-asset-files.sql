-- Asset File Foundation: literal storage pointers for a durable Asset, 1..N ordered rows per
-- Asset (1 for single-file kinds such as image; N for multi-file kinds such as carousel, not
-- built yet -- asset_kind is restricted to "image" at the TypeScript layer in this milestone).
-- Safe to run more than once in the Supabase SQL editor.
--
-- Deliberately no Supabase Storage bucket, no storage.objects policy, and no real upload code in
-- this migration -- Storage integration is a later, separate milestone. This table's
-- storage_bucket/storage_path/public_url columns exist now so the full Asset Generation schema
-- is provably complete end to end; the mock worker populates them with clearly-labeled
-- placeholder values ("mock" bucket, never a real bucket) to prove the write path, exactly
-- mirroring how the Creative Job mock executor prefixes its output "MOCK ONLY" rather than
-- omitting the fields a real worker will eventually populate.
--
-- No status/lifecycle column here -- asset_files rows are immutable, append-only children of
-- their Asset, the same way creative_job_attempts rows are immutable children of their Creative
-- Job. Nothing in this milestone or any planned later one updates a asset_files row after insert.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. A guarded preflight block verifies that the live asset_files table,
-- foreign key, and index have the approved shape. If an older draft table exists with an
-- incompatible shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists asset_files (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets(id) on delete cascade,
  position integer not null default 0,
  storage_bucket text not null,
  storage_path text not null,
  public_url text not null,
  mime_type text not null,
  file_size_bytes integer not null,
  width integer,
  height integer,
  duration_ms integer,
  checksum_sha256 text,
  created_at timestamptz not null default now()
);

do $$
declare
  required_column record;
  disallowed_column text;
  actual_type text;
  actual_not_null boolean;
begin
  for required_column in
    select *
    from (values
      ('id', 'uuid', true),
      ('asset_id', 'uuid', true),
      ('position', 'integer', true),
      ('storage_bucket', 'text', true),
      ('storage_path', 'text', true),
      ('public_url', 'text', true),
      ('mime_type', 'text', true),
      ('file_size_bytes', 'integer', true),
      ('width', 'integer', false),
      ('height', 'integer', false),
      ('duration_ms', 'integer', false),
      ('checksum_sha256', 'text', false),
      ('created_at', 'timestamp with time zone', true)
    ) as expected(column_name, data_type, is_required)
  loop
    actual_type := null;
    actual_not_null := null;

    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_files'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'asset_files table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'asset_files column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'asset_files column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select *
    from (values
      ('status'),
      ('provider'),
      ('model'),
      ('approved_at'),
      ('rejected_at')
    ) as excluded(column_name)
  loop
    if exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'asset_files'
        and attribute.attname = disallowed_column
        and not attribute.attisdropped
    ) then
      raise exception 'asset_files table has disallowed column %; a file record has no lifecycle of its own -- reconcile the stale draft table before continuing.', disallowed_column;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_files'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'asset_files table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_files'
      and constraint_record.contype = 'f'
      and attribute.attname = 'asset_id'
      and constraint_record.confrelid = 'public.assets'::regclass
      and constraint_record.confdeltype = 'c'
  ) then
    raise exception 'asset_files table is missing required asset_id foreign key to assets(id) with on delete cascade; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists asset_files_asset_id_position_idx
  on asset_files (asset_id, position);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'asset_files_asset_id_position_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(asset_id, position\)' then
    raise exception 'asset_files_asset_id_position_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table asset_files enable row level security;

grant select, insert, update, delete on table asset_files to authenticated;

drop policy if exists "Authenticated users can manage asset files" on asset_files;

create policy "Authenticated users can manage asset files"
  on asset_files for all
  to authenticated
  using (true)
  with check (true);

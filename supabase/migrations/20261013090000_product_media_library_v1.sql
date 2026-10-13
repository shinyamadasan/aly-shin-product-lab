-- Raw product source media, separate from completed generation-job Assets.
-- LOCAL/TEST FIRST. Do not db push: production migration history has known drift.
-- Requires the existing products table and is_product_lab_owner() claim reader.
-- Co-owners share this business library; created_by is audit, not a tenant boundary.
-- Rollback: disable the Media entry point and retain this table/bucket/data. No destructive
-- rollback is supplied; dropping the library requires a separately reviewed data export.
begin;

do $$
begin
  if to_regclass('public.products') is null
     or to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Apply the products schema and owner authorization first.';
  end if;
  if to_regclass('public.product_media') is not null
     or exists (select 1 from storage.buckets where id = 'product-media') then
    raise exception 'Product media already exists; inspect migration history before applying.';
  end if;
end $$;

create table public.product_media (
  id uuid primary key,
  product_id text references public.products(id) on delete set null,
  media_type text not null check (media_type in ('photo', 'video')),
  storage_bucket text not null default 'product-media' check (storage_bucket = 'product-media'),
  storage_path text not null unique,
  original_filename text not null check (length(original_filename) between 1 and 255),
  mime_type text not null,
  file_size_bytes bigint not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  duration_ms integer,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  constraint product_media_format check (
    (media_type = 'photo' and mime_type in ('image/jpeg', 'image/png', 'image/webp')
      and duration_ms is null and file_size_bytes between 1 and 10485760)
    or (media_type = 'video' and mime_type = 'video/mp4'
      and duration_ms is not null and duration_ms > 0 and file_size_bytes between 1 and 52428800)
  ),
  constraint product_media_path check (storage_path = id::text || case mime_type
    when 'image/jpeg' then '.jpg' when 'image/png' then '.png'
    when 'image/webp' then '.webp' when 'video/mp4' then '.mp4' end)
);

create index product_media_product_created_idx on public.product_media (product_id, created_at desc, id desc);
alter table public.product_media enable row level security;
revoke all on public.product_media from public, anon, authenticated;
grant select, insert on public.product_media to authenticated;
grant update (product_id) on public.product_media to authenticated;
create policy "Owners read product media" on public.product_media for select to authenticated
  using (public.is_product_lab_owner());
create policy "Owners add product media" on public.product_media for insert to authenticated
  with check (public.is_product_lab_owner() and created_by = auth.uid());
create policy "Owners assign product media" on public.product_media for update to authenticated
  using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-media', 'product-media', false, 52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
create policy "Owners preview product media" on storage.objects for select to authenticated
  using (bucket_id = 'product-media' and public.is_product_lab_owner());
create policy "Owners upload product media" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-media' and public.is_product_lab_owner()
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$');
-- No update/delete grants or policies. An ambiguous registration failure retains its private
-- object for recovery, rather than risking removal of a successfully registered upload.
-- Storage enforces MIME/size. The shared byte inspector verifies image/container/H.264 facts
-- in the upload path; this migration does not claim server-side codec decoding.
commit;

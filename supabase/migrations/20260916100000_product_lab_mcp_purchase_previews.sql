-- Product Lab MCP -- Daily Bakery Ops V2, Slice 1 Purchases: durable, owner-scoped storage for
-- purchase preview artifacts.
--
-- WHY A SIBLING TABLE, NOT A REUSE OF public.product_lab_mcp_previews.
--
-- product_lab_mcp_previews (migration 20260914120000) is V1A physical-count-specific: its
-- preview_id column is CHECK-constrained to '^pc_[a-f0-9]{20}$' and its own comments describe the
-- stored JSON as "the opaque CountPreview object produced by ... buildCountPreview()". A purchase
-- preview is a structurally different payload (purchase lines, not counted-ingredient lines) and
-- must never be mistaken for, or collide identity-wise with, a physical count. This migration adds
-- an exact structural sibling -- same owner-scoped RLS shape, same composite primary key rationale,
-- same 24-hour retention default -- scoped to its own 'pu_' preview_id prefix and its own table, so
-- neither preview kind's identity space, RLS policies, or retention behavior can ever interact.
--
-- WHAT THIS DOES NOT CHANGE.
--
-- This migration adds exactly one new table and its RLS policies. It does not touch
-- inventory_private.post_raw_purchase, inventory_private.confirm_purchase_import_v2,
-- is_product_lab_owner(), purchase_imports, purchase_import_rows, or product_lab_mcp_previews. No
-- new RPC is introduced anywhere. The apply bridge (scripts/product-lab/purchase-service.ts) writes
-- to purchase_imports/purchase_import_rows directly under their EXISTING owner-only RLS policies
-- (see supabase-harden-product-lab-owner-data-rls.sql's TIER 1 "owner_only" list, which already
-- includes both tables) and then calls the existing, unmodified confirm_purchase_import_v2 RPC --
-- this table only persists and retrieves the opaque preview JSON itself.
--
-- WHY NO purchase_import_id COLUMN.
--
-- Unlike a naive draft-reuse design, the apply bridge never needs to remember a created
-- purchase_imports row's id anywhere. Both that row's id and its purchase_import_rows' ids are
-- DERIVED, not generated -- deterministicUuid(namespace, preview_id/row index) in
-- scripts/purchase-operator/core.ts always recomputes the exact same id from the exact same
-- (immutable, already-approved) preview content. A lost response or a retried apply call
-- recomputes the identical ids and upserts with ignoreDuplicates, then calls
-- confirm_purchase_import_v2 with the same operation_id -- which resolves through that RPC's own
-- claim_mutation idempotency to the same stored result. No mutable "which import did this preview
-- become" pointer needs to be persisted anywhere for that to work.
--
-- WHY OWNER-SCOPED BY ROW, THE COMPOSITE PRIMARY KEY, AND RETENTION.
--
-- Identical reasoning to 20260914120000_product_lab_mcp_durable_previews.sql: preview_id is
-- content-derived (two owner accounts previewing byte-identical purchases would otherwise collide
-- on a global primary key), is_product_lab_owner() alone is a role check shared by every owner
-- account so row-level owner_id scoping is required on top of it, and a 24-hour expires_at default
-- bounds the table without yet adding a background sweep (a documented gap, not a silent one).
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Product Lab MCP purchase previews requires public.is_product_lab_owner() (apply supabase-harden-product-lab-owner-data-rls.sql first)';
  end if;
  if to_regclass('public.purchase_imports') is null or to_regclass('public.purchase_import_rows') is null then
    raise exception 'Product Lab MCP purchase previews requires purchase_imports/purchase_import_rows (apply supabase-add-inventory.sql and supabase-add-purchase-import-packages.sql first)';
  end if;
  if to_regprocedure('inventory_private.confirm_purchase_import_v2(uuid,uuid)') is null then
    raise exception 'Product Lab MCP purchase previews requires inventory_private.confirm_purchase_import_v2 (apply 20260910022601_selling_wave_0b_safe_mutations.sql first)';
  end if;
  if to_regclass('public.product_lab_mcp_purchase_previews') is not null then
    raise exception 'public.product_lab_mcp_purchase_previews already exists; this migration must not run twice';
  end if;
end;
$$;

create table public.product_lab_mcp_purchase_previews (
  preview_id text not null check (preview_id ~ '^pu_[a-f0-9]{20}$'),
  owner_id uuid not null default auth.uid() references auth.users (id),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid not null,
  preview jsonb not null,
  apply_result jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (owner_id, preview_id)
);

comment on table public.product_lab_mcp_purchase_previews is
  'Durable, owner-scoped storage for Product Lab MCP purchase preview artifacts (Daily Bakery Ops V2, Slice 1). Written only by PurchaseService; no MCP tool exposes a generic write to this table. Sibling of public.product_lab_mcp_previews, scoped to its own pu_ prefix -- see the migration header for why it is not a reuse of that table.';
comment on column public.product_lab_mcp_purchase_previews.owner_id is
  'auth.uid() of the Supabase session that created the preview. Enforces per-account isolation on top of the is_product_lab_owner() role check, and jointly with preview_id is this table''s uniqueness key.';
comment on column public.product_lab_mcp_purchase_previews.preview is
  'The opaque PurchasePreview object produced by scripts/purchase-operator/core.ts buildPurchasePreview(). Not written to, or parsed structurally by, this migration.';

create index product_lab_mcp_purchase_previews_preview_id_idx on public.product_lab_mcp_purchase_previews (preview_id);
create index product_lab_mcp_purchase_previews_expires_at_idx on public.product_lab_mcp_purchase_previews (expires_at);

alter table public.product_lab_mcp_purchase_previews enable row level security;
alter table public.product_lab_mcp_purchase_previews force row level security;

create policy "Owner reads own purchase previews" on public.product_lab_mcp_purchase_previews
  for select to authenticated
  using (public.is_product_lab_owner() and owner_id = auth.uid());

create policy "Owner inserts own purchase previews" on public.product_lab_mcp_purchase_previews
  for insert to authenticated
  with check (public.is_product_lab_owner() and owner_id = auth.uid());

create policy "Owner updates own purchase previews" on public.product_lab_mcp_purchase_previews
  for update to authenticated
  using (public.is_product_lab_owner() and owner_id = auth.uid())
  with check (public.is_product_lab_owner() and owner_id = auth.uid());

revoke all on public.product_lab_mcp_purchase_previews from public, anon;
grant select, insert, update on public.product_lab_mcp_purchase_previews to authenticated;

notify pgrst, 'reload schema';

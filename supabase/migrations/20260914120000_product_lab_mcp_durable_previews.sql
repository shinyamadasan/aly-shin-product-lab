-- Product Lab MCP Slice 2.1A: durable, owner-scoped storage for physical-count preview artifacts.
--
-- WHY THIS EXISTS.
--
-- The local stdio MCP path stores preview artifacts as JSON files under .inventory-operator/previews
-- (scripts/product-lab/inventory-count-service.ts, createInventoryCountArtifactStore). A local
-- filesystem cannot be the artifact authority for a remote MCP endpoint running on Vercel: a
-- serverless invocation has no durable local disk, and even where a disk exists it is not shared
-- across invocations or regions. Preview -> Apply -> Verify must read back the SAME artifact a later,
-- possibly different, serverless invocation wrote.
--
-- WHAT THIS DOES NOT CHANGE.
--
-- This migration adds exactly one new table and its RLS policies. It does not touch
-- apply_inventory_physical_count_batch, inventory_private.apply_raw_inventory_adjustment,
-- is_product_lab_owner(), or any existing inventory/ledger table. The preview artifact stored here is
-- opaque JSON produced by the existing V1A matcher/hasher (buildCountPreview in
-- scripts/inventory-operator/core.ts); this table only persists and retrieves it. No new RPC calls
-- into the inventory authority are introduced.
--
-- WHY OWNER-SCOPED BY ROW, NOT JUST BY ROLE.
--
-- is_product_lab_owner() is a ROLE check: every account holding app_role = 'owner' passes it
-- identically (see supabase-harden-creative-production-rls.sql). A preview artifact is scoped
-- narrower than that: it is tied to the Supabase auth.uid() that created it, so one owner account's
-- in-progress physical count is never readable, appliable, or verifiable by a different owner
-- account's session. Both checks are required on every policy: the role check keeps non-owners out
-- entirely, and the owner_id match keeps owners out of each other's previews.
--
-- WHY THE PRIMARY KEY IS (owner_id, preview_id), NOT preview_id ALONE.
--
-- preview_id is content-derived (V1A hashes the normalized payload; see buildCountPreview in
-- scripts/inventory-operator/core.ts) -- it is NOT random. Two different, legitimate owner accounts
-- counting the exact same items with the exact same source metadata therefore derive the SAME
-- preview_id. A global `primary key (preview_id)` would make the second owner's otherwise-valid
-- preview fail to save with a duplicate-key error -- a real availability bug, even though RLS was
-- never at risk of leaking or overwriting the first owner's row (RLS would have refused the read
-- either way). Scoping uniqueness to (owner_id, preview_id) fixes the collision while leaving every
-- externally-visible identifier -- preview_id itself, payload_hash, operation_id, approval_code --
-- completely unchanged; MCP tool inputs/outputs never mention owner_id at all. `owner_id` keeps its
-- database-owned `default auth.uid()` (no application code, and no MCP caller, ever supplies it), so
-- a caller cannot spoof another owner's rows into existence under this key either.
--
-- WHY NO GENERIC WRITE SURFACE.
--
-- This table is written only by InventoryCountService (preview/apply/verify) via structured
-- PostgREST calls with a fixed column set -- never by an MCP tool argument, and never via raw SQL or
-- an RPC that accepts arbitrary JSON as a write target. The `preview`/`apply_result` jsonb columns
-- hold the shape V1A already produces internally; MCP callers cannot supply arbitrary JSON into them
-- because no MCP tool input schema maps onto this table at all (see docs/PRODUCT_LAB_MCP.md).
--
-- RETENTION.
--
-- expires_at defaults to 24 hours after creation -- long enough to cover "preview now, get owner
-- approval, apply shortly after" without becoming a growing, unbounded table. Expiry is enforced by
-- the application (an expired row still reads back but the shared V1A stale-quantity/approval-code
-- checks reject applying against outdated inventory state; the durable store's own read() additionally
-- refuses a preview past expires_at). No cron/background sweep exists in this slice; a future slice
-- may add a scheduled delete of expired rows. This is a documented gap, not a silent one.
--
-- Rollback: drop the table (drop table if exists public.product_lab_mcp_previews). Nothing else in
-- the schema references it, and no existing inventory/ledger row is ever written to or read from it,
-- so rollback cannot lose or corrupt authoritative inventory history.
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Product Lab MCP durable previews requires public.is_product_lab_owner() (apply supabase-harden-creative-production-rls.sql first)';
  end if;
  if to_regclass('public.product_lab_mcp_previews') is not null then
    raise exception 'public.product_lab_mcp_previews already exists; this migration must not run twice';
  end if;
end;
$$;

create table public.product_lab_mcp_previews (
  preview_id text not null check (preview_id ~ '^pc_[a-f0-9]{20}$'),
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

comment on table public.product_lab_mcp_previews is
  'Durable, owner-scoped storage for Product Lab MCP physical-count preview artifacts (Slice 2.1A). Written only by InventoryCountService; no MCP tool exposes a generic write to this table. Primary key is (owner_id, preview_id) -- see the migration header for why preview_id alone cannot be globally unique.';
comment on column public.product_lab_mcp_previews.owner_id is
  'auth.uid() of the Supabase session that created the preview. Enforces per-account isolation on top of the is_product_lab_owner() role check -- one owner account can never read or apply another owner account''s preview -- and, jointly with preview_id, is this table''s uniqueness key.';
comment on column public.product_lab_mcp_previews.preview is
  'The opaque CountPreview object produced by scripts/inventory-operator/core.ts buildCountPreview(). Not written to, or parsed structurally by, this migration.';

-- Application code queries only by preview_id (`.eq("preview_id", ...)`); RLS -- not an explicit
-- owner_id predicate in the query -- is what narrows the result to at most the caller's own row. The
-- composite primary key's own index is (owner_id, preview_id), which cannot serve a preview_id-only
-- lookup efficiently (leftmost-prefix rule), hence this second, single-column index.
create index product_lab_mcp_previews_preview_id_idx on public.product_lab_mcp_previews (preview_id);
create index product_lab_mcp_previews_expires_at_idx on public.product_lab_mcp_previews (expires_at);

alter table public.product_lab_mcp_previews enable row level security;
alter table public.product_lab_mcp_previews force row level security;

create policy "Owner reads own previews" on public.product_lab_mcp_previews
  for select to authenticated
  using (public.is_product_lab_owner() and owner_id = auth.uid());

create policy "Owner inserts own previews" on public.product_lab_mcp_previews
  for insert to authenticated
  with check (public.is_product_lab_owner() and owner_id = auth.uid());

create policy "Owner updates own previews" on public.product_lab_mcp_previews
  for update to authenticated
  using (public.is_product_lab_owner() and owner_id = auth.uid())
  with check (public.is_product_lab_owner() and owner_id = auth.uid());

revoke all on public.product_lab_mcp_previews from public, anon;
grant select, insert, update on public.product_lab_mcp_previews to authenticated;

notify pgrst, 'reload schema';

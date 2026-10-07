-- Product Lab MCP -- Purchases V3: durable, owner-scoped storage for purchase preview artifacts.
--
-- WHY THIS EXISTS.
--
-- The remote MCP endpoint (Cloudflare Worker and the Next.js route) is stateless: a purchase
-- preview -> owner approval -> apply -> verify flow must read back, in a LATER request, the exact
-- artifact an earlier request wrote, with nothing re-supplied by the client. This is the purchase
-- sibling of public.product_lab_mcp_previews (20260914120000, physical counts). It is a separate
-- table, not a reuse of that one, because that table's preview_id is CHECK-constrained to the
-- '^pc_' physical-count prefix and a purchase artifact must never be mistaken for, or share an
-- identity space with, a count.
--
-- WHAT THIS DOES NOT CHANGE.
--
-- It adds one table, one trigger function on that table, and the table's RLS. It does not touch
-- public.post_raw_purchase, inventory_private.post_raw_purchase, inventory_private.claim_mutation,
-- public.delete_posted_purchase_if_reversible, is_product_lab_owner(), or any purchase/inventory
-- row. It adds no RPC and no batch mutation. It does not depend on Cost System Simplification V4 or
-- Safe Purchase Delete being applied: the purchase RPC behavior is whatever the database already has.
--
-- THE MUTATION AUTHORITY IS NOT HERE.
--
-- A purchase is posted one line at a time through public.post_raw_purchase, each line idempotent
-- through its own operation id (derived from occasion_id + line number; see
-- scripts/purchase-operator/core.ts purchaseLineOperationId) and the existing claim_mutation
-- receipt. This table only persists the approved preview and the progress of applying it.
-- occasion_id is stored for audit and querying ONLY. It is deliberately NOT unique and is not a
-- lock: duplicate-posting protection belongs to claim_mutation, not to this table.
--
-- OWNER-SCOPED BY ROW, AND THE KEY (owner_id, preview_id).
--
-- Same reasoning as 20260914120000: is_product_lab_owner() is a role check shared by every owner
-- account, so row-level owner_id scoping is needed on top of it; and preview_id is content-derived,
-- so two owner accounts previewing the same purchase derive the same preview_id and a global
-- primary key would make the second owner's save fail. owner_id is database-owned (default
-- auth.uid()) and is never supplied by application code.
--
-- PRESERVING APPLY STATE.
--
-- preview_id is stable for a purchase's contents (it does not change when stock moves), so a later
-- save of the same preview_id is expected. A BEFORE UPDATE trigger makes it impossible for such a
-- save to ACCIDENTALLY destroy what an apply recorded: apply_result and verified_at, once set,
-- cannot be nulled; the artifact's identity columns can never change; and once an apply_result
-- exists the stored preview (the thing that was approved and applied) becomes immutable. Replacing
-- apply_result with a newer non-null value (progress across a retry) and advancing verified_at are
-- allowed. A refresh of an EXPIRED, never-applied artifact (new preview payload, new created_at and
-- expires_at) is allowed. These are guards against mistakes; they are not the safety authority.
--
-- LIFETIME.
--
-- expires_at defaults to 24 hours after creation, and a CHECK keeps it within
-- (created_at, created_at + 24 hours] so the approval window cannot be silently stretched. Expiry
-- is enforced by the service on read; no background sweep exists in this slice (a documented gap,
-- as for the sibling table).
--
-- NOT APPLIED. Verified only against disposable Postgres. Do not run `supabase db push`.
--
-- Rollback: drop table if exists public.product_lab_mcp_purchase_previews;
--           drop function if exists public.product_lab_mcp_purchase_previews_guard();
-- Nothing else references either, and no inventory, purchase, or ledger row is ever read from or
-- written to this table, so rollback cannot lose or corrupt authoritative history.
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Product Lab MCP purchase previews requires public.is_product_lab_owner() (apply supabase-harden-creative-production-rls.sql first)';
  end if;
  if to_regprocedure('public.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)') is null then
    raise exception 'Product Lab MCP purchase previews requires public.post_raw_purchase (apply 20260910022601_selling_wave_0b_safe_mutations.sql first)';
  end if;
  if to_regclass('public.product_lab_mcp_purchase_previews') is not null then
    raise exception 'public.product_lab_mcp_purchase_previews already exists; this migration must not run twice';
  end if;
end;
$$;

create table public.product_lab_mcp_purchase_previews (
  preview_id text not null,
  owner_id uuid not null default auth.uid() references auth.users (id),
  occasion_id text not null,
  payload_hash text not null,
  preview jsonb not null,
  apply_result jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (owner_id, preview_id),
  constraint product_lab_mcp_purchase_previews_preview_id_format
    check (preview_id ~ '^pu_[a-f0-9]{20}$'),
  constraint product_lab_mcp_purchase_previews_payload_hash_format
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- preview_id is 'pu_' + the first 20 hex characters of the payload hash (core.ts).
  constraint product_lab_mcp_purchase_previews_id_matches_hash
    check (substr(payload_hash, 1, 20) = substr(preview_id, 4)),
  -- The normalized occasion id: no leading/trailing whitespace, not blank (core.ts trims it).
  constraint product_lab_mcp_purchase_previews_occasion_id_format
    check (occasion_id ~ '^\S([\s\S]*\S)?$'),
  -- The artifact must describe the row it is stored under. `is not distinct from` so a missing key
  -- is a violation rather than a NULL that silently passes.
  constraint product_lab_mcp_purchase_previews_artifact_matches_columns
    check (
      jsonb_typeof(preview) = 'object'
      and (preview ->> 'kind') is not distinct from 'purchase_preview'
      and (preview ->> 'preview_id') is not distinct from preview_id
      and (preview ->> 'occasion_id') is not distinct from occasion_id
      and (preview ->> 'payload_hash') is not distinct from payload_hash
    ),
  constraint product_lab_mcp_purchase_previews_apply_result_object
    check (apply_result is null or jsonb_typeof(apply_result) = 'object'),
  constraint product_lab_mcp_purchase_previews_expiry_window
    check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);

comment on table public.product_lab_mcp_purchase_previews is
  'Durable, owner-scoped storage for Product Lab MCP purchase preview artifacts (Purchases V3). Written only by the purchase service; no MCP tool exposes a generic write to it. Primary key (owner_id, preview_id). occasion_id is audit/query metadata and is NOT unique: duplicate-posting protection is public.post_raw_purchase''s claim_mutation receipt, keyed by occasion_id + line number.';
comment on column public.product_lab_mcp_purchase_previews.owner_id is
  'auth.uid() of the Supabase session that created the preview (database-owned default). Per-account isolation on top of the is_product_lab_owner() role check.';
comment on column public.product_lab_mcp_purchase_previews.occasion_id is
  'The caller-chosen purchase occasion, normalized (trimmed). Audit and query metadata only; not unique and not a lock.';
comment on column public.product_lab_mcp_purchase_previews.preview is
  'The complete PurchasePreview produced by scripts/purchase-operator/core.ts buildPurchasePreview(): everything apply needs, so the client never re-supplies purchase contents. Immutable once apply_result is set.';
comment on column public.product_lab_mcp_purchase_previews.apply_result is
  'Per-line apply progress/outcome (applied / replayed / failed / not_attempted lines). A multi-line purchase is NOT atomic, so this may record a partial application. Once set it cannot be nulled.';
comment on column public.product_lab_mcp_purchase_previews.verified_at is
  'When purchase_verify last succeeded. Once set it cannot be nulled.';

-- Application code looks a preview up by preview_id alone (RLS narrows it to the caller's own row);
-- the composite primary key's index cannot serve that efficiently (leftmost-prefix rule).
create index product_lab_mcp_purchase_previews_preview_id_idx on public.product_lab_mcp_purchase_previews (preview_id);
create index product_lab_mcp_purchase_previews_expires_at_idx on public.product_lab_mcp_purchase_previews (expires_at);
-- Audit/query by occasion. Deliberately NOT unique.
create index product_lab_mcp_purchase_previews_owner_occasion_idx on public.product_lab_mcp_purchase_previews (owner_id, occasion_id);

create function public.product_lab_mcp_purchase_previews_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
     or new.preview_id is distinct from old.preview_id
     or new.occasion_id is distinct from old.occasion_id
     or new.payload_hash is distinct from old.payload_hash then
    raise exception 'A purchase preview artifact''s identity cannot be changed' using errcode = '23514';
  end if;
  if old.apply_result is not null and new.apply_result is null then
    raise exception 'A purchase preview''s apply_result cannot be erased once recorded' using errcode = '23514';
  end if;
  if old.verified_at is not null and new.verified_at is null then
    raise exception 'A purchase preview''s verified_at cannot be cleared once recorded' using errcode = '23514';
  end if;
  if old.apply_result is not null and new.preview is distinct from old.preview then
    raise exception 'An applied purchase preview cannot be modified' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.product_lab_mcp_purchase_previews_guard() from public, anon, authenticated;

create trigger product_lab_mcp_purchase_previews_guard
  before update on public.product_lab_mcp_purchase_previews
  for each row execute function public.product_lab_mcp_purchase_previews_guard();

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

-- No delete policy and no delete grant: nothing in the workflow removes an artifact.
revoke all on public.product_lab_mcp_purchase_previews from public, anon;
grant select, insert, update on public.product_lab_mcp_purchase_previews to authenticated;

notify pgrst, 'reload schema';

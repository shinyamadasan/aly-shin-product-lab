-- Order payment incident events: an append-only, owner-readable record of payment facts that were reversed by a
-- reviewed maintenance recovery rather than through the normal audited function.
--
-- WHY. order_refund_corrections holds ONE row per order (a deliberate limit of correct_mistaken_refund), so when
-- an order was mistakenly refunded a SECOND time, the audited function correctly refuses it. That second incident
-- still needs an immutable record of what was erased, when, why and who acted. This table is that record. It does
-- not change any behaviour: nothing reads it, no trigger or function is altered, and no existing object is touched.
--
-- WHO WRITES IT. Only a reviewed, guarded recovery transaction run from a maintenance session (no client role has
-- any write privilege; service_role writes are revoked; update/delete/truncate are blocked for everyone).
-- See scripts/sql/recover-qa-refund-60b69833.sql.
--
-- PRODUCTION STATUS: already applied and recorded as version 20261020120000. Do not re-apply.
-- The authorized recovery is complete. See docs/REFUND_CORRECTION_RUNBOOK.md and the read-only check script.
--
-- ROLLBACK (this file only adds objects). Run the indented block as ONE script INCLUDING its begin/commit: the
-- guard aborts the whole transaction, before anything is dropped, if the table has ever held an event (the rows
-- are the only record of the incident: export them and get explicit review first, per AGENTS.md's Recovery Rules).
--   begin;
--   do $rollback$ begin
--     if exists (select 1 from public.order_payment_incident_events) then
--       raise exception 'order_payment_incident_events is not empty: export it and get explicit review before rolling back';
--     end if;
--   end $rollback$;
--   drop table public.order_payment_incident_events;
--   drop function inventory_private.protect_order_payment_incident_events();
--   commit;
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Incident events require public.is_product_lab_owner()';
  end if;
  if to_regclass('public.orders') is null or to_regclass('public.order_refund_corrections') is null then
    raise exception 'Incident events require public.orders and public.order_refund_corrections (migration 20261019120000)';
  end if;
  if to_regclass('public.order_payment_incident_events') is not null then
    raise exception 'Incident events already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

create table public.order_payment_incident_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  event_type text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  -- Who acted, as plain text (a maintenance session carries no JWT identity) and on whose authority.
  recorded_by text not null,
  authorized_by text not null,
  reason text not null,
  -- The erroneous refund exactly as it stood before it was reversed.
  incident_refunded_at timestamptz not null,
  order_status text not null,
  payment_status_before text not null,
  payment_method_before text,
  paid_at_before timestamptz not null,
  paid_amount_before numeric not null,
  order_updated_at_before timestamptz not null,
  -- The earlier audited correction of the same order, when there is one (one per order, ever).
  prior_correction_id uuid references public.order_refund_corrections(id) on delete restrict,

  constraint order_payment_incident_events_type check (event_type in ('second_refund_reversed')),
  constraint order_payment_incident_events_was_refunded check (payment_status_before = 'refunded'),
  constraint order_payment_incident_events_actor check (length(btrim(recorded_by, E' \t\r\n')) between 10 and 300 and length(btrim(authorized_by, E' \t\r\n')) between 10 and 300),
  constraint order_payment_incident_events_reason check (length(btrim(reason, E' \t\r\n')) between 10 and 600),
  -- The same incident can be recorded once.
  constraint order_payment_incident_events_once unique (order_id, event_type, incident_refunded_at)
);

comment on table public.order_payment_incident_events is
  'Append-only record of payment facts reversed by a reviewed maintenance recovery (not by correct_mistaken_refund): what was erased, why, who acted and who authorized it. Owner-only.';

create or replace function inventory_private.protect_order_payment_incident_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The payment incident history is append-only.' using errcode = '42501';
end;
$$;
revoke all on function inventory_private.protect_order_payment_incident_events() from public, anon, authenticated;

create trigger order_payment_incident_events_protect_history
  before update or delete on public.order_payment_incident_events
  for each row execute function inventory_private.protect_order_payment_incident_events();
create trigger order_payment_incident_events_protect_truncate
  before truncate on public.order_payment_incident_events
  for each statement execute function inventory_private.protect_order_payment_incident_events();

alter table public.order_payment_incident_events enable row level security;
revoke all on public.order_payment_incident_events from public, anon, authenticated;
revoke insert, update, delete, truncate, trigger, references on public.order_payment_incident_events from service_role;
grant select on public.order_payment_incident_events to authenticated;
create policy "owner reads order payment incident events" on public.order_payment_incident_events
  for select to authenticated using (public.is_product_lab_owner());

notify pgrst, 'reload schema';

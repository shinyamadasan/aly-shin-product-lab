-- READ ONLY. Verify deployed recovery state; never run the recovery or migrations again.
begin transaction read only;
select (select jsonb_agg(to_jsonb(m) order by version) from
         (select version, name from supabase_migrations.schema_migrations
          where version in ('20261016120000','20261019120000','20261020120000')) m) as migration_history,
       (select jsonb_agg(to_jsonb(q) order by order_prefix) from
         (select left(o.id::text,8) as order_prefix, o.status, o.payment_status, o.paid_amount,
                 o.refunded_at, c.raw_production_cogs
            from public.orders o left join public.order_raw_cogs c on c.order_id=o.id
           where left(o.id::text,8) in ('60b69833','21244d4e','b10149a5')) q) as recovered_orders,
       (select count(*) from public.order_refund_corrections) as correction_count,
       (select count(*) from public.order_payment_incident_events) as incident_count,
       has_table_privilege('authenticated','public.order_payment_incident_events','INSERT') as client_can_insert,
       has_table_privilege('service_role','public.order_payment_incident_events','INSERT') as service_can_insert,
       to_regclass('public.business_expenses') is null as expense_ledger_not_applied;
commit;

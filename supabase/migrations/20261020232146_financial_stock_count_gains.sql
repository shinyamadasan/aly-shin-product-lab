-- Reporting-only hotfix. Apply only after separate approval; no historical row is updated.
-- Preserve all nine view columns, RLS, grants, snapshots, review precedence and reversal joins.
-- Recovery: restore the previous view definition from the FR2 attribution migration, without
-- reapplying that migration or changing any table/function/audit record. Old apps fail closed
-- on the new classification (unclassified); deploy the compatible app before this view change.
-- A positive delta alone is insufficient: require the original structured physical-count evidence.

create or replace view public.stock_financial_events with (security_invoker = true) as
with events as (
  select 'raw:' || t.id::text as id, t.created_at as occurred_at, 'raw'::text as source_kind,
    t.id as source_id, coalesce(original.id,t.id) as origin_id,
    case when t.transaction_type = 'adjustment' and t.source_id is null
      and t.reason = 'stock_count_correction'
      and (t.financial_classification is null or t.financial_classification = 'unclassified')
      and t.financial_unit_cost_snapshot is null
      and t.quantity_change > 0 and t.quantity_before >= 0 and t.quantity_after > t.quantity_before
      and t.quantity_change::text not in ('NaN','Infinity','-Infinity')
      and t.quantity_before::text not in ('NaN','Infinity','-Infinity')
      and t.quantity_after::text not in ('NaN','Infinity','-Infinity')
      and t.quantity_after - t.quantity_before = t.quantity_change
      and jsonb_typeof(t.reconciliation_snapshot) = 'object'
      and t.reconciliation_snapshot @> jsonb_build_object(
        'cache_quantity',t.quantity_before,'verified_quantity',t.quantity_after)
      and jsonb_typeof(t.reconciliation_snapshot->'base_unit') = 'string'
      and length(trim(t.reconciliation_snapshot->>'base_unit')) > 0
      then 'stock_count_gain' else t.financial_classification end as classification, -t.quantity_change as quantity,
    case when t.financial_unit_cost_snapshot is not null then -t.quantity_change * t.financial_unit_cost_snapshot end as amount,
    false as estimated
  from public.inventory_transactions t
  left join public.inventory_transactions original on original.id::text = t.source_id
    and original.ingredient_id = t.ingredient_id and original.transaction_type = 'adjustment'
  where t.transaction_type in ('adjustment','waste') and t.source_type = 'manual' and t.quantity_change <> 0
  union all
  select 'finished:' || m.id::text, m.created_at, 'finished', m.id, coalesce(m.reverses_movement_id,m.id),
    m.financial_classification, -m.on_hand_delta::numeric,
    case when pe.frozen_cost_per_piece > 0 and pe.frozen_cost_per_piece::text not in ('NaN','Infinity','-Infinity')
      then -m.on_hand_delta * pe.frozen_cost_per_piece end,
    coalesce(pe.cost_basis_source = 'historical_estimate',false)
  from public.finished_stock_movements m
  left join public.production_executions pe on pe.id = m.production_execution_id and pe.product_id = m.product_id
  where m.movement_type in ('damage','giveaway','household','correction','exception_reversal')
)
select e.id,e.occurred_at,e.source_kind,e.source_id,
  coalesce(r.classification,e.classification,'unclassified') as classification,
  e.quantity,e.amount,e.estimated,r.id as review_id
from events e
left join lateral (
  select id,classification from public.stock_financial_event_reviews
  where source_kind = e.source_kind and source_id = e.origin_id order by reviewed_at desc,id desc limit 1
) r on true;
comment on view public.stock_financial_events is
  'Derived stock attribution. Verified original raw count increases are stock_count_gain with unknown valuation, not expense or income. Explicit reviews take precedence. Other legacy null classifications and costs remain unresolved. Reversals retain original attribution. No business rows are changed.';
notify pgrst, 'reload schema';

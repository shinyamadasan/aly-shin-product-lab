-- Migration sequence for Costing duplicate protection:
--
--   supabase-check-costing-duplicates.sql  (this file, read-only)
--                     |
--                     v
--            zero rows returned?
--                     |
--                     v
--   supabase-add-costing-batch-uniqueness.sql  (creates the unique indexes)
--
-- Run this FIRST, in the Supabase SQL editor, before supabase-add-costing-batch-uniqueness.sql.
-- Safe to run more than once -- read-only, no schema changes.
--
-- costing_summaries has no name column: a costing record is identified by (product_id, batch_id).
-- The new uniqueness rule being added is "one costing per batch, or one unlinked costing per
-- product when batch_id is null" -- see PRODUCT_LAB_CONTEXT.md's Costing section. This query
-- finds any existing rows that would already violate that rule.
--
-- If this returns 0 rows, it is safe to run supabase-add-costing-batch-uniqueness.sql.
-- If it returns any rows, STOP -- do not run that file yet. Reconcile each group by hand
-- (delete the true duplicate, or re-link one row to its correct batch). Do not auto-merge,
-- auto-delete, or auto-rename anything.

select
  cs.product_id,
  p.name as product_name,
  cs.batch_id,
  pb.batch_version,
  count(*) as duplicate_count,
  array_agg(cs.id order by cs.created_at) as costing_ids
from costing_summaries cs
left join products p on p.id = cs.product_id
left join product_batches pb on pb.id = cs.batch_id
group by cs.product_id, p.name, cs.batch_id, pb.batch_version
having count(*) > 1;

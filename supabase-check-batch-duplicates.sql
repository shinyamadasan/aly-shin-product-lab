-- Run this FIRST, in the Supabase SQL editor, before supabase-add-batch-version-uniqueness.sql.
-- Safe to run more than once -- read-only, no schema changes.
--
-- product_batches has no unique constraint on (product_id, batch_version) today. The new
-- uniqueness rule being added is "one batch version per product, compared with whitespace
-- trimmed and case ignored" -- see PRODUCT_LAB_CONTEXT.md's Batches section. This query finds
-- any existing rows that would already violate that rule.
--
-- If this returns 0 rows, it is safe to run supabase-add-batch-version-uniqueness.sql.
-- If it returns any rows, STOP -- do not run that file yet. Reconcile each group by hand
-- (rename or delete the true duplicate). Do not auto-merge, auto-delete, or auto-rename anything.

select
  pb.product_id,
  p.name as product_name,
  lower(trim(pb.batch_version)) as normalized_batch_version,
  count(*) as duplicate_count,
  array_agg(pb.id order by pb.created_at) as batch_ids,
  array_agg(pb.batch_version order by pb.created_at) as batch_versions
from product_batches pb
left join products p on p.id = pb.product_id
group by pb.product_id, p.name, lower(trim(pb.batch_version))
having count(*) > 1;

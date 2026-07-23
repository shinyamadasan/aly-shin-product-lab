-- costing_summaries used to have no dedicated column for overhead or equipment
-- depreciation/maintenance cost, so the app silently folded them into unrelated
-- columns on save: overhead into refrigeration_cost, equipment cost into
-- waste_allowance. The category totals were wrong even though the grand total
-- still netted out correctly. Run once in the Supabase SQL editor.

alter table costing_summaries
  add column if not exists overhead_cost numeric not null default 0,
  add column if not exists equipment_cost numeric not null default 0;

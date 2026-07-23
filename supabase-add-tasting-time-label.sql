-- Tasting feedback moved from its own top-level page to living directly under each
-- proof batch, since real tasting happens as a series of checkpoints over time (2 hours
-- post-bake, 24 hours, day 3...), not a single one-off record. time_label is free text --
-- the operator writes whatever timing makes sense for that check-in, not a fixed enum.
alter table tasting_feedback add column if not exists time_label text;

-- Content persistence foundation (M2C1) -- see MARKETING_MODULE.md's "M2C1 implementation
-- record" and "Journey / Content Architecture Audit" sections for the full analysis.
-- content_drafts is the first real table for the Content Studio domain. Schema/type only in
-- this milestone -- no UI, no read/write wiring, no snapshot-generation logic. That is M2C2.
--
-- Journey linkage: journey_entry_id is a nullable foreign key to content_journal(id), on
-- delete set null -- one content_journal row can source zero or many content_drafts rows, and
-- a draft may exist with no Journey source at all (started from scratch). No junction table:
-- this is the smallest correct model for the relationship this milestone actually needs.
-- source_snapshot is a separate, plain nullable text column -- a frozen, human-readable copy
-- of Journey context at draft-creation time, so editing (or one day deleting) the source
-- Journey entry never silently mutates or strands an existing draft's meaning. Populating it
-- is explicitly M2C2's job; it stays null for every row created in this milestone.
--
-- content_type and status are deliberately plain, open-ended text with an application-level
-- default -- no enum, no check constraint -- matching this schema's own established
-- convention for classification/status columns (see entry_type on content_journal, category
-- on ingredients, launch_decision on product_batches).
--
-- Campaign linkage is deliberately absent: campaigns does not exist yet, and this schema
-- never adds a foreign key to a table that isn't there. A campaign_id column arrives later,
-- via its own additive migration, once Campaigns actually ships (matching MARKETING_MODULE.md's
-- Architectural Review). Same reasoning for platform (belongs to a future Calendar/Publishing
-- table, not to drafting) and for any AI-generation, publishing, scheduling, analytics,
-- review/approval, or ownership column -- all explicitly out of scope for this milestone.
--
-- updated_at follows this schema's own existing convention exactly: default now() at insert,
-- no trigger. No table anywhere in this repository auto-updates updated_at on write (confirmed
-- against content_journal, which has carried the same column, unmaintained, since the original
-- schema) -- so none is invented here either.

create table if not exists content_drafts (
  id uuid primary key default gen_random_uuid(),
  journey_entry_id uuid references content_journal(id) on delete set null,
  source_snapshot text,
  title text,
  content_type text not null default 'general',
  status text not null default 'idea',
  hook text,
  caption text,
  script text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table content_drafts enable row level security;

grant select, insert, update, delete on table content_drafts to authenticated;

drop policy if exists "Authenticated users can manage content drafts" on content_drafts;

create policy "Authenticated users can manage content drafts"
  on content_drafts for all
  to authenticated
  using (true)
  with check (true);

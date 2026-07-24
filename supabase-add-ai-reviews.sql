-- AI Advisor round trips: the deterministically-assembled prompt the app generated (Copy
-- Prompt), plus the response the operator pasted back in after running it through an AI chat.
-- response is '' until pasted back -- a review can exist prompt-only. product_id is a plain
-- slug (products are a hardcoded array, not a table -- see src/lib/sample-data.ts), not a
-- foreign key. specialists is a comma-separated list of specialist ids for transparency, not a
-- separate table, matching this app's preference for avoiding schema churn where a text column
-- is enough.
create table if not exists ai_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  batch_id uuid,
  action text not null,
  specialists text not null default '',
  prompt text not null,
  response text not null default '',
  created_at timestamptz not null default now()
);

alter table ai_reviews enable row level security;

grant select, insert, update, delete on table ai_reviews to authenticated;

drop policy if exists "Authenticated users can manage ai_reviews" on ai_reviews;

create policy "Authenticated users can manage ai_reviews"
  on ai_reviews for all
  to authenticated
  using (true)
  with check (true);

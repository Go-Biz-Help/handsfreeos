-- =============================================================================
-- Real Estate Agent, round three, step 6: drafts of a listing's social posts.
--
--        Chris decided (2026-10-01): the AI drafts social posts for the agent
--        to copy into their own accounts; nothing is posted for them, and
--        nothing is copied before the listing is live on the MLS.
--
--        **listing_posts**: each draft, in its batch, as the AI wrote it or
--        the agent edited it, with both fair housing checks of its words as
--        they are now (the fixed list at once, the model a moment later).
-- =============================================================================

create table addon_realestate.listing_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  batch integer not null check (batch >= 1),
  position smallint not null check (position between 0 and 9),
  words text check (words is null or length(btrim(words)) between 1 and 1000),
  state text not null default 'drafting' check (state in ('drafting', 'ready', 'failed', 'replaced')),
  model text check (model is null or length(model) <= 100),
  failure text check (failure is null or length(failure) <= 500),
  -- Both checks of the words as they are now: {"hash": "...", "words": {...}, "model": {...}}.
  checks jsonb not null default '{}'::jsonb
    check (jsonb_typeof(checks) = 'object' and pg_column_size(checks) <= 16384),
  edited_by uuid references app.users (id) on delete set null,
  edited_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (deal_record_id, batch, position),
  check (words is not null or state in ('drafting', 'failed', 'replaced')),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index listing_posts_deal_idx on addon_realestate.listing_posts (workspace_id, deal_record_id, batch desc);
create index listing_posts_edited_by_idx on addon_realestate.listing_posts (edited_by) where edited_by is not null;
create index listing_posts_created_by_idx on addon_realestate.listing_posts (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_realestate.listing_posts', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

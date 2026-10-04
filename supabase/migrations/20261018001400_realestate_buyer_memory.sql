-- =============================================================================
-- Real Estate Agent, round two, step 7: buyer memory.
--
--        What a buyer said they like, can't stand, must have, and when and how
--        they need to move, kept on their deal. Chris decided (2026-09-30):
--        the AI suggests items from the client's own messages and call notes,
--        each with the words it came from, and the agent confirms each one.
--        Anything about who lives somewhere, or any protected class, is never
--        kept: the fixed word list and the model's own read drop it before it
--        is written, and only a count of what was dropped is kept (on the
--        event).
--
--        **memory_items**: one thing the buyer said, its quote and where it
--        came from, suggested by the AI or added by a person; confirmed,
--        rejected or retired by a person.
--        **deals.memory_read_through**: how far the AI has read for this
--        deal, so each pass reads only what's new.
-- =============================================================================

alter table addon_realestate.deals add column memory_read_through timestamptz;

create table addon_realestate.memory_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null check (kind in ('likes', 'dislikes', 'must_have', 'deal_breaker', 'timing', 'money', 'other')),
  words text not null check (length(btrim(words)) between 1 and 300),
  -- The client's own words it came from; null for one a person typed in.
  quote text check (quote is null or length(quote) <= 500),
  source_kind text not null check (source_kind in ('message', 'call', 'note', 'typed')),
  source_id uuid,
  status text not null check (status in ('suggested', 'confirmed', 'rejected', 'retired')),
  -- Who put it here: the AI, or a person.
  suggested_by text not null check (suggested_by in ('ai', 'person')),
  created_by uuid references app.users (id) on delete set null,
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  decided_note text check (decided_note is null or length(decided_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source_kind = 'typed') = (quote is null)),
  check ((status = 'suggested') = (decided_at is null)),
  -- The AI only ever suggests; a person decides.
  check (suggested_by = 'person' or status = 'suggested' or decided_by is not null),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index memory_items_deal_idx on addon_realestate.memory_items (workspace_id, deal_record_id, status);
create index memory_items_created_by_idx on addon_realestate.memory_items (created_by) where created_by is not null;
create index memory_items_decided_by_idx on addon_realestate.memory_items (decided_by) where decided_by is not null;
select private.addon_table_policies('addon_realestate.memory_items', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

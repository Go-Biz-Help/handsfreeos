-- =============================================================================
-- Real Estate Agent, round five, step 5: each buyer's saved search, and the
-- new matches it brings.
--
--        **A saved search** is the buyer's profile (budget, areas, kind of
--        home, rooms, size), asked of the business's listing feed every
--        fifteen minutes while the deal is open and the search is on.
--
--        **New matches go to the agent first** (Chris, 2026-10-02): kept here,
--        at most one Home card a day per buyer, never to the client. The
--        agent sends one to the client (it becomes one of the deal's homes,
--        with its MLS's notice and logo) or sets it aside. The client sees
--        only homes the agent sent.
-- =============================================================================

alter table addon_realestate.buyer_profiles
  add column search_on boolean not null default true,
  add column search_checked_at timestamptz,
  -- The last day a Home card about new matches went up for this buyer (in the business's time).
  add column search_card_on date,
  add column search_failure text check (search_failure is null or length(search_failure) <= 500);

create table addon_realestate.feed_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- The supplier and its own key for the listing: the same listing is one match.
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,39}$'),
  listing_key text not null check (length(listing_key) between 1 and 200),
  mls_number text not null check (length(mls_number) between 1 and 80),
  -- The listing as the feed said it, last time it was asked.
  mls jsonb not null check (jsonb_typeof(mls) = 'object'),
  state text not null default 'new' check (state in ('new', 'sent', 'dismissed')),
  found_at timestamptz not null default now(),
  -- The MLS changed it since it was found (its price or where it stands).
  changed_at timestamptz,
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  -- The deal's home it became, once sent.
  home_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, deal_record_id, provider, listing_key),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade,
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id),
  check ((state = 'new') = (decided_at is null)),
  check (state <> 'sent' or home_id is not null)
);
create index feed_matches_deal_idx on addon_realestate.feed_matches (workspace_id, deal_record_id, state);
create index feed_matches_decided_by_idx on addon_realestate.feed_matches (decided_by) where decided_by is not null;
create index feed_matches_home_idx on addon_realestate.feed_matches (workspace_id, home_id) where home_id is not null;
select private.addon_table_policies('addon_realestate.feed_matches', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

-- The client sees what the MLS says of a home the agent sent them (its photos, with the MLS's notice and logo).
grant select (mls) on addon_realestate.homes to portal_actor;

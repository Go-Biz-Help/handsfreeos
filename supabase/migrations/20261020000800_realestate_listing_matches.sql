-- =============================================================================
-- Real Estate Agent, round three, step 11: a new listing suggested to the
-- business's own buyers' agents.
--
--        Chris decided (2026-10-01): a listing that fits one of the
--        business's buyers is suggested to that buyer's agent. Chosen for
--        him: only the business's own open buyer deals are read, on price,
--        areas, kind of home, beds, baths and size; the listing's side sees
--        how many, never who.
--
--        **listing_suggestions** belong to the buyer's deal (its row
--        security), with a copy of the listing's public facts and how they
--        fit, so nothing reads across deals: "add to their homes" makes a
--        home from it, "not a fit" sets it aside. **listings** keep the
--        counts the listing's side sees. **homes** can come from one of our
--        own listings.
-- =============================================================================

alter table addon_realestate.homes drop constraint homes_source_check;
alter table addon_realestate.homes add constraint homes_source_check
  check (source in ('agent', 'client', 'mls', 'our_listing'));

alter table addon_realestate.listings
  add column matches_suggested integer not null default 0 check (matches_suggested >= 0),
  add column matches_added integer not null default 0 check (matches_added >= 0),
  add column matched_at timestamptz;

create table addon_realestate.listing_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The buyer's deal it's for.
  deal_record_id uuid not null,
  -- The listing it came from: kept to count and to refresh it, never read through.
  listing_deal_id uuid,
  address text not null check (length(btrim(address)) between 3 and 300),
  address_key text not null check (length(address_key) between 3 and 300),
  -- The listing's public facts when suggested (price, beds, baths, size, kind), and how they fit.
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4096),
  fit jsonb not null default '[]'::jsonb check (jsonb_typeof(fit) = 'array' and pg_column_size(fit) <= 8192),
  mls_number text check (mls_number is null or length(mls_number) <= 40),
  page_slug text check (page_slug is null or length(page_slug) <= 120),
  state text not null default 'new' check (state in ('new', 'added', 'not_a_fit', 'gone')),
  home_id uuid,
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  decided_reason text check (decided_reason is null or length(btrim(decided_reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (deal_record_id, listing_deal_id),
  check ((state = 'added') = (home_id is not null)),
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id)
    on delete set null (home_id),
  foreign key (workspace_id, listing_deal_id) references addon_realestate.deals (workspace_id, record_id)
    on delete set null (listing_deal_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index listing_suggestions_deal_idx on addon_realestate.listing_suggestions
  (workspace_id, deal_record_id, created_at desc);
create index listing_suggestions_listing_idx on addon_realestate.listing_suggestions (workspace_id, listing_deal_id)
  where listing_deal_id is not null;
create index listing_suggestions_home_idx on addon_realestate.listing_suggestions (home_id) where home_id is not null;
create index listing_suggestions_decided_by_idx on addon_realestate.listing_suggestions (decided_by)
  where decided_by is not null;
select private.addon_table_policies('addon_realestate.listing_suggestions', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

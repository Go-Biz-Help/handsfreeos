-- =============================================================================
-- Real Estate Agent, round five, step 4: listing data on homes, listings and
-- CMAs.
--
--        A business's listing feed (step 3) now fills in what it knows:
--
--        **A buyer's home.** Looked up on the feed by its address or MLS
--        number when it's added (or when the agent asks again). What the feed
--        says is kept as it said it (`mls`, with its supplier, MLS and time),
--        fills the home's facts that are still empty, and is shown beside
--        what a person confirmed when they differ: a person picks.
--
--        **Our own listing.** The same, as one more source for each fact
--        beside the seller's questionnaire and the old listing's words.
--
--        **A CMA's comps.** Homes sold near the subject, asked of the feed,
--        are added as comps from the MLS that don't count until the agent
--        ticks them.
--
--        Chris decided (2026-10-02): a feed is a source of facts, never of
--        authority; each value says where it came from and when.
-- =============================================================================

-- What the feed said about a home, and where looking it up stands.
alter table addon_realestate.homes
  add column mls jsonb check (mls is null or jsonb_typeof(mls) = 'object'),
  add column mls_state text not null default 'none'
    check (mls_state in ('none', 'looking', 'found', 'not_found', 'failed')),
  add column mls_checked_at timestamptz,
  add column mls_failure text check (mls_failure is null or length(mls_failure) <= 500);

alter table addon_realestate.listings
  add column mls jsonb check (mls is null or jsonb_typeof(mls) = 'object'),
  add column mls_state text not null default 'none'
    check (mls_state in ('none', 'looking', 'found', 'not_found', 'failed')),
  add column mls_checked_at timestamptz,
  add column mls_failure text check (mls_failure is null or length(mls_failure) <= 500);

-- Comps from the feed: asked for, found, or why not, and what was asked.
alter table addon_realestate.cmas
  add column comps_state text not null default 'none'
    check (comps_state in ('none', 'finding', 'found', 'none_found', 'failed')),
  add column comps_asked jsonb check (comps_asked is null or jsonb_typeof(comps_asked) = 'object'),
  add column comps_found_at timestamptz,
  add column comps_failure text check (comps_failure is null or length(comps_failure) <= 500);

alter table addon_realestate.cma_comps
  add column mls_number text check (mls_number is null or length(mls_number) <= 80),
  add column mls jsonb check (mls is null or jsonb_typeof(mls) = 'object');
create unique index cma_comps_mls_number_idx on addon_realestate.cma_comps (workspace_id, cma_id, mls_number)
  where mls_number is not null;

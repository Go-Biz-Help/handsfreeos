-- =============================================================================
-- Real Estate Agent, round two, step 9: the CMA.
--
--        Chris decided (2026-09-30): the agent adds the comps, HandsFreeOS
--        works out a price range, and the AI drafts the summary for the agent
--        to check. The summary's words get both fair-housing checks, as a
--        client update's do, and a CMA is shared with the client only once
--        any flag is fixed or kept with a reason.
--
--        **cmas**: one per look at a home's value: the home and its facts as
--        the agent had them, the range it came to (kept when finalized), the
--        summary and where it stands, and who finalized and shared it.
--        **cma_comps**: the homes it's compared with: price, when sold, beds,
--        baths, size, distance, the agent's adjustments with their reasons,
--        and whether it's used.
--        **fair_housing_checks.cma_id**: a check is of a client update's
--        words or of a CMA's summary.
--
--        The client's portal reads a CMA, and its comps, only once shared.
-- =============================================================================

create table addon_realestate.cmas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- The home it's for: one of a buyer deal's homes, or (round three) a listing's property by its address.
  home_id uuid,
  subject_address text not null check (length(btrim(subject_address)) between 3 and 300),
  subject_beds integer check (subject_beds is null or subject_beds between 0 and 20),
  subject_baths numeric(3, 1) check (subject_baths is null or subject_baths between 0 and 20),
  subject_sqft integer check (subject_sqft is null or subject_sqft between 100 and 100000),
  subject_list_price_cents bigint check (subject_list_price_cents is null or subject_list_price_cents > 0),
  subject_year_built integer check (subject_year_built is null or subject_year_built between 1600 and 2100),
  -- "CMA 2" on the deal.
  number integer not null check (number >= 1),
  status text not null default 'draft' check (status in ('draft', 'final', 'shared')),
  method integer not null default 1 check (method >= 1),
  as_of date not null,
  -- The range as finalized; a draft's is worked out as it's read.
  low_cents bigint check (low_cents is null or low_cents > 0),
  likely_cents bigint check (likely_cents is null or likely_cents > 0),
  high_cents bigint check (high_cents is null or high_cents > 0),
  per_sqft_cents bigint check (per_sqft_cents is null or per_sqft_cents > 0),
  summary text check (summary is null or length(summary) <= 6000),
  summary_state text not null default 'none'
    check (summary_state in ('none', 'drafting', 'ready', 'failed')),
  summary_model text check (summary_model is null or length(summary_model) <= 100),
  summary_failure text check (summary_failure is null or length(summary_failure) <= 500),
  summary_edited_by uuid references app.users (id) on delete set null,
  summary_edited_at timestamptz,
  flags_acknowledged_by uuid references app.users (id) on delete set null,
  flags_acknowledged_at timestamptz,
  flags_acknowledged_reason text check (flags_acknowledged_reason is null or length(flags_acknowledged_reason) <= 500),
  finalized_by uuid references app.users (id) on delete set null,
  finalized_at timestamptz,
  shared_by uuid references app.users (id) on delete set null,
  shared_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (deal_record_id, number),
  check ((status = 'draft') = (finalized_at is null)),
  check ((status = 'shared') = (shared_at is not null)),
  check (status = 'draft' or (low_cents is not null and likely_cents is not null and high_cents is not null)),
  check (low_cents is null or (low_cents <= likely_cents and likely_cents <= high_cents)),
  check ((summary_state = 'ready') = (summary is not null)),
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id) on delete set null (home_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index cmas_deal_idx on addon_realestate.cmas (workspace_id, deal_record_id, number);
create index cmas_home_idx on addon_realestate.cmas (workspace_id, home_id) where home_id is not null;
create index cmas_summary_edited_by_idx on addon_realestate.cmas (summary_edited_by)
  where summary_edited_by is not null;
create index cmas_flags_acknowledged_by_idx on addon_realestate.cmas (flags_acknowledged_by)
  where flags_acknowledged_by is not null;
create index cmas_finalized_by_idx on addon_realestate.cmas (finalized_by) where finalized_by is not null;
create index cmas_shared_by_idx on addon_realestate.cmas (shared_by) where shared_by is not null;
create index cmas_created_by_idx on addon_realestate.cmas (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.cmas', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.cmas', 'deal_record_id',
  array['id', 'home_id', 'subject_address', 'subject_beds', 'subject_baths', 'subject_sqft',
    'subject_list_price_cents', 'number', 'status', 'method', 'as_of', 'low_cents', 'likely_cents', 'high_cents',
    'per_sqft_cents', 'summary', 'shared_at']);
-- The client sees a CMA only once it's shared with them.
create policy cmas_portal_shared on addon_realestate.cmas as restrictive for select to portal_actor
  using (status = 'shared');

create table addon_realestate.cma_comps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  cma_id uuid not null,
  address text not null check (length(btrim(address)) between 3 and 300),
  -- Its sold price, or its asking price while pending or for sale.
  price_cents bigint not null check (price_cents > 0),
  status text not null default 'sold' check (status in ('sold', 'pending', 'active')),
  sold_on date,
  beds integer check (beds is null or beds between 0 and 20),
  baths numeric(3, 1) check (baths is null or baths between 0 and 20),
  sqft integer check (sqft is null or sqft between 100 and 100000),
  year_built integer check (year_built is null or year_built between 1600 and 2100),
  distance_miles numeric(5, 2) check (distance_miles is null or distance_miles between 0 and 500),
  -- The agent's adjustments, each with its reason: [{"label": "Newer roof", "cents": 500000}].
  adjustments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(adjustments) = 'array' and jsonb_array_length(adjustments) <= 8),
  used boolean not null default true,
  note text check (note is null or length(note) <= 1000),
  -- Typed in by the agent, or (round five) from the MLS.
  source text not null default 'agent' check (source in ('agent', 'mls')),
  position integer not null check (position between 1 and 100),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'sold' or sold_on is not null),
  foreign key (workspace_id, cma_id) references addon_realestate.cmas (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index cma_comps_cma_idx on addon_realestate.cma_comps (workspace_id, cma_id, position);
create index cma_comps_deal_idx on addon_realestate.cma_comps (workspace_id, deal_record_id);
create index cma_comps_created_by_idx on addon_realestate.cma_comps (created_by) where created_by is not null;
-- A draft's comp taken off is simply gone; a finalized CMA's comps are kept as they were.
select private.addon_table_policies('addon_realestate.cma_comps', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');
select private.addon_portal_policies('addon_realestate.cma_comps', 'deal_record_id',
  array['id', 'cma_id', 'address', 'price_cents', 'status', 'sold_on', 'beds', 'baths', 'sqft', 'distance_miles',
    'adjustments', 'used', 'position']);
create policy cma_comps_portal_shared on addon_realestate.cma_comps as restrictive for select to portal_actor
  using (cma_id in (select c.id from addon_realestate.cmas c where c.status = 'shared'));

-- A fair-housing check reads a client update's words or a CMA's summary.
alter table addon_realestate.fair_housing_checks
  alter column draft_id drop not null,
  add column cma_id uuid,
  add constraint fair_housing_checks_cma_fkey foreign key (workspace_id, cma_id)
    references addon_realestate.cmas (workspace_id, id) on delete cascade,
  add constraint fair_housing_checks_of_check check ((draft_id is null) <> (cma_id is null));
create index fair_housing_checks_cma_idx on addon_realestate.fair_housing_checks (cma_id) where cma_id is not null;

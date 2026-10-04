-- =============================================================================
-- Real Estate Agent, round two, step 6: the buyer's profile and their homes.
--
--        HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md ("Round two: Buyer
--        core"). Each table follows its deal's privacy through its record
--        column (addon_table_policies), as round one's do.
--
--        **buyer_profiles**: what the buyer wants, one per buyer deal, and
--        **buyer_profile_versions**: each save as it was, append-only.
--        **homes**: a home on a buyer deal, added by the agent or the client
--        (Chris: before the MLS, both add them). The agent pastes an address
--        or a listing's text; a pasted link is kept and never read. The AI
--        fills in its facts from the pasted text alone, each with the words
--        it came from, and the agent confirms them (facts_state).
--        **home_reactions**: each client's own save or pass, with a word why
--        (co-buyers each have their own).
--        **duty_evidence** can point at one of the add-on's own rows (a home
--        toured, an offer made: `ref_kind`, `ref_id`), and history names the
--        client when they did something from their portal.
-- =============================================================================

-- ---------- who did it: the client, from their portal ----------
alter table addon_realestate.deal_history drop constraint deal_history_actor_type_check;
alter table addon_realestate.deal_history add constraint deal_history_actor_type_check
  check (actor_type in ('person', 'system', 'ai', 'client'));
alter table addon_realestate.duty_log drop constraint duty_log_actor_type_check;
alter table addon_realestate.duty_log add constraint duty_log_actor_type_check
  check (actor_type in ('person', 'system', 'ai', 'client'));

-- ---------- proof that is one of the add-on's own rows ----------
alter table addon_realestate.duty_evidence drop constraint duty_evidence_kind_check;
alter table addon_realestate.duty_evidence
  add constraint duty_evidence_kind_check check (kind in ('document', 'file', 'note', 'attestation', 'appointment',
    'message', 'dates', 'deal_field', 'record')),
  add column ref_kind text check (ref_kind is null or ref_kind ~ '^[a-z][a-z_]{0,39}$'),
  add column ref_id uuid,
  add constraint duty_evidence_ref_check check ((ref_kind is null) = (ref_id is null)
    and ((kind = 'record') = (ref_kind is not null)));
create index duty_evidence_ref_idx on addon_realestate.duty_evidence (workspace_id, ref_kind, ref_id)
  where ref_id is not null;

-- ---------- the buyer's profile ----------
create table addon_realestate.buyer_profiles (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  budget_min_cents bigint check (budget_min_cents is null or budget_min_cents >= 0),
  budget_max_cents bigint check (budget_max_cents is null or budget_max_cents >= 0),
  -- Towns, ZIP codes or neighborhoods, as the client named them.
  areas text[] not null default '{}' check (cardinality(areas) <= 20),
  home_types text[] not null default '{}' check (home_types <@ array['single_family', 'condo', 'townhouse',
    'multi_family', 'manufactured', 'land']::text[]),
  beds_min integer check (beds_min is null or beds_min between 0 and 20),
  baths_min numeric(3, 1) check (baths_min is null or baths_min between 0 and 20),
  sqft_min integer check (sqft_min is null or sqft_min between 0 and 100000),
  move_by date,
  must_haves text[] not null default '{}' check (cardinality(must_haves) <= 20),
  deal_breakers text[] not null default '{}' check (cardinality(deal_breakers) <= 20),
  version integer not null default 1 check (version >= 1),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (workspace_id, deal_record_id),
  check (budget_min_cents is null or budget_max_cents is null or budget_min_cents <= budget_max_cents),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index buyer_profiles_updated_by_idx on addon_realestate.buyer_profiles (updated_by)
  where updated_by is not null;
select private.addon_table_policies('addon_realestate.buyer_profiles', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

create table addon_realestate.buyer_profile_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  version integer not null check (version >= 1),
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 16384),
  actor_type text not null check (actor_type in ('person', 'system', 'ai', 'client')),
  saved_by uuid references app.users (id) on delete set null,
  saved_at timestamptz not null default now(),
  unique (workspace_id, deal_record_id, version),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index buyer_profile_versions_saved_by_idx on addon_realestate.buyer_profile_versions (saved_by)
  where saved_by is not null;
select private.addon_table_policies('addon_realestate.buyer_profile_versions', 'realestate.use', 'realestate.use',
  null, 'deal_record_id');
create trigger buyer_profile_versions_append_only before update on addon_realestate.buyer_profile_versions
  for each row execute function private.forbid_change();

-- ---------- homes ----------
create table addon_realestate.homes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  address text not null check (length(btrim(address)) between 3 and 300),
  -- The address as compared ("12 main st, austin tx"): one home per address on a deal.
  address_key text not null check (length(address_key) between 3 and 300),
  -- Who brought it: the agent, the client from their portal, or (round five) the MLS.
  source text not null check (source in ('agent', 'client', 'mls')),
  -- A listing's link, kept for people to open; nothing in HandsFreeOS ever reads it.
  link text check (link is null or (length(link) <= 2000 and link ~* '^https?://')),
  -- The listing's words as pasted: the only thing the AI reads its facts from.
  pasted_text text check (pasted_text is null or length(pasted_text) <= 20000),
  -- price_cents, beds, baths, sqft, lot_sqft, year_built, hoa_monthly_cents, property_type, garage_spaces.
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4096),
  -- Each fact the AI suggested, with the words in the pasted text it came from.
  fact_sources jsonb not null default '{}'::jsonb
    check (jsonb_typeof(fact_sources) = 'object' and pg_column_size(fact_sources) <= 16384),
  facts_state text not null default 'none'
    check (facts_state in ('none', 'filling', 'suggested', 'confirmed', 'failed')),
  facts_model text check (facts_model is null or length(facts_model) <= 100),
  facts_failure text check (facts_failure is null or length(facts_failure) <= 500),
  facts_confirmed_by uuid references app.users (id) on delete set null,
  facts_confirmed_at timestamptz,
  -- Where the agent has it.
  status text not null default 'saved' check (status in ('saved', 'shortlisted', 'toured', 'offered', 'passed',
    'removed')),
  status_note text check (status_note is null or length(status_note) <= 500),
  added_by uuid references app.users (id) on delete set null,
  added_by_person_id uuid references app.people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((facts_state = 'confirmed') = (facts_confirmed_at is not null)),
  check (added_by_person_id is null or source = 'client'),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create unique index homes_address_unique on addon_realestate.homes (workspace_id, deal_record_id, address_key)
  where status <> 'removed';
create index homes_deal_idx on addon_realestate.homes (workspace_id, deal_record_id, created_at);
create index homes_added_by_idx on addon_realestate.homes (added_by) where added_by is not null;
create index homes_added_by_person_idx on addon_realestate.homes (added_by_person_id)
  where added_by_person_id is not null;
create index homes_facts_confirmed_by_idx on addon_realestate.homes (facts_confirmed_by)
  where facts_confirmed_by is not null;
select private.addon_table_policies('addon_realestate.homes', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The client sees their deal's homes: where it is, its facts once confirmed are read through their query.
select private.addon_portal_policies('addon_realestate.homes', 'deal_record_id',
  array['id', 'address', 'source', 'link', 'facts', 'facts_state', 'status', 'added_by_person_id', 'created_at']);

create table addon_realestate.home_reactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  home_id uuid not null,
  person_id uuid not null references app.people (id) on delete cascade,
  reaction text not null check (reaction in ('saved', 'passed')),
  note text check (note is null or length(note) <= 1000),
  reacted_at timestamptz not null default now(),
  unique (home_id, person_id),
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index home_reactions_deal_idx on addon_realestate.home_reactions (workspace_id, deal_record_id);
create index home_reactions_person_idx on addon_realestate.home_reactions (person_id);
select private.addon_table_policies('addon_realestate.home_reactions', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.home_reactions', 'deal_record_id',
  array['id', 'home_id', 'person_id', 'reaction', 'note', 'reacted_at']);

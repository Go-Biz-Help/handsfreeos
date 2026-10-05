-- =============================================================================
-- Real Estate Agent, round three, step 3: the listing and its facts.
--
--        HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md ("Round three: Listing
--        core"). Each table follows its deal's privacy through its record
--        column (addon_table_policies), as round two's do.
--
--        **listings**: one per listing deal, beside it. The home's facts as
--        the agent confirmed them, each with where it came from (Chris,
--        2026-10-01: the seller's questionnaire, the old listing's pasted
--        words read by the AI, or typed by the agent); the pasted words and
--        what the AI found in them; the agent's notes for the description;
--        when it went live on the MLS (nothing public goes before it); and its
--        public page.
--        **listing_photos**: the photos, in order, each on the public page or
--        kept for the agent and the seller.
--        **seller_questionnaires**: the seller's answers about their home,
--        saved as they go and sent once.
--        **client_tasks** gain the questionnaire, and a link to what a
--        sign-off is for (a description, a price), so signing it moves that on.
-- =============================================================================

create table addon_realestate.listings (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- The facts as the agent confirmed them: what the page, the flyer and matching use (round two's home facts).
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4096),
  -- Where each confirmed fact came from: {"sqft": {"from": "pasted", "quote": "2,340 sq ft"}}.
  fact_sources jsonb not null default '{}'::jsonb
    check (jsonb_typeof(fact_sources) = 'object' and pg_column_size(fact_sources) <= 16384),
  facts_confirmed_by uuid references app.users (id) on delete set null,
  facts_confirmed_at timestamptz,
  -- The old listing's words as the agent pasted them: the only thing the AI reads facts from.
  pasted_text text check (pasted_text is null or length(pasted_text) <= 20000),
  pasted_state text not null default 'none' check (pasted_state in ('none', 'filling', 'read', 'failed')),
  pasted_facts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(pasted_facts) = 'object' and pg_column_size(pasted_facts) <= 4096),
  pasted_sources jsonb not null default '{}'::jsonb
    check (jsonb_typeof(pasted_sources) = 'object' and pg_column_size(pasted_sources) <= 16384),
  pasted_model text check (pasted_model is null or length(pasted_model) <= 100),
  pasted_failure text check (pasted_failure is null or length(pasted_failure) <= 500),
  -- The agent's notes for the description: what's been updated, what stands out.
  highlights text check (highlights is null or length(highlights) <= 2000),
  -- Live on the MLS (step 5): its number and the day it went live.
  mls_number text check (mls_number is null or mls_number ~ '^[A-Za-z0-9-]{1,30}$'),
  mls_live_on date,
  mls_marked_by uuid references app.users (id) on delete set null,
  mls_marked_at timestamptz,
  -- The public page (step 6): its address under the business's site, and whether it's up.
  slug text check (slug is null or slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  page_state text not null default 'none' check (page_state in ('none', 'published', 'down')),
  page_published_by uuid references app.users (id) on delete set null,
  page_published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, deal_record_id),
  unique (workspace_id, slug),
  -- Nothing counts as a fact until a person confirmed it.
  check (facts_confirmed_at is not null or facts = '{}'::jsonb),
  check ((mls_number is null) = (mls_live_on is null)),
  check (page_state = 'none' or slug is not null),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index listings_facts_confirmed_by_idx on addon_realestate.listings (facts_confirmed_by)
  where facts_confirmed_by is not null;
create index listings_mls_marked_by_idx on addon_realestate.listings (mls_marked_by) where mls_marked_by is not null;
create index listings_page_published_by_idx on addon_realestate.listings (page_published_by)
  where page_published_by is not null;
select private.addon_table_policies('addon_realestate.listings', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The seller sees their listing's facts, when it went live, and its page.
select private.addon_portal_policies('addon_realestate.listings', 'deal_record_id',
  array['facts', 'mls_number', 'mls_live_on', 'slug', 'page_state', 'page_published_at']);

create table addon_realestate.listing_photos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  file_id uuid not null references app.files (id) on delete cascade,
  position integer not null check (position >= 0),
  caption text check (caption is null or length(caption) <= 120),
  -- On the public page and the flyer; off keeps it for the agent and the seller.
  public boolean not null default true,
  added_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, deal_record_id, file_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index listing_photos_deal_idx on addon_realestate.listing_photos (workspace_id, deal_record_id, position);
create index listing_photos_file_idx on addon_realestate.listing_photos (file_id);
create index listing_photos_added_by_idx on addon_realestate.listing_photos (added_by) where added_by is not null;
-- A photo taken off the listing is just that: its file stays in the deal's files.
select private.addon_table_policies('addon_realestate.listing_photos', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');
select private.addon_portal_policies('addon_realestate.listing_photos', 'deal_record_id',
  array['id', 'file_id', 'position', 'caption', 'public']);

create table addon_realestate.seller_questionnaires (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- {"facts": {"beds": 4, ...}, "updates": "...", "loves": "..."}, as the seller last saved them.
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 16384),
  state text not null default 'draft' check (state in ('draft', 'submitted')),
  saved_by_person_id uuid references app.people (id) on delete set null,
  saved_at timestamptz,
  submitted_by_person_id uuid references app.people (id) on delete set null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, deal_record_id),
  check ((state = 'submitted') = (submitted_at is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index seller_questionnaires_saved_by_idx on addon_realestate.seller_questionnaires (saved_by_person_id)
  where saved_by_person_id is not null;
create index seller_questionnaires_submitted_by_idx on addon_realestate.seller_questionnaires
  (submitted_by_person_id) where submitted_by_person_id is not null;
select private.addon_table_policies('addon_realestate.seller_questionnaires', 'realestate.use', 'realestate.use',
  null, 'deal_record_id');
select private.addon_portal_policies('addon_realestate.seller_questionnaires', 'deal_record_id',
  array['answers', 'state', 'saved_at', 'submitted_at']);

-- ---------- the client's tasks: the questionnaire, and what a sign-off is for ----------
alter table addon_realestate.client_tasks drop constraint client_tasks_kind_check;
alter table addon_realestate.client_tasks
  add constraint client_tasks_kind_check check (kind in ('upload', 'sign_off', 'do', 'questionnaire')),
  -- A sign-off for one of the listing's own rows: signing it moves that on (a description, a price).
  add column ref_kind text check (ref_kind is null or ref_kind in ('listing_description', 'listing_price')),
  add column ref_id uuid,
  add constraint client_tasks_ref_check check ((ref_kind is null) = (ref_id is null)
    and (ref_kind is null or kind = 'sign_off'));
create index client_tasks_ref_idx on addon_realestate.client_tasks (workspace_id, ref_kind, ref_id)
  where ref_id is not null;
grant select (ref_kind, ref_id) on addon_realestate.client_tasks to portal_actor;

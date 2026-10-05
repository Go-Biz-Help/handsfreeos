-- =============================================================================
-- Real Estate Agent, round two, step 10: offers and counters.
--
--        Chris decided (2026-09-30): the terms live here, the contract
--        elsewhere. Every version and counter is kept as it was sent, the
--        response deadline is watched (an alert two hours before, at the
--        deadline, and if it passes), and the client gets a one-page summary
--        in their portal. The contract itself is filled in the agent's forms
--        software and uploaded as one of the deal's documents. When an offer
--        is accepted its terms go to the deal's key dates for a person to
--        confirm; when it's turned down, the deal takes the lost path.
--
--        **offers**: one per home an offer is made on: who it's with, where
--        it stands, the version accepted, and the version whose summary is in
--        the client's portal.
--        **offer_versions**: each offer and counter, as it was sent: who sent
--        it, its terms and the time it must be answered by. Never changed.
--        **documents.offer_version_id**: the uploaded contract or counter a
--        version is.
-- =============================================================================

create table addon_realestate.offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  home_id uuid not null,
  -- "Offer 2" on the deal.
  number integer not null check (number >= 1),
  -- Who answers next: the other side, or us; or how it ended.
  status text not null default 'waiting_them'
    check (status in ('waiting_them', 'waiting_us', 'accepted', 'declined', 'expired', 'withdrawn')),
  -- The listing agent it's with.
  their_agent_name text check (their_agent_name is null or length(their_agent_name) <= 200),
  their_brokerage text check (their_brokerage is null or length(their_brokerage) <= 200),
  their_email text check (their_email is null or length(their_email) <= 320),
  their_phone text check (their_phone is null or length(their_phone) <= 40),
  accepted_version_id uuid,
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or length(ended_reason) <= 500),
  -- The version whose one-page summary is in the client's portal.
  shared_version_id uuid,
  shared_by uuid references app.users (id) on delete set null,
  shared_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (deal_record_id, number),
  check ((status in ('waiting_them', 'waiting_us')) = (ended_at is null)),
  check ((status = 'accepted') = (accepted_version_id is not null)),
  check ((shared_version_id is null) = (shared_at is null)),
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
-- One offer out on a home at a time.
create unique index offers_live_unique on addon_realestate.offers (workspace_id, home_id)
  where status in ('waiting_them', 'waiting_us');
create index offers_deal_idx on addon_realestate.offers (workspace_id, deal_record_id, number);
create index offers_home_idx on addon_realestate.offers (workspace_id, home_id);
create index offers_shared_by_idx on addon_realestate.offers (shared_by) where shared_by is not null;
create index offers_created_by_idx on addon_realestate.offers (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.offers', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.offers', 'deal_record_id',
  array['id', 'home_id', 'number', 'status', 'accepted_version_id', 'ended_at', 'shared_version_id', 'shared_at']);
-- The client sees an offer only once its summary is shared with them.
create policy offers_portal_shared on addon_realestate.offers as restrictive for select to portal_actor
  using (shared_version_id is not null);

create table addon_realestate.offer_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  offer_id uuid not null,
  number integer not null check (number >= 1),
  -- Ours (the offer, or our counter), or theirs (the seller's counter).
  side text not null check (side in ('us', 'them')),
  -- When it was sent or came in.
  at timestamptz not null default now(),
  price_cents bigint not null check (price_cents > 0),
  emd_cents bigint check (emd_cents is null or emd_cents >= 0),
  emd_days integer check (emd_days is null or emd_days between 0 and 60),
  seller_credit_cents bigint not null default 0 check (seller_credit_cents >= 0),
  -- Days to inspect and ask for repairs; null with no inspection period.
  inspection_days integer check (inspection_days is null or inspection_days between 0 and 90),
  loan_type text check (loan_type is null or loan_type in ('conventional', 'fha', 'va', 'usda', 'cash', 'other')),
  financing_days integer check (financing_days is null or financing_days between 0 and 120),
  appraisal_contingency boolean,
  closing_date date,
  other_terms text check (other_terms is null or length(other_terms) <= 2000),
  -- The time it must be answered by.
  respond_by timestamptz,
  -- The team's note: never the client's to read.
  note text check (note is null or length(note) <= 1000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (offer_id, number),
  check (loan_type <> 'cash' or financing_days is null),
  foreign key (workspace_id, offer_id) references addon_realestate.offers (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index offer_versions_offer_idx on addon_realestate.offer_versions (workspace_id, offer_id, number);
create index offer_versions_deal_idx on addon_realestate.offer_versions (workspace_id, deal_record_id);
create index offer_versions_respond_by_idx on addon_realestate.offer_versions (respond_by)
  where respond_by is not null;
create index offer_versions_created_by_idx on addon_realestate.offer_versions (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_realestate.offer_versions', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- Kept as it was sent.
create trigger offer_versions_append_only before update on addon_realestate.offer_versions
  for each row execute function private.forbid_change();
select private.addon_portal_policies('addon_realestate.offer_versions', 'deal_record_id',
  array['id', 'offer_id', 'number', 'side', 'at', 'price_cents', 'emd_cents', 'emd_days', 'seller_credit_cents',
    'inspection_days', 'loan_type', 'financing_days', 'appraisal_contingency', 'closing_date', 'other_terms',
    'respond_by']);
-- Only the version whose summary was shared.
create policy offer_versions_portal_shared on addon_realestate.offer_versions as restrictive for select
  to portal_actor
  using (id in (select o.shared_version_id from addon_realestate.offers o where o.shared_version_id is not null));

alter table addon_realestate.offers
  add constraint offers_accepted_version_fkey foreign key (workspace_id, accepted_version_id)
    references addon_realestate.offer_versions (workspace_id, id) on delete set null (accepted_version_id),
  add constraint offers_shared_version_fkey foreign key (workspace_id, shared_version_id)
    references addon_realestate.offer_versions (workspace_id, id) on delete set null (shared_version_id);
create index offers_accepted_version_idx on addon_realestate.offers (workspace_id, accepted_version_id)
  where accepted_version_id is not null;
create index offers_shared_version_idx on addon_realestate.offers (workspace_id, shared_version_id)
  where shared_version_id is not null;

-- The uploaded contract or counter a version is.
alter table addon_realestate.documents
  add column offer_version_id uuid references addon_realestate.offer_versions (id) on delete set null;
create index documents_offer_version_idx on addon_realestate.documents (offer_version_id)
  where offer_version_id is not null;

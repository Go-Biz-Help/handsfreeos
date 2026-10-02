-- =============================================================================
-- Real Estate Agent, round four, step 3: contingencies as monitored objects.
--
--        Chris decided (2026-10-02): the agent records how each contingency
--        ended (satisfied, waived or expired), with the signed removal form
--        as proof, and the client sees it in the portal. Chosen for him: an
--        owner or admin (Approve exceptions) can record one without the form,
--        with a reason that's kept, as tours and prices are.
--
--        **contingencies**: one of each kind on a deal (inspection,
--        financing, appraisal, home sale, HOA, title), ending on its key date
--        (`end_key`), so moving the date moves it; or one the agent names
--        ("other"), ending on its own date. Where it came from (the accepted
--        offer, the contract, typed), how it ended, the form, who recorded it
--        and when. Ended ones stay.
-- =============================================================================

create table addon_realestate.contingencies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null
    check (kind in ('inspection', 'financing', 'appraisal', 'home_sale', 'hoa', 'title', 'other')),
  label text check (label is null or length(btrim(label)) between 1 and 120),
  end_key text check (end_key is null or end_key in ('inspection_end', 'financing_end', 'appraisal_end',
    'home_sale_end', 'hoa_review_end', 'title_objection_end')),
  ends_on date,
  source text not null check (source in ('offer', 'contract', 'typed')),
  state text not null default 'open' check (state in ('open', 'satisfied', 'waived', 'expired')),
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  document_id uuid,
  note text check (note is null or length(btrim(note)) between 1 and 1000),
  -- Recorded without the signed form: by an owner or admin, with why.
  override_reason text check (override_reason is null or length(btrim(override_reason)) between 1 and 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((state = 'open') = (resolved_at is null)),
  check ((kind = 'other') = (end_key is null)),
  check (kind <> 'other' or (label is not null and ends_on is not null)),
  check (kind = 'other' or ends_on is null),
  check (state = 'open' or document_id is not null or override_reason is not null),
  foreign key (workspace_id, document_id) references addon_realestate.documents (workspace_id, id)
    on delete set null (document_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
-- One of each named kind on a deal; as many of the agent's own as they need.
create unique index contingencies_one_of_each on addon_realestate.contingencies (deal_record_id, kind)
  where kind <> 'other';
create index contingencies_deal_idx on addon_realestate.contingencies (workspace_id, deal_record_id, created_at);
create index contingencies_open_idx on addon_realestate.contingencies (workspace_id)
  where state = 'open';
create index contingencies_document_idx on addon_realestate.contingencies (document_id)
  where document_id is not null;
create index contingencies_resolved_by_idx on addon_realestate.contingencies (resolved_by)
  where resolved_by is not null;
create index contingencies_created_by_idx on addon_realestate.contingencies (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_realestate.contingencies', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The client sees each of their contingencies and how it ended; never the agent's note or a reason.
select private.addon_portal_policies('addon_realestate.contingencies', 'deal_record_id',
  array['id', 'kind', 'label', 'end_key', 'ends_on', 'state', 'resolved_at', 'created_at']);

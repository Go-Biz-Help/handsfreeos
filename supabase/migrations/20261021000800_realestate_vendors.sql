-- =============================================================================
-- Real Estate Agent, round five, step 9: the vendors directory.
--
--        Chris's plan (2026-10-02): the business's own list of the people its
--        deals use (inspectors, photographers, stagers, contractors, lenders,
--        title), each with their services, areas, approval and any
--        disclosure. The agent picks one on a duty; their quote and
--        appointment attach to it, and their report comes back as the duty's
--        proof through Documents, as any document does.
--
--        **A vendor is a company.** Core's companies hold their name, people,
--        timeline and files; this keeps only what the add-on knows about them.
--        Nothing in core points here.
--
--        **Every vendor that fits, not only one.** The client is offered the
--        approved vendors for the service, each with its disclosure (an
--        affiliation, a referral fee) in words.
-- =============================================================================

create table addon_realestate.vendors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  company_id uuid not null references app.companies (id) on delete cascade,
  services text[] not null check (
    cardinality(services) between 1 and 9
    and services <@ array['inspection', 'hvac', 'repairs', 'photos', 'staging', 'lender', 'title', 'insurance',
                          'other']),
  -- Where they work, as people say it: "Austin", "Round Rock", "Texas".
  areas text[] not null default '{}' check (cardinality(areas) <= 20),
  approved boolean not null default false,
  approved_by uuid references app.users (id) on delete set null,
  approved_at timestamptz,
  -- An affiliation or referral fee the client must be told of.
  disclosure text check (disclosure is null or length(btrim(disclosure)) between 1 and 500),
  note text check (note is null or length(btrim(note)) between 1 and 1000),
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, company_id),
  check (approved = (approved_at is not null))
);
create index vendors_company_idx on addon_realestate.vendors (company_id);
create index vendors_services_idx on addon_realestate.vendors using gin (services);
create index vendors_approved_by_idx on addon_realestate.vendors (approved_by) where approved_by is not null;
create index vendors_archived_by_idx on addon_realestate.vendors (archived_by) where archived_by is not null;
create index vendors_created_by_idx on addon_realestate.vendors (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.vendors', 'realestate.use', 'realestate.use', null, null);

-- A vendor picked on a duty, with their quote and appointment. Let go of, it stays as it was, marked.
create table addon_realestate.duty_vendors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  duty_id uuid not null,
  vendor_id uuid not null,
  service text not null check (service in ('inspection', 'hvac', 'repairs', 'photos', 'staging', 'lender',
                                           'title', 'insurance', 'other')),
  quote_cents bigint check (quote_cents is null or quote_cents between 0 and 100000000000),
  quote_document_id uuid,
  appointment_id uuid references app.appointments (id) on delete set null,
  note text check (note is null or length(btrim(note)) between 1 and 1000),
  picked_by uuid references app.users (id) on delete set null,
  picked_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references app.users (id) on delete set null,
  removed_reason text check (removed_reason is null or length(btrim(removed_reason)) between 1 and 500),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade,
  foreign key (workspace_id, duty_id) references addon_realestate.duties (workspace_id, id) on delete cascade,
  foreign key (workspace_id, vendor_id) references addon_realestate.vendors (workspace_id, id) on delete cascade,
  foreign key (workspace_id, quote_document_id) references addon_realestate.documents (workspace_id, id)
    on delete set null (quote_document_id),
  check ((removed_at is null) = (removed_reason is null))
);
create unique index duty_vendors_one_idx on addon_realestate.duty_vendors (duty_id, vendor_id) where removed_at is null;
create index duty_vendors_deal_idx on addon_realestate.duty_vendors (workspace_id, deal_record_id);
create index duty_vendors_vendor_idx on addon_realestate.duty_vendors (workspace_id, vendor_id, picked_at desc);
create index duty_vendors_document_idx on addon_realestate.duty_vendors (workspace_id, quote_document_id)
  where quote_document_id is not null;
create index duty_vendors_appointment_idx on addon_realestate.duty_vendors (appointment_id)
  where appointment_id is not null;
create index duty_vendors_picked_by_idx on addon_realestate.duty_vendors (picked_by) where picked_by is not null;
create index duty_vendors_removed_by_idx on addon_realestate.duty_vendors (removed_by) where removed_by is not null;
select private.addon_table_policies('addon_realestate.duty_vendors', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

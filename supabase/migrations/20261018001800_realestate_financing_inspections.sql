-- =============================================================================
-- Real Estate Agent, round two, step 11: financing, inspections and repairs.
--
--        Chris decided (2026-09-30): the agent and coordinator mark each
--        financing step, with proof (the lender's letter or email, or a
--        document): preapproval, application, rate lock, appraisal,
--        conditional approval, clear to close, the Closing Disclosure and
--        funding. The lender's own connector comes later (round five).
--
--        **financing**: the deal's lender, loan officer and loan.
--        **financing_steps**: each step's dates, amounts and rate, and its
--        proof once done.
--        **inspections**: each inspection, its inspector, when, and its
--        report. **inspection_findings**: what each found, how serious, the
--        estimate, the client's priority and what to ask for.
--        **repair_requests**: each version of the request and the seller's
--        answers, kept as they were sent.
--
--        The client's portal reads where things stand (the steps, the
--        inspections and findings, the request), never the team's notes or
--        the proof.
-- =============================================================================

create table addon_realestate.financing (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  lender_name text check (lender_name is null or length(lender_name) <= 200),
  officer_name text check (officer_name is null or length(officer_name) <= 200),
  officer_email text check (officer_email is null or length(officer_email) <= 320),
  officer_phone text check (officer_phone is null or length(officer_phone) <= 40),
  loan_type text check (loan_type is null or loan_type in ('conventional', 'fha', 'va', 'usda', 'cash', 'other')),
  loan_amount_cents bigint check (loan_amount_cents is null or loan_amount_cents > 0),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (workspace_id, deal_record_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index financing_updated_by_idx on addon_realestate.financing (updated_by) where updated_by is not null;
select private.addon_table_policies('addon_realestate.financing', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

create table addon_realestate.financing_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  step text not null check (step in ('preapproval', 'application', 'rate_lock', 'appraisal', 'conditional_approval',
    'clear_to_close', 'closing_disclosure', 'funding')),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'done')),
  started_on date,
  expected_on date,
  done_on date,
  -- The preapproval's "up to", or the appraised value.
  amount_cents bigint check (amount_cents is null or amount_cents > 0),
  -- The locked rate, in percent.
  rate numeric(6, 3) check (rate is null or rate between 0 and 30),
  -- When the preapproval or the rate lock ends.
  expires_on date,
  note text check (note is null or length(note) <= 1000),
  -- Done only with proof: one of the deal's documents, a file on it, or the lender's message.
  proof_kind text check (proof_kind is null or proof_kind in ('document', 'file', 'message')),
  proof_id uuid,
  done_by uuid references app.users (id) on delete set null,
  done_at timestamptz,
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (deal_record_id, step),
  check ((status = 'done') = (done_at is not null)),
  check ((status = 'done') = (proof_kind is not null)),
  check ((proof_kind is null) = (proof_id is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index financing_steps_deal_idx on addon_realestate.financing_steps (workspace_id, deal_record_id);
create index financing_steps_done_by_idx on addon_realestate.financing_steps (done_by) where done_by is not null;
create index financing_steps_updated_by_idx on addon_realestate.financing_steps (updated_by)
  where updated_by is not null;
select private.addon_table_policies('addon_realestate.financing_steps', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.financing_steps', 'deal_record_id',
  array['id', 'step', 'status', 'expected_on', 'done_on']);

create table addon_realestate.inspections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null check (kind in ('general', 'termite', 'roof', 'sewer', 'radon', 'mold', 'pool', 'hvac',
    'structural', 'other')),
  inspector text check (inspector is null or length(inspector) <= 200),
  scheduled_at timestamptz,
  report_expected_on date,
  status text not null default 'scheduled' check (status in ('scheduled', 'report_in', 'canceled')),
  report_document_id uuid references addon_realestate.documents (id) on delete set null,
  report_in_on date,
  pages integer check (pages is null or pages between 1 and 2000),
  note text check (note is null or length(note) <= 1000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((status = 'report_in') = (report_in_on is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index inspections_deal_idx on addon_realestate.inspections (workspace_id, deal_record_id);
create index inspections_report_idx on addon_realestate.inspections (report_document_id)
  where report_document_id is not null;
create index inspections_created_by_idx on addon_realestate.inspections (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.inspections', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.inspections', 'deal_record_id',
  array['id', 'kind', 'inspector', 'scheduled_at', 'report_expected_on', 'status', 'report_in_on']);

create table addon_realestate.inspection_findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  inspection_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  location text check (location is null or length(location) <= 200),
  severity text not null check (severity in ('safety', 'repair', 'minor')),
  estimate_cents bigint check (estimate_cents is null or estimate_cents >= 0),
  -- What the client wants done about it.
  client_priority text check (client_priority is null or client_priority in ('must_fix', 'would_like', 'skip')),
  ask text not null default 'not_asked' check (ask in ('repair', 'replace', 'credit', 'not_asked')),
  credit_cents bigint check (credit_cents is null or credit_cents >= 0),
  position integer not null check (position between 1 and 500),
  note text check (note is null or length(note) <= 1000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, inspection_id) references addon_realestate.inspections (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index inspection_findings_inspection_idx on addon_realestate.inspection_findings
  (workspace_id, inspection_id, position);
create index inspection_findings_deal_idx on addon_realestate.inspection_findings (workspace_id, deal_record_id);
create index inspection_findings_created_by_idx on addon_realestate.inspection_findings (created_by)
  where created_by is not null;
-- A finding typed in by mistake is simply taken off.
select private.addon_table_policies('addon_realestate.inspection_findings', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');
select private.addon_portal_policies('addon_realestate.inspection_findings', 'deal_record_id',
  array['id', 'inspection_id', 'title', 'location', 'severity', 'estimate_cents', 'client_priority', 'ask',
    'credit_cents', 'position']);

create table addon_realestate.repair_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  number integer not null check (number >= 1),
  -- Our request, or the seller's answer.
  side text not null check (side in ('us', 'them')),
  at timestamptz not null default now(),
  words text not null check (length(btrim(words)) between 1 and 4000),
  -- What it asks for, by finding: [{"findingId", "title", "ask", "creditCents"}].
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 100),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  respond_by timestamptz,
  outcome text check (outcome is null or outcome in ('agreed', 'countered', 'refused')),
  note text check (note is null or length(note) <= 1000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (deal_record_id, number),
  check ((side = 'them') = (outcome is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index repair_requests_deal_idx on addon_realestate.repair_requests (workspace_id, deal_record_id, number);
create index repair_requests_created_by_idx on addon_realestate.repair_requests (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_realestate.repair_requests', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- Kept as it was sent.
create trigger repair_requests_append_only before update on addon_realestate.repair_requests
  for each row execute function private.forbid_change();
select private.addon_portal_policies('addon_realestate.repair_requests', 'deal_record_id',
  array['id', 'number', 'side', 'at', 'words', 'items', 'credit_cents', 'respond_by', 'outcome']);

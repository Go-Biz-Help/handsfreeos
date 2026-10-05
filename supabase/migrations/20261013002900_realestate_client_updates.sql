-- =============================================================================
-- Real Estate Agent, step 13: client updates and their fair-housing checks.
--
--        HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md ("The Assistant and
--        client updates"). At a milestone, or when the agent asks, the worker
--        drafts a status email to the client from the deal's own facts; the
--        agent edits it and sends it through core's message.send. Every draft
--        is checked twice for fair-housing risk (a fixed list of words, and
--        the model), and flags must be fixed or confirmed with a reason
--        before it goes. Every check is kept.
--
--        **drafts**: one client update, from requested to sent or discarded,
--        with the facts the model was given (never notes) and the model.
--        **fair_housing_checks**: each check of a draft's words, append-only:
--        which list (and version) or model, what it found, and a digest of the
--        exact text it read, so a check always matches what was sent.
-- =============================================================================

create table addon_realestate.drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null default 'status_update' check (kind in ('status_update')),
  -- The milestone it's for, or asked: someone asked for one.
  milestone text not null check (milestone in ('under_contract', 'inspection_done', 'clear_to_close', 'closed',
    'asked')),
  -- The client it's to.
  person_id uuid references app.people (id) on delete set null,
  subject text check (subject is null or length(subject) <= 200),
  body text check (body is null or length(body) <= 10000),
  status text not null default 'drafting' check (status in ('drafting', 'ready', 'sent', 'discarded', 'failed')),
  failure text check (failure is null or length(failure) <= 500),
  -- What the model was given, and which model wrote it.
  facts jsonb check (facts is null or (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 16384)),
  model text check (model is null or length(model) <= 100),
  requested_by uuid references app.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  edited_by uuid references app.users (id) on delete set null,
  edited_at timestamptz,
  -- Fair-housing flags confirmed by a person, with why.
  flags_acknowledged_by uuid references app.users (id) on delete set null,
  flags_acknowledged_at timestamptz,
  flags_acknowledged_reason text check (flags_acknowledged_reason is null or length(flags_acknowledged_reason) <= 500),
  sent_message_id uuid references app.messages (id) on delete set null,
  sent_by uuid references app.users (id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (status <> 'ready' or (subject is not null and body is not null)),
  check ((status = 'sent') = (sent_at is not null)),
  check ((status = 'failed') = (failure is not null)),
  check ((flags_acknowledged_at is null) = (flags_acknowledged_reason is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index drafts_deal_idx on addon_realestate.drafts (workspace_id, deal_record_id, requested_at);
create index drafts_person_idx on addon_realestate.drafts (person_id) where person_id is not null;
create index drafts_requested_by_idx on addon_realestate.drafts (requested_by) where requested_by is not null;
create index drafts_edited_by_idx on addon_realestate.drafts (edited_by) where edited_by is not null;
create index drafts_acknowledged_by_idx on addon_realestate.drafts (flags_acknowledged_by)
  where flags_acknowledged_by is not null;
create index drafts_message_idx on addon_realestate.drafts (sent_message_id) where sent_message_id is not null;
create index drafts_sent_by_idx on addon_realestate.drafts (sent_by) where sent_by is not null;
select private.addon_table_policies('addon_realestate.drafts', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

create table addon_realestate.fair_housing_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  draft_id uuid not null,
  -- The fixed list of words and phrases, or the model.
  source text not null check (source in ('words', 'model')),
  -- The list's version, or the model's name.
  version text not null check (length(version) between 1 and 100),
  -- passed, flagged, or unavailable (the model couldn't be asked).
  status text not null check (status in ('passed', 'flagged', 'unavailable')),
  flags jsonb not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array' and pg_column_size(flags) <= 16384),
  -- A digest of the subject and body it read.
  text_hash text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz not null default now(),
  check (status <> 'passed' or flags = '[]'::jsonb),
  foreign key (workspace_id, draft_id) references addon_realestate.drafts (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index fair_housing_checks_draft_idx on addon_realestate.fair_housing_checks (workspace_id, draft_id, checked_at);
create index fair_housing_checks_deal_idx on addon_realestate.fair_housing_checks (workspace_id, deal_record_id);
select private.addon_table_policies('addon_realestate.fair_housing_checks', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
create trigger fair_housing_checks_append_only before update on addon_realestate.fair_housing_checks
  for each row execute function private.forbid_change();

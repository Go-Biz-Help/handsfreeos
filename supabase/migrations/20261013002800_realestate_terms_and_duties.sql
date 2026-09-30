-- =============================================================================
-- Real Estate Agent, step 8: terms, the duty list, duties and documents.
--
--        HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md ("Duties", "Dates",
--        "Documents"). Every table follows its deal's privacy through its
--        record column (addon_table_policies), as step 6's do.
--
--        **term_entries**: each key date or term as it was entered, never
--        changed: its value, where it came from and where in the document,
--        who entered and who confirmed it. An amendment or correction
--        supersedes an entry; two live entries that disagree are a conflict
--        that waits for a person (never resolved silently).
--        **template_sets / template_items**: a business's published duty list,
--        each version keeping every item's resolved definition, so a deal
--        replays exactly; **template_overrides / custom_templates** are the
--        editor's unpublished changes (step 12). No version: the catalog's.
--        **duties**: each duty on a deal, with its due time and the trace that
--        produced it; **duty_links** (what waits on what), **duty_evidence**
--        (proof added) and **duty_log** (every change, append-only).
--        **documents**: a core file on the deal with its kind, version lineage,
--        status and whether it's the one that counts.
-- =============================================================================

-- ---------- deals: facts, and the duty list they were opened with ----------
alter table addon_realestate.deals
  add column facts text[] not null default '{}' check (facts <@ array[
    'financed', 'first_time_buyer', 'hoa', 'survey', 'well', 'septic', 'solar', 'pool', 'propane',
    'private_road', 'specialists_needed', 'multiple_offers', 'open_house', 'backup_offer',
    'seller_has_mortgage', 'home_warranty', 'relocation', 'wants_move_help', 'linked_sale']::text[]),
  -- The published duty list it follows; null is the catalog's own (CATALOG_VERSION in core).
  add column template_set_id uuid,
  add column catalog_version integer not null default 1;

-- ---------- terms ----------
create table addon_realestate.term_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- A key date (closing, inspection_end…) or a money term (price, emd_amount…).
  key text not null check (key ~ '^[a-z][a-z_]{0,39}$'),
  value_date date,
  value_time text check (value_time is null or value_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  value_cents bigint check (value_cents is null or value_cents >= 0),
  value_text text check (value_text is null or length(value_text) <= 500),
  source text not null check (source in ('contract', 'amendment', 'counter', 'addendum', 'correction',
    'lender', 'title', 'agreement', 'typed')),
  -- Where in the document ("§7(b)", "page 3").
  source_ref text check (source_ref is null or length(source_ref) <= 200),
  document_id uuid,
  note text check (note is null or length(note) <= 1000),
  entered_by uuid references app.users (id) on delete set null,
  entered_at timestamptz not null default now(),
  confirmed_by uuid references app.users (id) on delete set null,
  confirmed_at timestamptz,
  -- Replaced by a later entry (an amendment, a correction), or set aside when a conflict was settled.
  superseded_by uuid,
  superseded_at timestamptz,
  rejected_by uuid references app.users (id) on delete set null,
  rejected_at timestamptz,
  rejected_reason text check (rejected_reason is null or length(rejected_reason) <= 500),
  created_at timestamptz not null default now(),
  check (num_nonnulls(value_date, value_cents, value_text) = 1),
  check (value_time is null or value_date is not null),
  check ((confirmed_at is null) = (confirmed_by is null)),
  check ((rejected_at is null) = (rejected_reason is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index term_entries_deal_idx on addon_realestate.term_entries (workspace_id, deal_record_id, key, entered_at);
create index term_entries_entered_by_idx on addon_realestate.term_entries (entered_by) where entered_by is not null;
create index term_entries_confirmed_by_idx on addon_realestate.term_entries (confirmed_by)
  where confirmed_by is not null;
create index term_entries_rejected_by_idx on addon_realestate.term_entries (rejected_by)
  where rejected_by is not null;

-- What was entered stays as it was: only confirming, superseding and rejecting are ever written, once each.
create or replace function addon_realestate.guard_term_entry()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - array['confirmed_by', 'confirmed_at', 'superseded_by', 'superseded_at', 'rejected_by',
                            'rejected_at', 'rejected_reason'])
     is distinct from (to_jsonb(old) - array['confirmed_by', 'confirmed_at', 'superseded_by', 'superseded_at',
                                             'rejected_by', 'rejected_at', 'rejected_reason']) then
    raise exception 'What was entered stays as it was: enter a correction instead'
      using errcode = '42501', detail = 'realestate_term_fixed';
  end if;
  if (old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at)
     or (old.rejected_at is not null and new.rejected_at is distinct from old.rejected_at) then
    raise exception 'That entry was already settled' using errcode = '42501', detail = 'realestate_term_settled';
  end if;
  return new;
end $$;
create trigger term_entries_guard before update on addon_realestate.term_entries
  for each row execute function addon_realestate.guard_term_entry();

select private.addon_table_policies('addon_realestate.term_entries', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

-- ---------- the duty list: published versions, and the editor's changes ----------
create table addon_realestate.template_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  version integer not null check (version >= 1),
  -- The catalog it was built on.
  catalog_version integer not null,
  note text check (note is null or length(note) <= 500),
  published_by uuid references app.users (id) on delete set null,
  published_at timestamptz not null default now(),
  unique (workspace_id, version),
  unique (workspace_id, id)
);
create index template_sets_published_by_idx on addon_realestate.template_sets (published_by)
  where published_by is not null;
select private.addon_table_policies('addon_realestate.template_sets', 'realestate.use', 'realestate.manage');

create table addon_realestate.template_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  template_set_id uuid not null,
  -- A catalog row's id (B-01) or one of the business's own (C-01).
  duty_key text not null check (duty_key ~ '^[BSXC]-[0-9]{2,3}$'),
  enabled boolean not null default true,
  -- The duty resolved (ResolvedDuty in core): what a deal on this version gets.
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 16384),
  unique (template_set_id, duty_key),
  foreign key (workspace_id, template_set_id) references addon_realestate.template_sets (workspace_id, id)
    on delete cascade
);
create index template_items_set_idx on addon_realestate.template_items (workspace_id, template_set_id);
select private.addon_table_policies('addon_realestate.template_items', 'realestate.use', 'realestate.manage');
-- A published version never changes.
create trigger template_items_fixed before update on addon_realestate.template_items
  for each row execute function private.forbid_change();

-- A version is never deleted while its business is kept; if one ever goes, its deals fall back to the catalog.
alter table addon_realestate.deals
  add constraint deals_template_set_fkey foreign key (workspace_id, template_set_id)
    references addon_realestate.template_sets (workspace_id, id) on delete set null (template_set_id);
create index deals_template_set_idx on addon_realestate.deals (workspace_id, template_set_id)
  where template_set_id is not null;

create table addon_realestate.template_overrides (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  duty_key text not null check (duty_key ~ '^[BSX]-[0-9]{2}$'),
  enabled boolean not null default true,
  -- Only what differs from the catalog's row: timing, reminders, who answers, proof.
  patch jsonb not null default '{}'::jsonb check (jsonb_typeof(patch) = 'object' and pg_column_size(patch) <= 8192),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, duty_key)
);
create index template_overrides_updated_by_idx on addon_realestate.template_overrides (updated_by)
  where updated_by is not null;
select private.addon_table_policies('addon_realestate.template_overrides', 'realestate.manage', 'realestate.manage',
  'realestate.manage');

create table addon_realestate.custom_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  duty_key text not null check (duty_key ~ '^C-[0-9]{2,3}$'),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 16384),
  archived_at timestamptz,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, duty_key)
);
create index custom_templates_updated_by_idx on addon_realestate.custom_templates (updated_by)
  where updated_by is not null;
select private.addon_table_policies('addon_realestate.custom_templates', 'realestate.manage', 'realestate.manage');

-- ---------- duties ----------
create table addon_realestate.duties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  duty_key text not null check (duty_key ~ '^[BSXCW]-[0-9]{2,3}$'),
  -- Each time through (a second offer, a recurring check-in): 1, 2, …
  pass integer not null default 1 check (pass >= 1),
  title text not null check (length(btrim(title)) between 1 and 200),
  tracker text not null check (tracker ~ '^[A-Z]{3,10}$'),
  status text not null check (status in ('draft', 'pending_approval', 'not_started', 'in_progress',
    'waiting_external', 'blocked', 'completed', 'waived', 'cancelled')),
  materiality text not null check (materiality in ('standard', 'material', 'critical')),
  automation text not null check (automation in ('A0', 'A1', 'A2', 'A3', 'A4', 'AX')),
  accountable_role text not null check (accountable_role in ('agent', 'coordinator', 'broker')),
  -- The person answering for it; null with the broker role is the owners and admins.
  accountable_user_id uuid references app.users (id) on delete set null,
  performers text[] not null default '{}',
  -- Its definition as the deal's duty list had it (a catalog row resolved, or a published item).
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 16384),
  -- What created it, and when.
  started_by text not null check (started_by ~ '^(stage|dates|event|manual):[a-z_]{1,40}$'),
  started_at timestamptz not null,
  -- When it's due, as last worked out (dates/due.ts): its state, the moment, and the trace that replays it.
  due_state text not null check (due_state in ('due', 'none', 'waiting')),
  due_at timestamptz,
  due_date date,
  due_time text check (due_time is null or due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  due_trace jsonb not null default '[]'::jsonb check (jsonb_typeof(due_trace) = 'array'),
  due_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(due_warnings) = 'array'),
  -- Key dates it rests on that aren't confirmed, or aren't in.
  needs_dates text[] not null default '{}',
  -- A person moved it by hand, with why (step 9).
  due_override_at timestamptz,
  due_override_reason text check (due_override_reason is null or length(due_override_reason) <= 500),
  -- Blocked: by what, whose it is to clear, what it holds up, and when to look again.
  blocker text check (blocker is null or length(blocker) <= 500),
  blocker_owner text check (blocker_owner is null or length(blocker_owner) <= 200),
  blocker_impact text check (blocker_impact is null or length(blocker_impact) <= 500),
  blocker_review_at timestamptz,
  -- Waiting on someone: who.
  waiting_on text check (waiting_on is null or length(waiting_on) <= 200),
  finished_at timestamptz,
  finished_by uuid references app.users (id) on delete set null,
  -- Done without its proof, waived or cancelled: why (and who allowed it).
  finish_reason text check (finish_reason is null or length(finish_reason) <= 1000),
  exception boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deal_record_id, duty_key, pass),
  unique (workspace_id, id),
  check ((status in ('completed', 'waived', 'cancelled')) = (finished_at is not null)),
  check (status <> 'blocked' or (blocker is not null and blocker_owner is not null and blocker_review_at is not null)),
  check (status <> 'waiting_external' or waiting_on is not null),
  check (not exception or status = 'completed'),
  check ((due_override_at is null) = (due_override_reason is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index duties_deal_idx on addon_realestate.duties (workspace_id, deal_record_id);
create index duties_open_due_idx on addon_realestate.duties (workspace_id, due_at)
  where status in ('not_started', 'in_progress', 'waiting_external', 'blocked');
create index duties_accountable_idx on addon_realestate.duties (accountable_user_id)
  where accountable_user_id is not null;
create index duties_finished_by_idx on addon_realestate.duties (finished_by) where finished_by is not null;
create index duties_acknowledged_by_idx on addon_realestate.duties (acknowledged_by)
  where acknowledged_by is not null;
select private.addon_table_policies('addon_realestate.duties', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

-- Its person answering for it works in the business and, the deal being private, is on it or sees it whole.
create or replace function addon_realestate.check_duty_person()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.accountable_user_id is not null
     and (tg_op = 'INSERT' or new.accountable_user_id is distinct from old.accountable_user_id)
     and not private.user_sees_record(new.accountable_user_id, new.deal_record_id) then
    raise exception 'Only someone on the deal can answer for its duties'
      using errcode = '23514', detail = 'realestate_duty_person_not_on_deal';
  end if;
  return new;
end $$;
create trigger duties_person before insert or update of accountable_user_id on addon_realestate.duties
  for each row execute function addon_realestate.check_duty_person();

create table addon_realestate.duty_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  duty_id uuid not null,
  -- It waits on this one.
  depends_on_id uuid not null,
  kind text not null check (kind in ('finish_to_start', 'evidence', 'approval', 'external', 'exclusive')),
  created_at timestamptz not null default now(),
  unique (duty_id, depends_on_id),
  check (duty_id <> depends_on_id),
  foreign key (workspace_id, duty_id) references addon_realestate.duties (workspace_id, id) on delete cascade,
  foreign key (workspace_id, depends_on_id) references addon_realestate.duties (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index duty_links_duty_idx on addon_realestate.duty_links (workspace_id, duty_id);
create index duty_links_depends_idx on addon_realestate.duty_links (workspace_id, depends_on_id);
create index duty_links_deal_idx on addon_realestate.duty_links (workspace_id, deal_record_id);
select private.addon_table_policies('addon_realestate.duty_links', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');

-- ---------- documents ----------
create table addon_realestate.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  file_id uuid not null references app.files (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z_]{0,39}$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  -- Versions: the first one's id names the line, and each later one the version it replaces.
  lineage_id uuid not null,
  version integer not null default 1 check (version >= 1),
  supersedes_id uuid,
  status text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'superseded', 'void')),
  -- The one that counts, of its kind on this deal (the controlling contract, say).
  controlling boolean not null default false,
  signed_at timestamptz,
  signed_by uuid references app.users (id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references app.users (id) on delete set null,
  void_reason text check (void_reason is null or length(void_reason) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (lineage_id, version),
  -- Signed stays signed when a later version replaces it or it's voided; a draft or a sent one isn't.
  check (status <> 'signed' or signed_at is not null),
  check (status not in ('draft', 'sent') or signed_at is null),
  check ((status = 'void') = (voided_at is not null)),
  check ((signed_at is null) = (signed_by is null) or signed_by is null),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index documents_deal_idx on addon_realestate.documents (workspace_id, deal_record_id, kind);
create index documents_file_idx on addon_realestate.documents (file_id);
create unique index documents_one_controlling on addon_realestate.documents (deal_record_id, kind)
  where controlling;
create index documents_signed_by_idx on addon_realestate.documents (signed_by) where signed_by is not null;
create index documents_voided_by_idx on addon_realestate.documents (voided_by) where voided_by is not null;
create index documents_created_by_idx on addon_realestate.documents (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.documents', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

-- A document is a file on its own deal.
create or replace function addon_realestate.check_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
      select 1 from app.files f
      where f.id = new.file_id and f.workspace_id = new.workspace_id
        and f.record_type = 'custom_record' and f.record_id = new.deal_record_id) then
    raise exception 'A deal''s document is one of the deal''s own files'
      using errcode = '23514', detail = 'realestate_document_not_on_deal';
  end if;
  return new;
end $$;
create trigger documents_check before insert or update of file_id, deal_record_id on addon_realestate.documents
  for each row execute function addon_realestate.check_document();

-- Term entries may point at the document they came from.
alter table addon_realestate.term_entries
  add constraint term_entries_document_fkey foreign key (workspace_id, document_id)
    references addon_realestate.documents (workspace_id, id) on delete cascade;
create index term_entries_document_idx on addon_realestate.term_entries (workspace_id, document_id)
  where document_id is not null;

-- ---------- proof, and each duty's history ----------
create table addon_realestate.duty_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  duty_id uuid not null,
  kind text not null check (kind in ('document', 'file', 'note', 'attestation', 'appointment', 'message',
    'dates', 'deal_field')),
  document_id uuid,
  file_id uuid references app.files (id) on delete set null,
  appointment_id uuid references app.appointments (id) on delete set null,
  message_id uuid references app.messages (id) on delete set null,
  body text check (body is null or length(body) <= 4000),
  added_by uuid references app.users (id) on delete set null,
  added_at timestamptz not null default now(),
  -- Taken back, with why: it stays in history.
  withdrawn_at timestamptz,
  withdrawn_by uuid references app.users (id) on delete set null,
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) <= 500),
  check ((withdrawn_at is null) = (withdrawn_reason is null)),
  foreign key (workspace_id, duty_id) references addon_realestate.duties (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id) references addon_realestate.documents (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index duty_evidence_duty_idx on addon_realestate.duty_evidence (workspace_id, duty_id);
create index duty_evidence_deal_idx on addon_realestate.duty_evidence (workspace_id, deal_record_id);
create index duty_evidence_document_idx on addon_realestate.duty_evidence (workspace_id, document_id)
  where document_id is not null;
create index duty_evidence_file_idx on addon_realestate.duty_evidence (file_id) where file_id is not null;
create index duty_evidence_appointment_idx on addon_realestate.duty_evidence (appointment_id)
  where appointment_id is not null;
create index duty_evidence_message_idx on addon_realestate.duty_evidence (message_id) where message_id is not null;
create index duty_evidence_added_by_idx on addon_realestate.duty_evidence (added_by) where added_by is not null;
create index duty_evidence_withdrawn_by_idx on addon_realestate.duty_evidence (withdrawn_by)
  where withdrawn_by is not null;
select private.addon_table_policies('addon_realestate.duty_evidence', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

create table addon_realestate.duty_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  duty_id uuid not null,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('person', 'system', 'ai')),
  actor_user_id uuid references app.users (id) on delete set null,
  what text not null check (what ~ '^[a-z][a-z_]{0,39}$'),
  before jsonb check (before is null or pg_column_size(before) <= 16384),
  after jsonb check (after is null or pg_column_size(after) <= 16384),
  note text check (note is null or length(note) <= 1000),
  foreign key (workspace_id, duty_id) references addon_realestate.duties (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index duty_log_duty_idx on addon_realestate.duty_log (workspace_id, duty_id, at);
create index duty_log_deal_idx on addon_realestate.duty_log (workspace_id, deal_record_id);
create index duty_log_actor_idx on addon_realestate.duty_log (actor_user_id) where actor_user_id is not null;
select private.addon_table_policies('addon_realestate.duty_log', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
create trigger duty_log_append_only before update on addon_realestate.duty_log
  for each row execute function private.forbid_change();

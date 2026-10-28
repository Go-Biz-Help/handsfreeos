-- =============================================================================
-- Documents and e-signatures, part 1: templates from a PDF, and signing
-- (docs/documents.md; the owner's answers of 28 October 2026).
--
--        A business's own DocuSign. Part of HandsFreeOS itself, not an add-on
--        (answer 1a), as Documents in the side menu.
--
--        - **A template** is a PDF with fields placed on it (signature, date,
--          name, text, a checkbox…), each for one of its signers ("Customer",
--          "Us"), words of the PDF typed over (26c), and its settings: in
--          order or all at once, a code first, reminders and the expiry. The
--          PDF is a file whose record is the template (record type
--          `document`, 20261027015100). documents.manage (owners and admins)
--          makes them; everyone reads them.
--        - **A document** is one sent copy: the template's definition as it
--          was sent, with that customer's own changes (27a), on the record
--          it's about (a customer, a company, a lead or a record), whose
--          signed copy is filed there, locked. documents.send (everyone who
--          can see customers) sends one, and voids one; the rest is the
--          worker's, for the people signing.
--        - **Who signs** (document_signers): each one's own link,
--          /d/<public_ref><code>, signed by the worker's key, so nothing
--          secret is kept; raising `link_version` retires it.
--        - **What they filled in** (document_values), and **the proof**
--          (document_steps): when each link went out, was opened, the code
--          checked, "I agree to sign electronically" ticked, signed or
--          declined, with the address and device, append-only.
--        - **A document out for signing stops its customer's delete** until
--          it's voided (`bin_document_out`); a signed copy already does
--          (`bin_signed_file`). Documents of a record in the Deleted bin are
--          hidden with it, and go with it when it's emptied.
--
-- Only adds: two permissions, five tables, the template file's rules, three
-- lookups for the worker, a phone switch and one more reason the Deleted bin
-- refuses.
-- =============================================================================

-- ---------- the permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'documents.manage'),
  ('admin', 'documents.manage'),
  ('owner', 'documents.send'),
  ('admin', 'documents.send'),
  ('member', 'documents.send');
insert into app.customizable_permissions (permission, requires) values
  ('documents.manage', '{}'),
  ('documents.send', '{records.read}');

-- ---------- templates ----------
create table app.document_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Core's DocumentDefinition: the pages, the signers' roles, the fields, the words typed over, the settings.
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null default 1 check (definition_version >= 1),
  -- Every save raises it. A save names the revision it started from and fails with revision_conflict otherwise.
  revision integer not null default 1 check (revision >= 1),
  -- The PDF it's made from; null until one is added.
  source_file_id uuid references app.files (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id)
);
create index document_templates_list_idx on app.document_templates (workspace_id, archived_at, lower(name));
create index document_templates_source_idx on app.document_templates (source_file_id) where source_file_id is not null;
create index document_templates_created_by_idx on app.document_templates (created_by);
create trigger document_templates_updated_at before update on app.document_templates
  for each row execute function private.set_updated_at();
create trigger document_templates_immutable before update on app.document_templates
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- A template's PDF is a template's file of the same business: its own, or the one it was copied from (a duplicate
-- reads the same PDF, which is only ever replaced, never changed in place).
create or replace function private.check_document_template_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source_file_id is not null and not exists (
      select 1 from app.files f
      where f.id = new.source_file_id and f.workspace_id = new.workspace_id and f.record_type = 'document') then
    raise exception 'That PDF isn''t one of this business''s templates' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger document_templates_check_refs before insert or update of source_file_id on app.document_templates
  for each row execute function private.check_document_template_refs();

-- ---------- documents: one sent copy each ----------
create table app.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  template_id uuid references app.document_templates (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 160),
  -- out: waiting on signatures (and, once all_signed_at is set, on its signed copy). completed: its signed copy is
  -- filed. declined: a signer said no. voided: the business took it back. expired: nobody finished in time.
  status text not null default 'out'
    check (status in ('out', 'completed', 'declined', 'voided', 'expired')),
  -- The template's definition as it was sent, with this customer's own changes. Never changes once sent.
  definition jsonb not null
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null default 1 check (definition_version >= 1),
  source_file_id uuid references app.files (id) on delete set null,
  -- The record it's about, where its signed copy is filed: exactly one.
  person_id uuid references app.people (id) on delete cascade,
  company_id uuid references app.companies (id) on delete cascade,
  lead_id uuid references app.leads (id) on delete cascade,
  custom_record_id uuid references app.custom_records (id) on delete cascade,
  signing_order text not null default 'order' check (signing_order in ('order', 'together')),
  -- The note that goes with the links.
  message text check (message is null or length(message) <= 2000),
  sent_by uuid references app.users (id) on delete set null,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- The first reminder this many days after a link went out, then every so many; null: no reminders.
  remind_after_days integer check (remind_after_days between 1 and 30),
  remind_every_days integer check (remind_every_days between 1 and 30),
  -- Everyone signed: the worker is making the signed copy.
  all_signed_at timestamptz,
  completed_at timestamptz,
  signed_file_id uuid references app.files (id) on delete set null,
  -- The PDF it was made from, and the signed copy, as the worker read them.
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  signed_sha256 text check (signed_sha256 is null or signed_sha256 ~ '^[0-9a-f]{64}$'),
  declined_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references app.users (id) on delete set null,
  void_reason text check (void_reason is null or length(void_reason) <= 500),
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (num_nonnulls(person_id, company_id, lead_id, custom_record_id) = 1),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'voided') = (voided_at is not null)),
  check ((status = 'declined') = (declined_at is not null)),
  check ((status = 'expired') = (expired_at is not null)),
  check (expires_at > sent_at)
);
create index documents_list_idx on app.documents (workspace_id, sent_at desc);
create index documents_out_idx on app.documents (expires_at) where status = 'out';
create index documents_template_idx on app.documents (template_id) where template_id is not null;
create index documents_person_idx on app.documents (person_id) where person_id is not null;
create index documents_company_idx on app.documents (company_id) where company_id is not null;
create index documents_lead_idx on app.documents (lead_id) where lead_id is not null;
create index documents_record_idx on app.documents (custom_record_id) where custom_record_id is not null;
create index documents_source_idx on app.documents (source_file_id) where source_file_id is not null;
create index documents_signed_file_idx on app.documents (signed_file_id) where signed_file_id is not null;
create index documents_sent_by_idx on app.documents (sent_by);
create index documents_voided_by_idx on app.documents (voided_by) where voided_by is not null;
create trigger documents_updated_at before update on app.documents
  for each row execute function private.set_updated_at();
create trigger documents_immutable before update on app.documents
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'template_id', 'definition',
    'person_id', 'company_id', 'lead_id', 'custom_record_id', 'sent_by', 'sent_at', 'source_file_id');

create or replace function private.check_document_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.template_id is not null and not exists (
        select 1 from app.document_templates t where t.id = new.template_id and t.workspace_id = new.workspace_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.company_id is not null and not exists (
        select 1 from app.companies c where c.id = new.company_id and c.workspace_id = new.workspace_id))
     or (new.lead_id is not null and not exists (
        select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
     or (new.custom_record_id is not null and not exists (
        select 1 from app.custom_records r where r.id = new.custom_record_id and r.workspace_id = new.workspace_id))
     or (new.source_file_id is not null and not exists (
        select 1 from app.files f where f.id = new.source_file_id and f.workspace_id = new.workspace_id))
     or (new.signed_file_id is not null and not exists (
        select 1 from app.files f where f.id = new.signed_file_id and f.workspace_id = new.workspace_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger documents_check_refs before insert or update on app.documents
  for each row execute function private.check_document_refs();

-- A person voids a document still out, and nothing else; everything else that happens to it is the worker's.
create or replace function private.guard_document_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if not (old.status = 'out' and new.status = 'voided' and new.voided_by = (select auth.uid())
          and new.voided_at is not null
          and new.name = old.name and new.expires_at = old.expires_at
          and new.all_signed_at is not distinct from old.all_signed_at
          and new.completed_at is null and new.signed_file_id is null
          and new.declined_at is null and new.expired_at is null) then
    raise exception 'A document is only voided by a person, while it''s out for signing'
      using errcode = '42501', detail = 'document_state_transition';
  end if;
  return new;
end $$;
create trigger documents_update_guard before update on app.documents
  for each row execute function private.guard_document_update();

-- ---------- who signs, and who gets a copy ----------
create table app.document_signers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  -- signer: signs. copy: gets the signed copy.
  kind text not null default 'signer' check (kind in ('signer', 'copy')),
  -- The template's role they sign as ("customer"), and its name when sent ("Customer").
  role_key text check (role_key is null or role_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  role_label text check (role_label is null or length(role_label) <= 60),
  -- Their turn, in order (signing in order); signers at the same time all go at once.
  position integer not null default 0 check (position between 0 and 50),
  -- A customer, or someone from the team.
  person_id uuid references app.people (id) on delete set null,
  user_id uuid references app.users (id) on delete set null,
  -- Who they were when it was sent: kept on the proof page whatever changes on the customer later.
  name text not null check (length(btrim(name)) between 1 and 160),
  email text check (email is null or length(email) <= 320),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- waiting: not their turn yet. sent: their link went out. opened: they opened it. signed, declined.
  status text not null default 'waiting'
    check (status in ('waiting', 'sent', 'opened', 'signed', 'declined')),
  -- Their link: /d/<public_ref><code>, the code signed by the worker's key over the id and link_version.
  public_ref text not null default private.new_public_ref() check (public_ref ~ '^[0-9A-Za-z]{8}$'),
  link_version integer not null default 1 check (link_version >= 1),
  -- A 6-digit code by text or email before they see it (answer 11a): only its hash, for ten minutes.
  ask_code boolean not null default false,
  code_hash text check (code_hash is null or length(code_hash) = 64),
  code_expires_at timestamptz,
  code_tries integer not null default 0 check (code_tries >= 0),
  code_checked_at timestamptz,
  -- When their link first went out and last went out (a reminder), how many reminders, and how it reached them.
  sent_at timestamptz,
  last_sent_at timestamptz,
  reminders integer not null default 0 check (reminders >= 0),
  sent_by_channels text[] not null default '{}',
  opened_at timestamptz,
  -- "I agree to sign electronically", word for word as they saw it.
  agreed_at timestamptz,
  agreed_wording text check (agreed_wording is null or length(agreed_wording) <= 4000),
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
  -- Where they signed or declined from.
  ip text check (ip is null or length(ip) <= 64),
  device text check (device is null or length(device) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, document_id) references app.documents (workspace_id, id) on delete cascade,
  check (kind <> 'signer' or role_key is not null),
  check (person_id is null or user_id is null),
  check ((status = 'signed') = (signed_at is not null)),
  check ((status = 'declined') = (declined_at is not null))
);
create unique index document_signers_public_ref_key on app.document_signers (public_ref);
create unique index document_signers_one_per_role on app.document_signers (document_id, role_key)
  where kind = 'signer';
create index document_signers_document_idx on app.document_signers (document_id, position);
create index document_signers_workspace_idx on app.document_signers (workspace_id);
create index document_signers_person_idx on app.document_signers (person_id) where person_id is not null;
create index document_signers_user_idx on app.document_signers (user_id) where user_id is not null;
create index document_signers_due_idx on app.document_signers (last_sent_at) where status in ('sent', 'opened');
create trigger document_signers_updated_at before update on app.document_signers
  for each row execute function private.set_updated_at();
create trigger document_signers_immutable before update on app.document_signers
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'document_id', 'kind',
    'role_key', 'public_ref', 'name', 'email', 'phone_e164', 'position');

create or replace function private.check_document_signer_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.user_id is not null and not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger document_signers_check_refs before insert or update of person_id, user_id on app.document_signers
  for each row execute function private.check_document_signer_refs();

-- ---------- what was filled in ----------
create table app.document_values (
  workspace_id uuid not null,
  document_id uuid not null,
  -- The field's id in the document's definition.
  field_id text not null check (field_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  -- Who filled it; null for what the team filled in before sending.
  signer_id uuid references app.document_signers (id) on delete cascade,
  -- Core's DocumentValue: text, a tick, a date, or a signature's picture.
  value jsonb not null check (pg_column_size(value) <= 400000),
  filled_at timestamptz not null default now(),
  primary key (document_id, field_id),
  foreign key (workspace_id, document_id) references app.documents (workspace_id, id) on delete cascade
);
create index document_values_workspace_idx on app.document_values (workspace_id);
create index document_values_signer_idx on app.document_values (signer_id) where signer_id is not null;

-- A value is what someone filled in, once: the team's before sending, a signer's as they sign.
create or replace function private.guard_document_value_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    raise exception 'What was filled in on a document doesn''t change' using errcode = '42501', detail = 'document_value_kept';
  end if;
  return new;
end $$;
create trigger document_values_update_guard before update on app.document_values
  for each row execute function private.guard_document_value_update();

-- ---------- the proof: every step, append-only ----------
create table app.document_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  signer_id uuid references app.document_signers (id) on delete cascade,
  kind text not null check (kind in ('prepared', 'sent', 'reminded', 'opened', 'code_sent', 'code_checked',
    'agreed', 'signed', 'declined', 'voided', 'expired', 'completed', 'copy_sent')),
  at timestamptz not null default now(),
  -- How it went (email, sms), where from (the address and the device), and anything else worth keeping.
  channel text check (channel is null or channel in ('email', 'sms', 'portal', 'page')),
  ip text check (ip is null or length(ip) <= 64),
  device text check (device is null or length(device) <= 400),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8192),
  by_user_id uuid references app.users (id) on delete set null,
  foreign key (workspace_id, document_id) references app.documents (workspace_id, id) on delete cascade
);
create index document_steps_document_idx on app.document_steps (document_id, at);
create index document_steps_workspace_idx on app.document_steps (workspace_id);
create index document_steps_signer_idx on app.document_steps (signer_id) where signer_id is not null;
create index document_steps_by_user_idx on app.document_steps (by_user_id) where by_user_id is not null;

create or replace function private.guard_document_step_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'A document''s history is never changed' using errcode = '42501', detail = 'document_step_kept';
end $$;
create trigger document_steps_append_only before update on app.document_steps
  for each row execute function private.guard_document_step_update();

-- ---------- RLS ----------
-- Templates: everyone in the business reads them; documents.manage makes and changes them.
alter table app.document_templates enable row level security;
create policy document_templates_select on app.document_templates for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy document_templates_insert on app.document_templates for insert to authenticated
  with check (private.has_permission(workspace_id, 'documents.manage') and created_by = (select auth.uid())
    and archived_at is null);
create policy document_templates_update on app.document_templates for update to authenticated
  using (private.has_permission(workspace_id, 'documents.manage'))
  with check (private.has_permission(workspace_id, 'documents.manage'));
create policy document_templates_service_all on app.document_templates for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.document_templates to authenticated;
grant update (name, definition, definition_version, revision, source_file_id, archived_at, updated_at)
  on app.document_templates to authenticated;
grant select, insert, update, delete on app.document_templates to service_actor;
revoke all on app.document_templates from anon;

-- Documents: whoever can see the record it's about, and nothing in the Deleted bin. documents.send sends and voids.
create or replace function private.document_record_visible(p_person uuid, p_company uuid, p_lead uuid, p_record uuid)
returns boolean language sql stable set search_path = '' as $$
  select (p_person is null or p_person in (select p.id from app.people p where p.bin_item_id is null))
    and (p_company is null or p_company in (select c.id from app.companies c where c.bin_item_id is null))
    and (p_lead is null or p_lead in (select l.id from app.leads l where l.bin_item_id is null))
    and (p_record is null or (private.custom_record_visible(p_record)
      and p_record in (select r.id from app.custom_records r where r.bin_item_id is null)))
$$;
revoke all on function private.document_record_visible(uuid, uuid, uuid, uuid) from public;
grant execute on function private.document_record_visible(uuid, uuid, uuid, uuid) to authenticated, service_actor;

alter table app.documents enable row level security;
create policy documents_select on app.documents for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.document_record_visible(person_id, company_id, lead_id, custom_record_id));
create policy documents_insert on app.documents for insert to authenticated
  with check (private.has_permission(workspace_id, 'documents.send') and sent_by = (select auth.uid())
    and status = 'out' and all_signed_at is null and completed_at is null and signed_file_id is null
    and voided_at is null and declined_at is null and expired_at is null
    and private.document_record_visible(person_id, company_id, lead_id, custom_record_id));
create policy documents_update on app.documents for update to authenticated
  using (private.has_permission(workspace_id, 'documents.send')
    and private.document_record_visible(person_id, company_id, lead_id, custom_record_id))
  with check (private.has_permission(workspace_id, 'documents.send'));
create policy documents_service_all on app.documents for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.documents to authenticated;
grant update (status, voided_at, voided_by, void_reason, updated_at) on app.documents to authenticated;
grant select, insert, update, delete on app.documents to service_actor;
revoke all on app.documents from anon;

-- Signers, values and steps: whoever sees the document. Sending writes them; the rest is the worker's.
alter table app.document_signers enable row level security;
create policy document_signers_select on app.document_signers for select to authenticated
  using (document_id in (select d.id from app.documents d));
create policy document_signers_insert on app.document_signers for insert to authenticated
  with check (private.has_permission(workspace_id, 'documents.send')
    and document_id in (select d.id from app.documents d where d.sent_by = (select auth.uid()) and d.status = 'out')
    and status in ('waiting', 'sent') and link_version = 1 and code_hash is null and code_tries = 0
    and opened_at is null and agreed_at is null and signed_at is null and declined_at is null);
create policy document_signers_service_all on app.document_signers for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.document_signers to authenticated;
grant select, insert, update, delete on app.document_signers to service_actor;
revoke all on app.document_signers from anon;

alter table app.document_values enable row level security;
create policy document_values_select on app.document_values for select to authenticated
  using (document_id in (select d.id from app.documents d));
create policy document_values_insert on app.document_values for insert to authenticated
  with check (private.has_permission(workspace_id, 'documents.send') and signer_id is null
    and document_id in (select d.id from app.documents d where d.sent_by = (select auth.uid()) and d.status = 'out'));
create policy document_values_service_all on app.document_values for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.document_values to authenticated;
grant select, insert, update, delete on app.document_values to service_actor;
revoke all on app.document_values from anon;

alter table app.document_steps enable row level security;
create policy document_steps_select on app.document_steps for select to authenticated
  using (document_id in (select d.id from app.documents d));
create policy document_steps_insert on app.document_steps for insert to authenticated
  with check (private.has_permission(workspace_id, 'documents.send') and by_user_id = (select auth.uid())
    and kind in ('prepared', 'voided') and signer_id is null
    and document_id in (select d.id from app.documents d));
create policy document_steps_service_all on app.document_steps for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.document_steps to authenticated;
grant select, insert, delete on app.document_steps to service_actor;
revoke all on app.document_steps from anon;

-- ---------- the template's PDF: reserved, uploaded and read like a knowledge file, behind documents.manage ----------
-- A template's file has nothing to tag.
alter table app.record_tags
  add constraint record_tags_not_document check (record_type <> 'document');

drop policy files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        else 'records.write'
      end)
    and created_by = (select auth.uid()) and status = 'pending'::app.file_status and deleted_at is null
    and (not sealed or private.custom_record_visible(record_id)));
drop policy files_update on app.files;
create policy files_update on app.files for update to authenticated
  using (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)))
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)));

-- Carried over from 20261027000100 with one more clause: a template's PDF is uploaded by someone who makes templates.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'document' or private.has_permission(f.workspace_id, 'documents.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    when 'brand-uploads' then exists (
      select 1 from app.workspaces w
      where w.id = private.path_workspace(p_name)
        and w.settings -> 'look' -> 'upload' ->> 'path' = p_name
        and w.settings -> 'look' -> 'upload' ->> 'by' = (select auth.uid())::text
        and coalesce(w.settings -> 'look' -> 'upload' ->> 'sent', 'false') = 'false'
        and private.has_permission(w.id, 'workspace.update'))
    else false
  end
$$;

-- A template's PDF stays while the template or a document made from it may need it: only the worker removes one.
create or replace function private.guard_document_file()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.record_type = 'document' and new.deleted_at is not null and old.deleted_at is null
     and not coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    raise exception 'A template''s PDF is kept for the documents made from it' using errcode = '42501',
      detail = 'document_file_kept';
  end if;
  return new;
end $$;
create trigger files_document_kept before update of deleted_at on app.files
  for each row execute function private.guard_document_file();

-- ---------- the worker finds what it needs ----------
-- A signer's link names only their public reference: the business, the document and the link's version.
create or replace function private.document_signer_lookup(p_ref text)
returns table (signer_id uuid, document_id uuid, link_version integer, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select s.id, s.document_id, s.link_version, s.workspace_id, w.organization_id
  from app.document_signers s join app.workspaces w on w.id = s.workspace_id
  where s.public_ref = p_ref and w.deletion_requested_at is null
$$;
revoke all on function private.document_signer_lookup(text) from public;
grant execute on function private.document_signer_lookup(text) to service_actor;

-- Signers whose reminder is due: the first so many days after their link went out, then every so many, while the
-- document is out and not yet expired.
create or replace function private.document_reminders_due(p_limit integer)
returns table (signer_id uuid, document_id uuid, workspace_id uuid, organization_id uuid, reminder integer)
language sql stable security definer set search_path = '' as $$
  select s.id, d.id, d.workspace_id, w.organization_id, s.reminders + 1
  from app.document_signers s
    join app.documents d on d.id = s.document_id
    join app.workspaces w on w.id = d.workspace_id
  where s.kind = 'signer' and s.status in ('sent', 'opened')
    and d.status = 'out' and d.all_signed_at is null and d.expires_at > now()
    and d.remind_after_days is not null and s.sent_at is not null
    and case when s.reminders = 0
      then s.sent_at + make_interval(days => d.remind_after_days) <= now()
      else d.remind_every_days is not null
        and coalesce(s.last_sent_at, s.sent_at) + make_interval(days => d.remind_every_days) <= now() end
    and w.deletion_requested_at is null
  order by coalesce(s.last_sent_at, s.sent_at)
  limit greatest(1, least(p_limit, 500))
$$;
revoke all on function private.document_reminders_due(integer) from public;
grant execute on function private.document_reminders_due(integer) to service_actor;

-- Documents still out past their day.
create or replace function private.documents_expired(p_limit integer)
returns table (document_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select d.id, d.workspace_id, w.organization_id
  from app.documents d join app.workspaces w on w.id = d.workspace_id
  where d.status = 'out' and d.all_signed_at is null and d.expires_at <= now()
    and w.deletion_requested_at is null
  order by d.expires_at
  limit greatest(1, least(p_limit, 500))
$$;
revoke all on function private.documents_expired(integer) from public;
grant execute on function private.documents_expired(integer) to service_actor;

-- ---------- the phone switch for it ----------
-- `documents`: a document someone sent was signed by everyone, declined or ran out of time. On unless they turn it
-- off. Every other switch stays as 20261022000300 left it.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key = 'safety' then
    return true;
  end if;
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons', 'supportTickets',
                                    'qualifying', 'documents') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary, addonEmail), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections, addons, supportTickets, qualifying, documents), each on unless false except payment: private.push_on.';

-- ---------- the Deleted bin: a document out for signing is voided first ----------
-- Carried over from 20261027000800 with one more reason: a document still out for signing on what's deleted, or
-- with them as a signer.
create or replace function private.bin_blocker(p_kind text, p_name text, r private.bin_rows,
  out rule text, out message text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_record uuid;
  v_record_name text;
  v_kept text;
  v_file text;
  v_at timestamptz;
  v_tz text;
  v_when text;
  v_addon text;
  v_private boolean;
  v_document text;
begin
  if p_kind = 'person' and exists (
    select 1 from app.subscriptions s
    where s.person_id = any (r.people) and s.status in ('active', 'past_due', 'paused')) then
    rule := 'bin_plan_running';
    message := format('%s has a plan that’s still billing. Cancel it on their Money tab first, then delete them.',
      p_name);
    return;
  end if;

  -- A document still out for signing (20261027015200): voided first, so nobody signs something that's gone.
  select d.name into v_document from app.documents d
  where d.status = 'out'
    and (d.person_id = any (r.people) or d.company_id = any (r.companies) or d.lead_id = any (r.leads)
         or d.custom_record_id = any (r.records)
         or exists (select 1 from app.document_signers s
                    where s.document_id = d.id and s.person_id = any (r.people)))
  order by d.sent_at
  limit 1;
  if v_document is not null then
    rule := 'bin_document_out';
    message := format('%s has a document out for signing, %s. Void it on Documents first, then delete %s.',
      p_name, v_document, case when p_kind = 'person' then 'them' else 'it' end);
    return;
  end if;

  if p_kind = 'custom_record' then
    -- An add-on's records are the add-on's to keep (Real Estate's deals stay archive-only, 2026-10-03).
    select t.addon_id, k.kept_to_team into v_addon, v_private
    from app.custom_records k join app.custom_record_types t on t.id = k.type_id
    where k.id = any (r.records);
    if v_addon is not null then
      rule := 'bin_record_addon';
      message := format('%s belongs to the {addon:%s} add-on, so it can only be archived.', p_name, v_addon);
      return;
    end if;
    -- What a private record seals would show to everyone once it was gone (only add-ons' kinds are private yet).
    if v_private then
      rule := 'bin_record_private';
      message := format('%s is kept to the people on it, so it can only be archived.', p_name);
      return;
    end if;
    v_kept := private.record_kept(r.records[1]);
    if v_kept is not null then
      rule := 'bin_record_kept';
      message := format('%s is %s, so it has to stay. Archive it instead.', p_name, v_kept);
      return;
    end if;
  end if;

  -- What an add-on keeps that needs it (Real Estate's vendors need their company).
  if p_kind in ('lead', 'company', 'custom_record') then
    select x.addon into v_addon from (
      select private.bin_addon_using('app.leads'::regclass, l) as addon from unnest(r.leads) l
      union all
      select private.bin_addon_using('app.companies'::regclass, c) from unnest(r.companies) c
      union all
      select private.bin_addon_using('app.custom_records'::regclass, k) from unnest(r.records) k
    ) x
    where x.addon is not null
    limit 1;
    if v_addon is not null then
      rule := 'bin_addon_uses';
      message := format('%s is used by the {addon:%s} add-on, so it has to stay. Archive it instead.', p_name, v_addon);
      return;
    end if;
  end if;

  select f.name into v_file from app.files f
  where f.id = any (r.files) and f.locked_at is not null and f.deleted_at is null
  limit 1;
  if v_file is not null then
    rule := 'bin_signed_file';
    message := format('%s has a signed file, %s, and signed files are kept for good. Archive %s instead.',
      p_name, v_file, case when p_kind = 'person' then 'them' else 'it' end);
    return;
  end if;

  -- History on a record that's being kept (Real Estate: a deal still open, closed within its years, or on legal
  -- hold).
  select x.record_id into v_record from (
    select a.custom_record_id as record_id from app.activities a
    where a.id = any (r.activities) and a.custom_record_id is not null
    union all
    select t.custom_record_id from app.tasks t where t.id = any (r.tasks) and t.custom_record_id is not null
    union all
    select c.custom_record_id from app.conversations c
    where c.id = any (r.conversations) and c.custom_record_id is not null
    union all
    select a.custom_record_id from app.appointments a
    where (a.id = any (r.appointments)
           or a.id in (select t.appointment_id from app.appointment_attendees t where t.id = any (r.attendees)))
      and a.custom_record_id is not null
    union all
    select x.a_custom_record_id from app.relationships x
    where x.id = any (r.relationships) and x.a_custom_record_id is not null
    union all
    select x.b_custom_record_id from app.relationships x
    where x.id = any (r.relationships) and x.b_custom_record_id is not null
  ) x
  where not (x.record_id = any (r.records)) and private.record_kept(x.record_id) is not null
  limit 1;
  if v_record is not null then
    select cr.name into v_record_name from app.custom_records cr where cr.id = v_record;
    v_record_name := coalesce(v_record_name, 'a record');
    v_kept := private.record_kept(v_record);
    rule := 'bin_record_kept';
    message := case p_kind
      when 'person' then format('%s is on %s, which is %s, so their history there has to stay. Archive them instead.',
        p_name, v_record_name, v_kept)
      when 'conversation' then format('This conversation is part of %s, which is %s, so it has to stay. Archive it instead.',
        v_record_name, v_kept)
      when 'lead' then format('This lead is part of %s, which is %s, so it has to stay. Archive it instead.',
        v_record_name, v_kept)
      when 'company' then format('%s is on %s, which is %s, so its history there has to stay. Archive it instead.',
        p_name, v_record_name, v_kept)
      when 'custom_record' then format('%s is related to %s, which is %s, so it has to stay. Archive it instead.',
        p_name, v_record_name, v_kept)
      else format('This booking is part of %s, which is %s, so it has to stay.', v_record_name, v_kept) end;
    return;
  end if;

  if exists (select 1 from app.messages m
             where m.id = any (r.messages)
               and (m.status = 'sending' or (m.status = 'queued' and m.error_code is distinct from 'scheduled'))) then
    rule := 'bin_still_sending';
    message := case when p_kind = 'person'
      then format('A message to %s is still going out. Try again in a minute.', p_name)
      else 'A message in this conversation is still going out. Try again in a minute.' end;
    return;
  end if;

  if exists (select 1 from app.calls k
             where k.id = any (r.calls) and k.status in ('initiated', 'ringing', 'in_progress')) then
    rule := 'bin_call_live';
    message := case when p_kind = 'person'
      then format('A call with %s is still going on. Try again when it ends.', p_name)
      else 'A call in this conversation is still going on. Try again when it ends.' end;
    return;
  end if;

  -- A booking still to come is cancelled first: the command does it, and tells the customer if asked to.
  select a.starts_at, coalesce(w.timezone, 'UTC') into v_at, v_tz
  from app.appointments a join app.workspaces w on w.id = a.workspace_id
  where a.status = 'scheduled' and a.ends_at > now()
    and (a.id = any (r.appointments)
         or a.id in (select t.appointment_id from app.appointment_attendees t
                     where t.id = any (r.attendees) and t.status = 'booked'))
  order by a.starts_at
  limit 1;
  if v_at is not null then
    v_when := to_char(v_at at time zone v_tz, 'FMMonth FMDD');
    rule := 'bin_upcoming_booking';
    message := case when p_kind = 'person'
      then format('%s has a booking still to come, on %s. Cancel it first, then delete them.', p_name, v_when)
      else format('This booking is still to come, on %s. Cancel it first, then delete it.', v_when) end;
    return;
  end if;
end $$;
revoke all on function private.bin_blocker(text, text, private.bin_rows) from public;

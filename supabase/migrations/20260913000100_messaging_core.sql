-- =============================================================================
-- 0011 · Messaging core. A business number and its carrier registrations per
--        workspace, conversations and messages (texts now, email in 0012),
--        calls, opt-outs, the webhook-ingestion table and the scheduled-jobs
--        queue. Plus the inbox.use / channels.manage permissions, SMS consent
--        on people, the private `telephony` bucket, and the SECURITY DEFINER
--        lookups the worker's HTTP routes use before they know the tenant.
--        Provider secrets (subaccount tokens, API key secrets) are sealed by
--        the worker; `authenticated` cannot select those columns at all.
-- =============================================================================

create type app.telephony_provider as enum ('twilio', 'fake');
create type app.telephony_account_status as enum ('provisioning', 'active', 'suspended', 'closed');
create type app.phone_number_type as enum ('local', 'toll_free');
create type app.phone_number_status as enum ('provisioning', 'active', 'failed', 'releasing', 'released');
create type app.registration_kind as enum (
  'toll_free_verification', 'a2p_customer_profile', 'a2p_trust_product', 'a2p_brand', 'a2p_campaign'
);
create type app.registration_status as enum ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'failed');
create type app.channel as enum ('sms', 'email');
create type app.conversation_status as enum ('open', 'snoozed', 'closed');
create type app.direction as enum ('inbound', 'outbound');
create type app.message_status as enum (
  'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received', 'bounced', 'complained'
);
create type app.call_status as enum (
  'initiated', 'ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled'
);
create type app.call_answered_via as enum ('browser', 'forwarding');
create type app.opt_out_source as enum ('stop_keyword', 'manual', 'carrier_error');
create type app.sms_consent as enum ('unknown', 'opted_in', 'opted_out');
create type app.delivery_status as enum ('pending', 'done', 'failed', 'ignored');
create type app.job_status as enum ('pending', 'done', 'failed', 'cancelled');

-- ---------- telephony accounts: one provider subaccount per workspace ----------
create table app.telephony_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references app.workspaces (id) on delete cascade,
  provider app.telephony_provider not null,
  account_sid text unique,
  auth_token_enc text,
  api_key_sid text,
  api_key_secret_enc text,
  twiml_app_sid text,
  messaging_service_sid text,
  key_id text,
  webhook_base_url text,
  status app.telephony_account_status not null default 'provisioning',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger telephony_accounts_updated_at before update on app.telephony_accounts for each row execute function private.set_updated_at();
create trigger telephony_accounts_immutable before update on app.telephony_accounts for each row execute function private.forbid_tenant_column_change('workspace_id', 'provider');

-- ---------- phone numbers ----------
create table app.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid references app.telephony_accounts (id) on delete set null,
  provider_sid text unique,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  number_type app.phone_number_type not null,
  label text check (label is null or length(label) <= 60),
  capabilities jsonb not null default '{}'::jsonb,
  status app.phone_number_status not null default 'provisioning',
  routing jsonb not null default '{"forwarding": [], "ringSeconds": 20, "voicemailEnabled": true, "voicemailGreeting": null}'::jsonb
    check (jsonb_typeof(routing) = 'object'),
  last_error text,
  purchased_at timestamptz,
  released_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One customer-facing number per workspace in this milestone (the assistant line arrives later).
create unique index phone_numbers_one_live_per_workspace on app.phone_numbers (workspace_id)
  where status in ('provisioning', 'active', 'releasing');
-- While a number is live it routes to exactly one workspace.
create unique index phone_numbers_live_e164 on app.phone_numbers (e164)
  where status in ('provisioning', 'active', 'releasing');
create index phone_numbers_workspace_idx on app.phone_numbers (workspace_id, created_at desc);
create trigger phone_numbers_updated_at before update on app.phone_numbers for each row execute function private.set_updated_at();
create trigger phone_numbers_immutable before update on app.phone_numbers for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- People change routing and labels, and start a release; everything the provider decides is the worker's.
create or replace function private.guard_phone_number_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.e164 is distinct from new.e164 or old.number_type is distinct from new.number_type
     or old.provider_sid is distinct from new.provider_sid or old.account_id is distinct from new.account_id
     or old.capabilities is distinct from new.capabilities or old.purchased_at is distinct from new.purchased_at
     or old.released_at is distinct from new.released_at or old.last_error is distinct from new.last_error then
    raise exception 'Only HandsFreeOS changes a number''s provider details' using errcode = '42501', detail = 'phone_number_provider_fields';
  end if;
  if old.status is distinct from new.status and not (old.status = 'active' and new.status = 'releasing') then
    raise exception 'People can only start releasing an active number' using errcode = '42501', detail = 'phone_number_status_transition';
  end if;
  return new;
end $$;
create trigger phone_numbers_update_guard before update on app.phone_numbers for each row execute function private.guard_phone_number_update();

-- ---------- carrier registrations (toll-free verification, or the 10DLC chain) ----------
create table app.telephony_registrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid references app.telephony_accounts (id) on delete set null,
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  kind app.registration_kind not null,
  status app.registration_status not null default 'draft',
  depends_on_id uuid references app.telephony_registrations (id) on delete set null,
  provider_sid text,
  provider_status text,
  submission jsonb not null default '{}'::jsonb check (jsonb_typeof(submission) = 'object'),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 2000),
  submitted_at timestamptz,
  approved_at timestamptz,
  next_poll_at timestamptz,
  poll_count int not null default 0,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index telephony_registrations_workspace_idx on app.telephony_registrations (workspace_id, created_at desc);
create index telephony_registrations_poll_idx on app.telephony_registrations (next_poll_at) where status in ('submitted', 'in_review');
create trigger telephony_registrations_updated_at before update on app.telephony_registrations for each row execute function private.set_updated_at();
create trigger telephony_registrations_immutable before update on app.telephony_registrations for each row execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'created_by');

-- People edit a draft or a turned-down registration and send it again; the carrier's answers are the worker's.
create or replace function private.guard_registration_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.provider_sid is distinct from new.provider_sid or old.provider_status is distinct from new.provider_status
     or old.rejection_reason is distinct from new.rejection_reason or old.approved_at is distinct from new.approved_at
     or old.next_poll_at is distinct from new.next_poll_at or old.poll_count is distinct from new.poll_count
     or old.account_id is distinct from new.account_id or old.depends_on_id is distinct from new.depends_on_id then
    raise exception 'Only HandsFreeOS records the carrier''s answer' using errcode = '42501', detail = 'registration_provider_fields';
  end if;
  if old.status not in ('draft', 'rejected', 'failed')
     and (old.status is distinct from new.status or old.submission is distinct from new.submission) then
    raise exception 'A registration under review cannot be changed' using errcode = '42501', detail = 'registration_in_review';
  end if;
  if old.status is distinct from new.status and new.status not in ('draft', 'submitted') then
    raise exception 'People can only save or send a registration' using errcode = '42501', detail = 'registration_status_transition';
  end if;
  return new;
end $$;
create trigger telephony_registrations_update_guard before update on app.telephony_registrations for each row execute function private.guard_registration_update();

-- ---------- conversations: one customer on one channel ----------
create table app.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  channel app.channel not null,
  counterpart text not null check (length(counterpart) between 3 and 320),
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  status app.conversation_status not null default 'open',
  assignee_user_id uuid references app.users (id) on delete set null,
  snoozed_until timestamptz,
  unread_count int not null default 0 check (unread_count >= 0),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_preview text check (last_preview is null or length(last_preview) <= 280),
  last_direction app.direction,
  awaiting_reply_since timestamptz,
  closed_at timestamptz,
  closed_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, channel, counterpart),
  check (channel <> 'sms' or counterpart ~ '^\+[1-9][0-9]{6,14}$'),
  check (channel <> 'email' or (counterpart = lower(counterpart) and position('@' in counterpart) > 1)),
  check (status <> 'snoozed' or snoozed_until is not null)
);
create index conversations_inbox_idx on app.conversations (workspace_id, status, last_message_at desc nulls last, id desc);
create index conversations_assignee_idx on app.conversations (workspace_id, assignee_user_id, status);
create index conversations_person_idx on app.conversations (person_id) where person_id is not null;
create index conversations_snoozed_idx on app.conversations (snoozed_until) where status = 'snoozed';
create trigger conversations_updated_at before update on app.conversations for each row execute function private.set_updated_at();
create trigger conversations_immutable before update on app.conversations for each row execute function private.forbid_tenant_column_change('workspace_id', 'channel', 'counterpart', 'created_by');

-- ---------- messages (texts now; email adds columns in 0012) ----------
create table app.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  channel app.channel not null,
  direction app.direction not null,
  status app.message_status not null,
  from_address text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text check (subject is null or length(subject) <= 998),
  body_text text check (body_text is null or length(body_text) <= 10000),
  body_html text,
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  provider text,
  provider_message_id text,
  dedupe_key text,
  message_id_header text,
  in_reply_to_header text,
  references_headers text[] not null default '{}',
  provider_thread_id text,
  segments int check (segments is null or segments >= 0),
  error_code text,
  error_message text,
  sent_by uuid references app.users (id) on delete set null,
  client_id text check (client_id is null or length(client_id) <= 64),
  occurred_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  activity_id uuid references app.activities (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((direction = 'inbound') = (status = 'received'))
);
-- Provider ids (MessageSid, Message-ID) make a replayed webhook land on the same row.
create unique index messages_dedupe_unique on app.messages (workspace_id, dedupe_key) where dedupe_key is not null;
-- A double-clicked send lands once.
create unique index messages_client_unique on app.messages (conversation_id, client_id) where client_id is not null;
create index messages_thread_idx on app.messages (conversation_id, occurred_at desc, id desc);
create index messages_provider_idx on app.messages (provider, provider_message_id) where provider_message_id is not null;
create trigger messages_updated_at before update on app.messages for each row execute function private.set_updated_at();
create trigger messages_immutable before update on app.messages for each row execute function private.forbid_tenant_column_change('workspace_id', 'conversation_id', 'channel', 'direction', 'sent_by');

create or replace function private.message_status_rank(p app.message_status)
returns int language sql immutable set search_path = '' as $$
  select case p
    when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3
    when 'undelivered' then 4 when 'failed' then 4 when 'bounced' then 5 when 'complained' then 6
    else 0 end
$$;

-- Providers retry and reorder callbacks, so a late "sent" never overwrites "delivered" (silently kept,
-- so the worker's delivery does not fail and retry forever). People may only resend a failed message.
create or replace function private.guard_message_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is not distinct from new.status then
    return new;
  end if;
  if old.direction = 'inbound' or new.status = 'received' then
    raise exception 'Received messages keep their status' using errcode = '23514', detail = 'message_status_transition';
  end if;
  if old.status in ('failed', 'undelivered') and new.status = 'queued' then
    return new;
  end if;
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    if private.message_status_rank(new.status) < private.message_status_rank(old.status) then
      new.status := old.status;
    end if;
    return new;
  end if;
  raise exception 'Only a message that failed can be sent again' using errcode = '42501', detail = 'message_status_transition';
end $$;
create trigger messages_status_guard before update of status on app.messages for each row execute function private.guard_message_update();

-- ---------- calls ----------
create table app.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  conversation_id uuid references app.conversations (id) on delete set null,
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  direction app.direction not null,
  from_e164 text,
  to_e164 text,
  provider_sid text unique,
  status app.call_status not null default 'initiated',
  answered_via app.call_answered_via,
  answered_by_user_id uuid references app.users (id) on delete set null,
  answered_number text,
  placed_by uuid references app.users (id) on delete set null,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int check (duration_seconds is null or duration_seconds >= 0),
  is_voicemail boolean not null default false,
  recording_sid text,
  recording_object_path text,
  recording_seconds int check (recording_seconds is null or recording_seconds >= 0),
  transcript text check (transcript is null or length(transcript) <= 10000),
  transcript_status text,
  activity_id uuid references app.activities (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calls_conversation_idx on app.calls (conversation_id, started_at desc, id desc) where conversation_id is not null;
create index calls_workspace_idx on app.calls (workspace_id, started_at desc);
create index calls_person_idx on app.calls (person_id) where person_id is not null;
create trigger calls_updated_at before update on app.calls for each row execute function private.set_updated_at();
create trigger calls_immutable before update on app.calls for each row execute function private.forbid_tenant_column_change('workspace_id', 'direction', 'placed_by');

create or replace function private.call_status_rank(p app.call_status)
returns int language sql immutable set search_path = '' as $$
  select case p when 'initiated' then 0 when 'ringing' then 1 when 'in_progress' then 2 else 3 end
$$;

create or replace function private.guard_call_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status
     and private.call_status_rank(new.status) < private.call_status_rank(old.status) then
    new.status := old.status;
  end if;
  return new;
end $$;
create trigger calls_status_guard before update of status on app.calls for each row execute function private.guard_call_update();

-- ---------- opt-outs (per workspace, so a replaced number keeps the list) ----------
create table app.opt_outs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  counterpart_e164 text not null check (counterpart_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  opted_out boolean not null default true,
  source app.opt_out_source not null,
  last_keyword text check (last_keyword is null or length(last_keyword) <= 40),
  opted_out_at timestamptz,
  opted_in_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, counterpart_e164)
);
create trigger opt_outs_updated_at before update on app.opt_outs for each row execute function private.set_updated_at();
create trigger opt_outs_immutable before update on app.opt_outs for each row execute function private.forbid_tenant_column_change('workspace_id', 'counterpart_e164', 'created_by');

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_messaging_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'phone_numbers' then
    if new.account_id is not null and not exists (select 1 from app.telephony_accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id) then
      raise exception 'Account must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'telephony_registrations' then
    if (new.phone_number_id is not null and not exists (select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id))
       or (new.depends_on_id is not null and not exists (select 1 from app.telephony_registrations r where r.id = new.depends_on_id and r.workspace_id = new.workspace_id))
       or (new.account_id is not null and not exists (select 1 from app.telephony_accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id)) then
      raise exception 'Registration references must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'conversations' then
    if (new.person_id is not null and not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
       or (new.phone_number_id is not null and not exists (select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id)) then
      raise exception 'Conversation references must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'messages' then
    if not exists (select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.channel = new.channel) then
      raise exception 'A message belongs to a conversation of the same workspace and channel' using errcode = '23514', detail = 'conversation_mismatch';
    end if;
  elsif tg_table_name = 'calls' then
    if (new.conversation_id is not null and not exists (select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
       or (new.person_id is not null and not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
       or (new.phone_number_id is not null and not exists (select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id)) then
      raise exception 'Call references must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'opt_outs' then
    if new.phone_number_id is not null and not exists (select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id) then
      raise exception 'Number must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end if;
  return new;
end $$;
create trigger phone_numbers_check_refs before insert or update on app.phone_numbers for each row execute function private.check_messaging_refs();
create trigger telephony_registrations_check_refs before insert or update on app.telephony_registrations for each row execute function private.check_messaging_refs();
create trigger conversations_check_refs before insert or update on app.conversations for each row execute function private.check_messaging_refs();
create trigger messages_check_refs before insert on app.messages for each row execute function private.check_messaging_refs();
create trigger calls_check_refs before insert or update on app.calls for each row execute function private.check_messaging_refs();
create trigger opt_outs_check_refs before insert or update on app.opt_outs for each row execute function private.check_messaging_refs();

-- ---------- webhook deliveries: stored, acknowledged, then processed with retries ----------
create table app.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references app.organizations (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  provider text not null check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake')),
  kind text not null check (length(kind) between 1 and 80),
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  account_ref text,
  url text,
  params jsonb not null default '{}'::jsonb,
  signature_valid boolean not null default false,
  status app.delivery_status not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, dedupe_key)
);
create index webhook_deliveries_pending_idx on app.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_finished_idx on app.webhook_deliveries (received_at) where status <> 'pending';
create trigger webhook_deliveries_updated_at before update on app.webhook_deliveries for each row execute function private.set_updated_at();

-- ---------- scheduled jobs: delayed and periodic work, claimed like the outbox ----------
create table app.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references app.organizations (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  kind text not null check (length(kind) between 3 and 80),
  dedupe_key text check (dedupe_key is null or length(dedupe_key) <= 200),
  run_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  status app.job_status not null default 'pending',
  attempts int not null default 0,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index scheduled_jobs_pending_dedupe on app.scheduled_jobs (kind, dedupe_key) where status = 'pending' and dedupe_key is not null;
create index scheduled_jobs_due_idx on app.scheduled_jobs (run_at) where status = 'pending';
create trigger scheduled_jobs_updated_at before update on app.scheduled_jobs for each row execute function private.set_updated_at();

-- ---------- SMS consent on people ----------
alter table app.people
  add column sms_consent app.sms_consent not null default 'unknown',
  add column sms_consent_at timestamptz,
  add column sms_consent_source text check (sms_consent_source is null or length(sms_consent_source) <= 80);

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'inbox.use'), ('owner', 'channels.manage'),
  ('admin', 'inbox.use'), ('admin', 'channels.manage'),
  ('member', 'inbox.use');

-- ---------- RLS ----------
alter table app.telephony_accounts enable row level security;
alter table app.phone_numbers enable row level security;
alter table app.telephony_registrations enable row level security;
alter table app.conversations enable row level security;
alter table app.messages enable row level security;
alter table app.calls enable row level security;
alter table app.opt_outs enable row level security;
alter table app.webhook_deliveries enable row level security;
alter table app.scheduled_jobs enable row level security;

create policy telephony_accounts_select on app.telephony_accounts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy telephony_accounts_service_all on app.telephony_accounts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy phone_numbers_select on app.phone_numbers for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy phone_numbers_insert on app.phone_numbers for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status = 'provisioning' and provider_sid is null and account_id is null);
create policy phone_numbers_update on app.phone_numbers for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy phone_numbers_service_all on app.phone_numbers for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy telephony_registrations_select on app.telephony_registrations for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy telephony_registrations_insert on app.telephony_registrations for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status in ('draft', 'submitted') and provider_sid is null);
create policy telephony_registrations_update on app.telephony_registrations for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy telephony_registrations_service_all on app.telephony_registrations for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy conversations_select on app.conversations for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy conversations_insert on app.conversations for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid()));
create policy conversations_update on app.conversations for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy conversations_service_all on app.conversations for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy messages_select on app.messages for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy messages_insert on app.messages for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and direction = 'outbound' and status = 'queued'
    and sent_by = (select auth.uid()) and provider_message_id is null);
create policy messages_update on app.messages for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy messages_service_all on app.messages for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calls_select on app.calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calls_insert on app.calls for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and direction = 'outbound' and status = 'initiated'
    and placed_by = (select auth.uid()) and provider_sid is null);
create policy calls_service_all on app.calls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy opt_outs_select on app.opt_outs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy opt_outs_insert on app.opt_outs for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid()));
create policy opt_outs_update on app.opt_outs for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy opt_outs_service_all on app.opt_outs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Queue tables are claimed before the tenant is known, like the outbox; people never see them.
create policy webhook_deliveries_service_all on app.webhook_deliveries for all to service_actor using (true) with check (true);
create policy scheduled_jobs_service_all on app.scheduled_jobs for all to service_actor using (true) with check (true);

-- The worker fills in call transcripts and delivery details on timeline entries it wrote.
create policy activities_service_update on app.activities for update to service_actor
  using (workspace_id = private.system_scope_workspace() and kind <> 'system')
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select (id, workspace_id, provider, status, last_error, created_at, updated_at) on app.telephony_accounts to authenticated;
grant select, insert, update on app.phone_numbers, app.telephony_registrations, app.conversations, app.opt_outs to authenticated;
grant select, insert on app.messages, app.calls to authenticated;
grant update (status, error_code, error_message) on app.messages to authenticated;

grant select, insert, update on app.telephony_accounts, app.phone_numbers, app.telephony_registrations,
  app.conversations, app.messages, app.calls, app.opt_outs to service_actor;
grant select, insert, update, delete on app.webhook_deliveries, app.scheduled_jobs to service_actor;
revoke all on app.telephony_accounts, app.phone_numbers, app.telephony_registrations, app.conversations,
  app.messages, app.calls, app.opt_outs, app.webhook_deliveries, app.scheduled_jobs from anon;

-- ---------- storage: MMS media, recordings and inbound email attachments ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('telephony', 'telephony', false, 26214400, null)
on conflict (id) do nothing;

-- Only the worker writes to `telephony` (server-made `<workspace>/…` paths); members read their workspace's objects.
create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids()))
    when 'telephony' then coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
    else false
  end
$$;

-- ---------- lookups for the worker's HTTP routes (the tenant is not known yet) ----------
create or replace function private.telephony_account_lookup(p_account_sid text)
returns table (account_id uuid, workspace_id uuid, organization_id uuid, provider app.telephony_provider,
  status app.telephony_account_status, auth_token_enc text, key_id text)
language sql stable security definer set search_path = '' as $$
  select ta.id, ta.workspace_id, w.organization_id, ta.provider, ta.status, ta.auth_token_enc, ta.key_id
  from app.telephony_accounts ta join app.workspaces w on w.id = ta.workspace_id
  where ta.account_sid = p_account_sid
$$;

-- Where a call or text to one of our numbers goes: the workspace, its routing and time zone, and the
-- browser identities (u + user id without dashes) of everyone who works the inbox.
create or replace function private.phone_route(p_to_e164 text)
returns table (phone_number_id uuid, workspace_id uuid, organization_id uuid, account_id uuid, e164 text,
  routing jsonb, timezone text, workspace_name text, client_identities text[])
language sql stable security definer set search_path = '' as $$
  select pn.id, pn.workspace_id, w.organization_id, pn.account_id, pn.e164, pn.routing, w.timezone, w.name,
    coalesce((
      select array_agg('u' || replace(u.user_id::text, '-', '') order by u.user_id)
      from (
        select wm.user_id from app.workspace_memberships wm
        join app.role_permissions rp on rp.role = wm.role::text and rp.permission = 'inbox.use'
        where wm.workspace_id = pn.workspace_id
        union
        select om.user_id from app.organization_memberships om
        join app.role_permissions rp on rp.role = om.role::text and rp.permission = 'inbox.use'
        where om.organization_id = w.organization_id
      ) u
    ), '{}')
  from app.phone_numbers pn
  join app.workspaces w on w.id = pn.workspace_id
  where pn.e164 = p_to_e164 and pn.status = 'active'
$$;

-- Permission check for a verified user id (the worker cannot switch to `authenticated`).
create or replace function private.user_has_permission(p_user uuid, p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.role_permissions rp
    where rp.permission = p_perm and rp.role in (
      select wm.role::text from app.workspace_memberships wm where wm.workspace_id = p_ws and wm.user_id = p_user
      union all
      select om.role::text from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id
      where w.id = p_ws and om.user_id = p_user
    )
  )
$$;

-- Stores a webhook once per provider id; a replay returns the first row.
create or replace function private.record_webhook_delivery(
  p_provider text, p_kind text, p_dedupe_key text, p_account_ref text, p_url text, p_params jsonb,
  p_signature_valid boolean, p_workspace uuid, p_organization uuid)
returns table (delivery_id uuid, inserted boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into app.webhook_deliveries (provider, kind, dedupe_key, account_ref, url, params, signature_valid, workspace_id, organization_id)
  values (p_provider, p_kind, p_dedupe_key, p_account_ref, p_url, coalesce(p_params, '{}'::jsonb), p_signature_valid, p_workspace, p_organization)
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  return query select d.id, false from app.webhook_deliveries d where d.provider = p_provider and d.dedupe_key = p_dedupe_key;
end $$;

revoke all on function
  private.guard_phone_number_update(), private.guard_registration_update(), private.message_status_rank(app.message_status),
  private.guard_message_update(), private.call_status_rank(app.call_status), private.guard_call_update(),
  private.check_messaging_refs(), private.storage_read_allowed(text, text),
  private.telephony_account_lookup(text), private.phone_route(text), private.user_has_permission(uuid, uuid, text),
  private.record_webhook_delivery(text, text, text, text, text, jsonb, boolean, uuid, uuid)
  from public;
grant execute on function
  private.guard_phone_number_update(), private.guard_registration_update(), private.message_status_rank(app.message_status),
  private.guard_message_update(), private.call_status_rank(app.call_status), private.guard_call_update(),
  private.check_messaging_refs()
  to authenticated, service_actor;
grant execute on function private.storage_read_allowed(text, text) to authenticated;
grant execute on function
  private.telephony_account_lookup(text), private.phone_route(text), private.user_has_permission(uuid, uuid, text),
  private.record_webhook_delivery(text, text, text, text, text, jsonb, boolean, uuid, uuid)
  to service_actor;

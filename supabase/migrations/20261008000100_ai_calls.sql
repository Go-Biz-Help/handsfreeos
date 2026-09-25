-- AI outbound calls (Automations, piece 4a): the AI teammate rings a customer itself.
--
-- Four reasons it calls (Chris, 2026-09-23): to confirm tomorrow's visit a text didn't confirm, to call back a
-- missed call, to follow up a quote (always after a person's OK), and campaign calls (only to people who agreed
-- to calls in writing). Every call is in open hours, never in quiet hours; it says it's an AI and that the call is
-- recorded. While the teammate is training, a person approves each call before it's placed: a `call` draft.
--
-- `app.ai_calls` is one row per call the AI means to place: why, who, what it's about, whether it's waiting for
-- approval, placed, or left alone and why, and how it went. The dedupe key means one call per reason and subject.

-- ---------- written consent to calls (campaign calls need it) ----------
alter table app.people
  add column call_consent app.sms_consent not null default 'unknown',
  add column call_consent_at timestamptz,
  -- Where the written consent is: "Signed service agreement", "Booking form checkbox".
  add column call_consent_source text check (call_consent_source is null or length(call_consent_source) <= 120);

-- ---------- a call draft: a person approves each call while the teammate trains ----------
alter table app.ai_teammate_drafts drop constraint ai_teammate_drafts_kind_check;
alter table app.ai_teammate_drafts add constraint ai_teammate_drafts_kind_check
  check (kind in ('reply', 'approval', 'call'));

drop policy ai_teammate_drafts_update on app.ai_teammate_drafts;
create policy ai_teammate_drafts_update on app.ai_teammate_drafts for update to authenticated
  using (status = 'pending'
    and private.has_permission(workspace_id, case when kind in ('reply', 'call') then 'inbox.use' else 'ai_team.manage' end))
  with check (status in ('approved', 'rejected', 'cancelled') and decided_by = (select auth.uid())
    and via in ('web', 'assistant', 'mobile')
    and private.has_permission(workspace_id, case when kind in ('reply', 'call') then 'inbox.use' else 'ai_team.manage' end));

-- ---------- the calls ----------
create table app.ai_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  purpose text not null check (purpose in ('confirm_visit', 'missed_call', 'quote', 'campaign')),
  -- What it's about: the visit to confirm, the call to return, the quote, the campaign's person.
  attendee_id uuid references app.appointment_attendees (id) on delete cascade,
  missed_call_id uuid references app.calls (id) on delete set null,
  estimate_id uuid references app.estimates (id) on delete cascade,
  campaign_recipient_id uuid references app.campaign_recipients (id) on delete cascade,
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- What the AI is to say it's calling about, in a line.
  goal text not null check (length(btrim(goal)) between 1 and 500),
  status text not null default 'queued'
    check (status in ('awaiting_approval', 'queued', 'calling', 'done', 'skipped', 'cancelled', 'failed')),
  -- Why it was left alone or failed: already_confirmed, replied_since, quiet_hours_all_day, no_voice, ...
  reason text check (reason is null or length(reason) <= 200),
  draft_id uuid references app.ai_teammate_drafts (id) on delete set null,
  call_id uuid references app.calls (id) on delete set null,
  -- How it went: they talked, a voicemail box answered, nobody answered, busy, or it failed.
  outcome text check (outcome is null or outcome in ('talked', 'voicemail', 'no_answer', 'busy', 'failed')),
  summary text check (summary is null or length(summary) <= 1000),
  -- One call per reason and subject: `confirm_visit:<attendee>`, `missed_call:<call>`.
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  placed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index ai_calls_workspace on app.ai_calls (workspace_id, created_at desc);
create index ai_calls_person_idx on app.ai_calls (person_id);
create index ai_calls_attendee_idx on app.ai_calls (attendee_id) where attendee_id is not null;
create index ai_calls_missed_call_idx on app.ai_calls (missed_call_id) where missed_call_id is not null;
create index ai_calls_estimate_idx on app.ai_calls (estimate_id) where estimate_id is not null;
create index ai_calls_campaign_recipient_idx on app.ai_calls (campaign_recipient_id)
  where campaign_recipient_id is not null;
create index ai_calls_draft_idx on app.ai_calls (draft_id) where draft_id is not null;
create index ai_calls_call_idx on app.ai_calls (call_id) where call_id is not null;
create trigger ai_calls_updated_at before update on app.ai_calls
  for each row execute function private.set_updated_at();
create trigger ai_calls_immutable before update on app.ai_calls
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'person_id', 'purpose',
    'dedupe_key');

-- Everything it points at belongs to the same business.
create or replace function private.check_ai_call_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
     or (new.attendee_id is not null and not exists (
       select 1 from app.appointment_attendees a where a.id = new.attendee_id and a.workspace_id = new.workspace_id))
     or (new.missed_call_id is not null and not exists (
       select 1 from app.calls c where c.id = new.missed_call_id and c.workspace_id = new.workspace_id))
     or (new.call_id is not null and not exists (
       select 1 from app.calls c where c.id = new.call_id and c.workspace_id = new.workspace_id))
     or (new.estimate_id is not null and not exists (
       select 1 from app.estimates e where e.id = new.estimate_id and e.workspace_id = new.workspace_id))
     or (new.campaign_recipient_id is not null and not exists (
       select 1 from app.campaign_recipients r where r.id = new.campaign_recipient_id and r.workspace_id = new.workspace_id))
     or (new.draft_id is not null and not exists (
       select 1 from app.ai_teammate_drafts d where d.id = new.draft_id and d.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger ai_calls_check_refs before insert or update on app.ai_calls
  for each row execute function private.check_ai_call_refs();

-- The team reads them (the person's timeline, the approval card); only the worker writes. A person's say goes
-- through the call draft.
alter table app.ai_calls enable row level security;
create policy ai_calls_select on app.ai_calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_calls_service_all on app.ai_calls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.ai_calls to authenticated;
grant select, insert, update, delete on app.ai_calls to service_actor;
revoke all on app.ai_calls from anon;

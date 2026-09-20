-- =============================================================================
-- 0080 · Bringing your existing number with you, part 2.
--
--        The FAQ used to promise this and now deliberately promises nothing
--        (952c8ca), because until today it did not exist. Two kinds, and the
--        difference matters to a business far more than any of the machinery:
--
--          full              texts AND calls move to us. Two to four weeks,
--                            and the losing carrier can refuse.
--          hosted_messaging  we take over texting only. Days, and their desk
--                            phone keeps ringing exactly as it does now.
--
--        **A new table, not an extension of app.migration_port_requests.**
--        That one is `migration_id uuid NOT NULL` with unique (migration_id,
--        e164), cascaded from app.migrations and read by the rollback guard.
--        Porting outside a migration would need a nullable migration_id, which
--        breaks that unique key (two ports of one number, both under null),
--        breaks the cascade, and puts `where migration_id is not null` into
--        every migration query. Its job is "what we found at the old CRM and
--        whether it moved"; this one's is "this business is moving its number
--        to us". It gains one column pointing here and keeps its own job.
--
--        **And a new enum, not app.port_state.** That enum's `not_started`,
--        `information_required`, `documents_required` and `ready_to_submit`
--        are the migration wizard's own screens. This one is shaped like
--        app.registration_status, because this is the same machine a carrier
--        registration already is: paperwork goes out, the carrier takes its
--        time, a job polls, an answer comes back. Two vocabularies, kept apart
--        on purpose.
--
--        **The losing carrier's account number and PIN live in `submission`.**
--        They are that carrier's credentials, not ours to spread: never synced
--        to a phone (this table is deliberately absent from the `powersync`
--        publication), never logged, and readable only by people who can
--        already manage the business's channels.
-- =============================================================================

create type app.number_port_kind as enum ('full', 'hosted_messaging');
create type app.number_port_status as enum (
  'draft', 'submitted', 'carrier_review', 'scheduled', 'complete', 'rejected', 'cancelled', 'failed'
);

create table app.number_ports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid references app.telephony_accounts (id) on delete set null,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  kind app.number_port_kind not null,
  status app.number_port_status not null default 'draft',
  -- The number here once it has landed, so calls and texts arrive where the history already is.
  phone_number_id uuid references app.phone_numbers (id) on delete set null,

  -- ---- what the business tells us ----
  -- The losing carrier's account number, PIN and service address. Secrets: see the header.
  submission jsonb not null default '{}'::jsonb check (jsonb_typeof(submission) = 'object'),
  -- Which papers are in. The documents themselves live in storage, never in this row.
  documents jsonb not null default '{}'::jsonb check (jsonb_typeof(documents) = 'object'),

  -- ---- what the carrier tells us: the worker's alone (private.guard_number_port_update) ----
  provider_sid text,
  provider_status text,
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 2000),
  last_error text,
  next_poll_at timestamptz,
  poll_count int not null default 0 check (poll_count >= 0),
  -- The day the carrier says it will actually move. A business plans around this one.
  scheduled_for date,
  submitted_at timestamptz,
  completed_at timestamptz,

  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live port per number: asking twice for the same number is a mistake, not a second request.
create unique index number_ports_one_live_per_e164 on app.number_ports (e164)
  where status in ('draft', 'submitted', 'carrier_review', 'scheduled');
create index number_ports_workspace_idx on app.number_ports (workspace_id, created_at desc);
-- Twin of telephony_registrations_poll_idx: the poller reads only what is actually with the carrier.
create index number_ports_poll_idx on app.number_ports (next_poll_at)
  where status in ('submitted', 'carrier_review', 'scheduled');

create trigger number_ports_updated_at before update on app.number_ports
  for each row execute function private.set_updated_at();
create trigger number_ports_immutable before update on app.number_ports
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'e164', 'created_by');

-- ---------- the carrier's side is ours, and a sent port is frozen ----------
-- Twin of private.guard_registration_update(), for the same reasons: a person may draft and send, and may
-- fix and resend one that was turned down. Everything the carrier said is the worker's to write.
create or replace function private.guard_number_port_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.provider_sid is distinct from new.provider_sid
     or old.provider_status is distinct from new.provider_status
     or old.rejection_reason is distinct from new.rejection_reason
     or old.last_error is distinct from new.last_error
     or old.next_poll_at is distinct from new.next_poll_at
     or old.poll_count is distinct from new.poll_count
     or old.scheduled_for is distinct from new.scheduled_for
     or old.submitted_at is distinct from new.submitted_at
     or old.completed_at is distinct from new.completed_at
     or old.phone_number_id is distinct from new.phone_number_id
     or old.account_id is distinct from new.account_id then
    raise exception 'Only HandsFreeOS records what the carrier said'
      using errcode = '42501', detail = 'number_port_provider_fields';
  end if;
  if old.status not in ('draft', 'rejected', 'failed')
     and (old.status is distinct from new.status
       or old.submission is distinct from new.submission
       or old.documents is distinct from new.documents
       or old.kind is distinct from new.kind) then
    raise exception 'A port already with the carrier cannot be changed'
      using errcode = '42501', detail = 'number_port_with_carrier';
  end if;
  if old.status is distinct from new.status and new.status not in ('draft', 'submitted', 'cancelled') then
    raise exception 'People can only save, send or call off a port'
      using errcode = '42501', detail = 'number_port_status_transition';
  end if;
  return new;
end $$;
create trigger number_ports_update_guard before update on app.number_ports
  for each row execute function private.guard_number_port_update();

-- ---------- who may see it ----------
-- The same permission as buying or releasing a number, because it is the same decision: which numbers this
-- business has. `channels.manage` is owner and admin only, which is also what keeps the losing carrier's
-- PIN away from everybody else.
alter table app.number_ports enable row level security;

create policy number_ports_select on app.number_ports for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy number_ports_insert on app.number_ports for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy number_ports_update on app.number_ports for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy number_ports_service_all on app.number_ports for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.number_ports from public;
-- No delete: a port that was called off says so, and a business that asked to move its number should be able
-- to see that it did, months later.
grant select, insert, update on app.number_ports to authenticated;
grant select, insert, update, delete on app.number_ports to service_actor;

revoke all on function private.guard_number_port_update() from public;

-- ---------- a migration's port request points here ----------
-- One column, no semantics moved: the migration UI keeps reading its own table, and the carrier machinery
-- lives in exactly one place.
alter table app.migration_port_requests
  add column number_port_id uuid references app.number_ports (id) on delete set null;

comment on column app.migration_port_requests.number_port_id is
  'The port that actually moves this number, once one is started. The carrier machinery lives on '
  'app.number_ports; this table stays the record of what was found at the old CRM and whether it moved.';

-- ---------- a number being ported is claimed ----------
-- `phone_numbers_live_e164` says a live number routes to exactly one workspace. A number on its way to us
-- has to be part of that, or two businesses could both be porting the same number in and the second would
-- find it taken the day it landed.
drop index app.phone_numbers_live_e164;
create unique index phone_numbers_live_e164 on app.phone_numbers (e164)
  where status in ('provisioning', 'porting', 'active', 'releasing');

-- The default, though, must still be a number that can actually send. `porting` deliberately is not.
drop index app.phone_numbers_one_default;
create unique index phone_numbers_one_default on app.phone_numbers (workspace_id)
  where is_default and status in ('provisioning', 'active', 'releasing');

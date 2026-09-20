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

-- Two rules that look like one, and are not.
--
-- **Once a port is actually sent**, one business in the world is moving that number, because a carrier can
-- only move it to one place. But a *draft* is a business writing down what it wants, and written down as one
-- index across every workspace it meant something much worse: anybody could stop anybody else from so much
-- as drafting a port, forever, by keeping a draft of their own alive — and the 23505 said out loud that
-- somebody else had that number. `number_port.start`'s own "asking twice is a mistake, not a second request"
-- check is workspace-scoped (commands/port.ts), which is the rule that actually belongs to a business.
--
-- The global claim on a number being moved is staked at send, by phone_numbers_live_e164 below.
create unique index number_ports_one_live_per_e164 on app.number_ports (e164)
  where status in ('submitted', 'carrier_review', 'scheduled');
create unique index number_ports_one_open_per_workspace on app.number_ports (workspace_id, e164)
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
declare
  /*
   * Pressing Send. Two of the columns below move on this one transition and nowhere else: a person really
   * does press Send, which stamps the time and clears whatever the carrier said last time.
   *
   * `phone_number_id` is deliberately **not** one of them. Claiming the number is the database's own act —
   * private.port_claim_number below — so a person never writes it, on this transition or any other.
   */
  v_sending boolean := old.status in ('draft', 'rejected', 'failed') and new.status = 'submitted';
  /*
   * Calling it off. A port that is already with the carrier is frozen — that is the next rule down — but
   * *cancelling* it is the one thing a business must still be able to do, and freezing it froze that too:
   * `number_port.cancel` was refused for every port past `draft`, which is every port worth cancelling.
   * Its own description says "The carrier may already have moved it", and `onPortCancelled` only asks the
   * carrier to stop when there is a provider sid — that is, only for the ports this refused.
   */
  v_calling_off boolean := old.status <> 'complete' and new.status = 'cancelled';
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.provider_sid is distinct from new.provider_sid
     or old.provider_status is distinct from new.provider_status
     or old.last_error is distinct from new.last_error
     or old.next_poll_at is distinct from new.next_poll_at
     or old.poll_count is distinct from new.poll_count
     or old.scheduled_for is distinct from new.scheduled_for
     or old.completed_at is distinct from new.completed_at
     or old.account_id is distinct from new.account_id
     or old.phone_number_id is distinct from new.phone_number_id
     -- Off Send, the other two are the worker's like the rest.
     or (not v_sending and (old.submitted_at is distinct from new.submitted_at
                         or old.rejection_reason is distinct from new.rejection_reason))
     -- And on it, narrowly: the stamp is set rather than cleared, and a rejection is only ever cleared —
     -- never invented by the person resending.
     or (v_sending and (new.submitted_at is null or new.rejection_reason is not null)) then
    raise exception 'Only HandsFreeOS records what the carrier said'
      using errcode = '42501', detail = 'number_port_provider_fields';
  end if;
  if old.status not in ('draft', 'rejected', 'failed') and not v_calling_off
     and (old.status is distinct from new.status
       or old.submission is distinct from new.submission
       or old.documents is distinct from new.documents
       or old.kind is distinct from new.kind) then
    raise exception 'A port already with the carrier cannot be changed'
      using errcode = '42501', detail = 'number_port_with_carrier';
  end if;
  -- And calling off is only calling off: the papers do not change on the way out.
  if v_calling_off and (old.submission is distinct from new.submission
                     or old.documents is distinct from new.documents
                     or old.kind is distinct from new.kind) then
    raise exception 'Calling a port off changes nothing else about it'
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

-- ---------- claiming the number, and giving it back, are the database's own acts ----------
-- A port is the one thing a person does that has to move a phone number through states only HandsFreeOS may
-- write. `number_port.submit` takes the e164 off the market before the papers go to the carrier — between
-- claiming and sending, another business could ask for the same number — and `number_port.cancel` puts it
-- back. Both are pressed by a person.
--
-- Written as ordinary command SQL, every one of those writes is refused, and rightly:
--
--   phone_numbers_insert   with check (… and status = 'provisioning' and …)   → 'porting' is not that
--   phone_numbers_insert   with check (… created_by = auth.uid() …)           → the port's author, not the sender
--   guard_phone_number_update   a person may only go active|provisioning → releasing
--   guard_phone_number_update   released_at is a provider field
--
-- Those four rules are what stop anybody conjuring a number that routes real calls, so they are not widened.
-- Instead the claim becomes the database's, exactly as private.staff_credit_wallet (0092) made the support
-- credit the database's: the function asks the permission question **for itself** rather than trusting its
-- caller, sets the system scope for the length of its own writes, and hands back what it did.
--
-- **The scope is saved and restored, not cleared.** staff_credit_wallet can clear to '' on the way out
-- because nothing calls it from inside a worker's transaction. These two are called from both sides —
-- `number_port.complete` runs as the worker, which already holds the scope for its whole transaction — and
-- clearing it there would leave every statement after this one matching no rows under the service_actor
-- policies, silently.
create or replace function private.port_claim_number(p_port uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_e164 text;
  v_by uuid;
  v_held uuid;
  v_number uuid;
  v_prev text := current_setting('app.system_scope.workspace_id', true);
begin
  select p.workspace_id, p.e164, p.created_by, p.phone_number_id
    into v_ws, v_e164, v_by, v_held
    from app.number_ports p where p.id = p_port;
  if v_ws is null then
    raise exception 'No port with that id' using errcode = '23503', detail = 'no_number_port';
  end if;
  if not (coalesce(private.system_scope_workspace() = v_ws, false)
          or private.has_permission(v_ws, 'channels.manage')) then
    raise exception 'You cannot move this business''s numbers'
      using errcode = '42501', detail = 'number_port_not_yours';
  end if;

  -- Somebody else is already moving it. This function can see across businesses where the person calling it
  -- cannot, so it says so plainly rather than letting the insert below fail on phone_numbers_live_e164 and
  -- reach a business as "That already exists."
  if exists (select 1 from app.phone_numbers n
             where n.e164 = v_e164 and n.workspace_id <> v_ws
               and n.status in ('provisioning', 'porting', 'active', 'releasing')) then
    raise exception 'That number is already with another business'
      using errcode = '23505', detail = 'number_already_moving';
  end if;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);

  -- The port's own row first, then any row this business already has for the number: a port that was turned
  -- down and is being sent again re-takes the same row rather than leaving a released one behind it.
  --
  -- **Ordered, because a business can hold several rows for one e164** — every release-and-re-port leaves
  -- one behind. `limit 1` with no order picks whatever the plan hands back, and picking a released row while
  -- a live sibling exists collides with phone_numbers_live_e164 the moment it is set to `porting`.
  if v_held is null then
    select n.id into v_held from app.phone_numbers n
      where n.workspace_id = v_ws and n.e164 = v_e164
      order by (n.status in ('porting', 'active')) desc, n.created_at desc
      limit 1;
  end if;

  if v_held is null then
    -- Local unless the carrier says otherwise when it lands. Toll-free ports are rare and get corrected
    -- then; guessing toll-free here would send the wrong registration chain.
    insert into app.phone_numbers (workspace_id, e164, number_type, status, created_by)
    values (v_ws, v_e164, 'local', 'porting', v_by)
    returning id into v_number;
  else
    /*
     * **Never demotes a working number.** `private.phone_route()` only answers for an `active` number, so
     * moving one to `porting` takes it off routing outright: every call and text to it would reach nobody.
     * A business that already holds the number and starts a second port for it would do exactly that, and
     * so would `number_port.complete` if it ever ran twice. A number that is already theirs and already
     * working needs no claiming — it is claimed.
     */
    update app.phone_numbers set status = 'porting', released_at = null
      where id = v_held and status <> 'active';
    v_number := v_held;
  end if;

  if v_number is null then
    raise exception 'That number could not be claimed' using errcode = '23503', detail = 'no_number_port';
  end if;

  update app.number_ports set phone_number_id = v_number where id = p_port;

  perform set_config('app.system_scope.workspace_id', coalesce(v_prev, ''), true);
  return v_number;
end $$;

-- Let the number go again. A port that is off — called off, turned down, failed — must not keep another
-- business from trying for the same number, and must not keep counting against this one's ceiling. The port
-- keeps pointing at the row: a business that tried to move a number should be able to see that it tried.
create or replace function private.port_release_number(p_port uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_number uuid;
  v_prev text := current_setting('app.system_scope.workspace_id', true);
begin
  select p.workspace_id, p.phone_number_id into v_ws, v_number
    from app.number_ports p where p.id = p_port;
  if v_ws is null then
    raise exception 'No port with that id' using errcode = '23503', detail = 'no_number_port';
  end if;
  if not (coalesce(private.system_scope_workspace() = v_ws, false)
          or private.has_permission(v_ws, 'channels.manage')) then
    raise exception 'You cannot move this business''s numbers'
      using errcode = '42501', detail = 'number_port_not_yours';
  end if;
  if v_number is null then
    return;
  end if;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);
  -- Only a number this port is actually holding. A number that already landed is `active` and is the
  -- business's own now: cancelling a stale port row must never take a working number off them.
  update app.phone_numbers set status = 'released', released_at = now()
    where id = v_number and status = 'porting';
  perform set_config('app.system_scope.workspace_id', coalesce(v_prev, ''), true);
end $$;

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
revoke all on function private.port_claim_number(uuid) from public;
revoke all on function private.port_release_number(uuid) from public;
-- Both ask their own permission question, so handing them to `authenticated` hands over nothing: a person
-- without `channels.manage` on that business gets the same refusal they would have got from the policy.
grant execute on function private.port_claim_number(uuid) to authenticated, service_actor;
grant execute on function private.port_release_number(uuid) to authenticated, service_actor;

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

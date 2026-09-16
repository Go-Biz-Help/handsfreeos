-- =============================================================================
-- 0056 · Who sees what, stored where a sync service can read it. PowerSync
--        reads the database past RLS and decides what reaches each phone from
--        the rows themselves, so every rule a phone's copy follows has to be
--        a value on a row, kept equal to the RLS rule it stands for:
--          - app.workspace_access: each person's effective role in each
--            business they can open, agency (organization) roles flattened
--            in, exactly private.effective_workspace_role(). One sync bucket
--            per business kept offline, and the gate every business stream
--            checks.
--          - app.users.member_workspace_ids / member_organization_ids: the
--            businesses and agencies a person belongs to directly, so a
--            business's copy carries the names of its own team (and an
--            agency's copy its people) without one bucket per person.
--          - member_viewer_ids on estimates, invoices, their lines, payments
--            and refunds: the members who may see the document under
--            private.money_member_sees() (the lead's assignee, or active staff
--            on the booking), restricted to people whose role in the business
--            is a member's. One bucket per member for all of it.
--          - sync_window on the tables that only keep recent history on a
--            phone: messages, calls and the timeline (12 months, never for an
--            open conversation), appointments with their attendees and staff
--            (90 days back), and closed estimates and invoices with their
--            lines, payments and refunds (12 months; open documents always).
--            PowerSync's rules can't compare dates, so the worker's nightly
--            job turns the flag off (private.sync_window_sweep) and triggers
--            turn it back on the moment something comes back into the window.
--        All of it is kept by SECURITY DEFINER triggers, so it holds whoever
--        writes, and so the document guards (a sent document's lines refuse
--        people's writes) step aside for them. None of it is an edit: the
--        updated_at triggers ignore a write that changes only these columns.
--        Parity helpers and grants for the new table are in 0060
--        (20260921000700_mobile_grants.sql).
-- =============================================================================

-- ======================================================================
-- 1 · app.workspace_access
-- ======================================================================
create table app.workspace_access (
  user_id uuid not null references app.users (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The highest of the person's direct role in the business and their agency role reaching it.
  role app.member_role not null,
  primary key (user_id, workspace_id)
);
create index workspace_access_workspace_idx on app.workspace_access (workspace_id);

-- One person in one business, recomputed from the memberships exactly as private.effective_workspace_role() reads
-- them (and ranks them). A person or business on its way out (a cascade in progress) has no access.
create or replace function private.refresh_workspace_access(p_user uuid, p_ws uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  if not exists (select 1 from app.users u where u.id = p_user)
     or not exists (select 1 from app.workspaces w where w.id = p_ws) then
    delete from app.workspace_access a where a.user_id = p_user and a.workspace_id = p_ws;
    return;
  end if;
  select r.role into v_role from (
    select wm.role::text as role from app.workspace_memberships wm
    where wm.workspace_id = p_ws and wm.user_id = p_user
    union all
    select om.role::text from app.organization_memberships om
    join app.workspaces w on w.organization_id = om.organization_id
    where w.id = p_ws and om.user_id = p_user
  ) r
  order by private.role_rank(r.role) desc
  limit 1;
  if v_role is null then
    delete from app.workspace_access a where a.user_id = p_user and a.workspace_id = p_ws;
  else
    insert into app.workspace_access as a (user_id, workspace_id, role)
    values (p_user, p_ws, v_role::app.member_role)
    on conflict (user_id, workspace_id) do update set role = excluded.role
      where a.role is distinct from excluded.role;
  end if;
end $$;

create or replace function private.workspace_membership_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.refresh_workspace_access(old.user_id, old.workspace_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.refresh_workspace_access(new.user_id, new.workspace_id);
  end if;
  return null;
end $$;
create trigger workspace_memberships_access after insert or delete or update of role, user_id, workspace_id
  on app.workspace_memberships for each row execute function private.workspace_membership_access();

-- An agency role reaches every business of the agency.
create or replace function private.organization_membership_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.refresh_workspace_access(old.user_id, w.id)
    from app.workspaces w where w.organization_id = old.organization_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.refresh_workspace_access(new.user_id, w.id)
    from app.workspaces w where w.organization_id = new.organization_id;
  end if;
  return null;
end $$;
create trigger organization_memberships_access after insert or delete or update of role, user_id, organization_id
  on app.organization_memberships for each row execute function private.organization_membership_access();

-- A new business reaches its agency's people; one that moved agency (organization_id is immutable today, 0002)
-- leaves the old agency's people and reaches the new one's.
create or replace function private.workspace_organization_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    perform private.refresh_workspace_access(om.user_id, new.id)
    from app.organization_memberships om where om.organization_id = old.organization_id;
  end if;
  perform private.refresh_workspace_access(om.user_id, new.id)
  from app.organization_memberships om where om.organization_id = new.organization_id;
  return null;
end $$;
create trigger workspaces_access after insert or update of organization_id on app.workspaces
  for each row execute function private.workspace_organization_access();

-- Everyone who can open a business today.
insert into app.workspace_access (user_id, workspace_id, role)
select x.user_id, x.workspace_id, (array_agg(x.role order by private.role_rank(x.role) desc))[1]::app.member_role
from (
  select wm.user_id, wm.workspace_id, wm.role::text as role from app.workspace_memberships wm
  union all
  select om.user_id, w.id, om.role::text from app.organization_memberships om
  join app.workspaces w on w.organization_id = om.organization_id
) x
group by x.user_id, x.workspace_id;

-- A person reads their own rows (the list of businesses they can open, and as what); the worker reads the rows of
-- the business it is scoped to. Nobody writes them but the triggers above.
alter table app.workspace_access enable row level security;
create policy workspace_access_select on app.workspace_access for select to authenticated
  using (user_id = (select auth.uid()));
create policy workspace_access_service_select on app.workspace_access for select to service_actor
  using (workspace_id = private.system_scope_workspace());

-- ======================================================================
-- 2 · The businesses and agencies a person belongs to directly
-- ======================================================================
-- A business's copy names its team (direct members, whom everyone in the business may see) and an agency's copy
-- its people (whom only the agency's own people may see), so each person's row says where they belong.
alter table app.users
  add column member_workspace_ids uuid[] not null default '{}',
  add column member_organization_ids uuid[] not null default '{}';
comment on column app.users.member_workspace_ids is
  'The businesses this person is a direct member of, kept by triggers on app.workspace_memberships for the phone''s sync.';
comment on column app.users.member_organization_ids is
  'The agencies (organizations) this person belongs to, kept by triggers on app.organization_memberships for the phone''s sync.';

create or replace function private.refresh_user_memberships(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  with m as (
    select
      coalesce((select array_agg(wm.workspace_id order by wm.workspace_id)
        from app.workspace_memberships wm where wm.user_id = p_user), '{}'::uuid[]) as workspaces,
      coalesce((select array_agg(om.organization_id order by om.organization_id)
        from app.organization_memberships om where om.user_id = p_user), '{}'::uuid[]) as organizations
  )
  update app.users u set member_workspace_ids = m.workspaces, member_organization_ids = m.organizations
  from m
  where u.id = p_user
    and (u.member_workspace_ids is distinct from m.workspaces or u.member_organization_ids is distinct from m.organizations)
$$;

create or replace function private.membership_user_lists()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.refresh_user_memberships(old.user_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.user_id is distinct from old.user_id) then
    perform private.refresh_user_memberships(new.user_id);
  end if;
  return null;
end $$;
create trigger workspace_memberships_user_lists after insert or delete or update of user_id, workspace_id
  on app.workspace_memberships for each row execute function private.membership_user_lists();
create trigger organization_memberships_user_lists after insert or delete or update of user_id, organization_id
  on app.organization_memberships for each row execute function private.membership_user_lists();

-- ======================================================================
-- 3 · Bookkeeping isn't an edit: updated_at
-- ======================================================================
-- Each table below keeps private.set_updated_at for every ordinary write, now only when no bookkeeping column
-- changed (a cheap WHEN, no row conversion), and gets a second trigger for writes that did change one: those keep
-- updated_at when the bookkeeping is all that changed. A write that changes nothing at all still moves
-- updated_at, as before, because money drafts use it as their revision (money-shared.ts). Generated columns are
-- named in the trigger's arguments: a BEFORE trigger sees them unset. Same trigger names first, so they keep their
-- place (triggers fire in name order, and the bookkeeping triggers below sort before them).
create or replace function private.set_updated_at_unless_bookkeeping()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_ignored text[] := array['updated_at', 'sync_window', 'member_viewer_ids', 'member_workspace_ids',
    'member_organization_ids'] || tg_argv;
begin
  if (to_jsonb(new) - v_ignored) = (to_jsonb(old) - v_ignored) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

alter table app.messages add column sync_window boolean not null default true;
alter table app.calls add column sync_window boolean not null default true;
alter table app.activities add column sync_window boolean not null default true;
alter table app.appointments add column sync_window boolean not null default true;
alter table app.appointment_attendees add column sync_window boolean not null default true;
alter table app.appointment_staff add column sync_window boolean not null default true;
alter table app.estimates
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';
alter table app.invoices
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';
alter table app.estimate_lines
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';
alter table app.invoice_lines
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';
alter table app.payments
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';
alter table app.refunds
  add column sync_window boolean not null default true,
  add column member_viewer_ids uuid[] not null default '{}';

drop trigger users_updated_at on app.users;
create trigger users_updated_at before update on app.users for each row
  when (old.member_workspace_ids is not distinct from new.member_workspace_ids
    and old.member_organization_ids is not distinct from new.member_organization_ids)
  execute function private.set_updated_at();
create trigger users_updated_at_bookkeeping before update on app.users for each row
  when (old.member_workspace_ids is distinct from new.member_workspace_ids
    or old.member_organization_ids is distinct from new.member_organization_ids)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger messages_updated_at on app.messages;
create trigger messages_updated_at before update on app.messages for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
create trigger messages_updated_at_bookkeeping before update on app.messages for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger calls_updated_at on app.calls;
create trigger calls_updated_at before update on app.calls for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
create trigger calls_updated_at_bookkeeping before update on app.calls for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger activities_updated_at on app.activities;
create trigger activities_updated_at before update on app.activities for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
create trigger activities_updated_at_bookkeeping before update on app.activities for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger appointments_updated_at on app.appointments;
create trigger appointments_updated_at before update on app.appointments for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
create trigger appointments_updated_at_bookkeeping before update on app.appointments for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger appointment_attendees_updated_at on app.appointment_attendees;
create trigger appointment_attendees_updated_at before update on app.appointment_attendees for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
create trigger appointment_attendees_updated_at_bookkeeping before update on app.appointment_attendees for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger estimates_updated_at on app.estimates;
create trigger estimates_updated_at before update on app.estimates for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger estimates_updated_at_bookkeeping before update on app.estimates for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger invoices_updated_at on app.invoices;
create trigger invoices_updated_at before update on app.invoices for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger invoices_updated_at_bookkeeping before update on app.invoices for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping('balance_cents');

drop trigger estimate_lines_updated_at on app.estimate_lines;
create trigger estimate_lines_updated_at before update on app.estimate_lines for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger estimate_lines_updated_at_bookkeeping before update on app.estimate_lines for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger invoice_lines_updated_at on app.invoice_lines;
create trigger invoice_lines_updated_at before update on app.invoice_lines for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger invoice_lines_updated_at_bookkeeping before update on app.invoice_lines for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger payments_updated_at on app.payments;
create trigger payments_updated_at before update on app.payments for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger payments_updated_at_bookkeeping before update on app.payments for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping();

drop trigger refunds_updated_at on app.refunds;
create trigger refunds_updated_at before update on app.refunds for each row
  when (old.sync_window is not distinct from new.sync_window
    and old.member_viewer_ids is not distinct from new.member_viewer_ids)
  execute function private.set_updated_at();
create trigger refunds_updated_at_bookkeeping before update on app.refunds for each row
  when (old.sync_window is distinct from new.sync_window
    or old.member_viewer_ids is distinct from new.member_viewer_ids)
  execute function private.set_updated_at_unless_bookkeeping();

-- Everyone's direct memberships today. Only the rows that gain a list are written, so nobody else's updated_at moves.
update app.users u set member_workspace_ids = m.workspaces, member_organization_ids = m.organizations
from (
  select x.id,
    coalesce((select array_agg(wm.workspace_id order by wm.workspace_id)
      from app.workspace_memberships wm where wm.user_id = x.id), '{}'::uuid[]) as workspaces,
    coalesce((select array_agg(om.organization_id order by om.organization_id)
      from app.organization_memberships om where om.user_id = x.id), '{}'::uuid[]) as organizations
  from app.users x
) m
where m.id = u.id
  and (u.member_workspace_ids is distinct from m.workspaces or u.member_organization_ids is distinct from m.organizations);

-- ======================================================================
-- 4 · sync_window
-- ======================================================================
-- Appointments: in the window while they ended no more than 90 days ago, worked out on every write, so a visit
-- moved into the future comes back at once.
create or replace function private.appointment_sync_window()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sync_window := new.ends_at >= now() - interval '90 days';
  return new;
end $$;
create trigger appointments_sync_window before insert or update on app.appointments
  for each row execute function private.appointment_sync_window();

-- Attendees and staff carry their appointment's flag (the flag has to be on the synced row itself).
create or replace function private.appointment_child_sync_window()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_window boolean;
begin
  select a.sync_window into v_window from app.appointments a where a.id = new.appointment_id;
  new.sync_window := coalesce(v_window, true);
  return new;
end $$;
create trigger appointment_attendees_sync_window before insert or update of appointment_id, sync_window
  on app.appointment_attendees for each row execute function private.appointment_child_sync_window();
create trigger appointment_staff_sync_window before insert or update of appointment_id, sync_window
  on app.appointment_staff for each row execute function private.appointment_child_sync_window();

-- WHEN rather than UPDATE OF: the flag usually changes in the BEFORE trigger above, not in the statement.
create or replace function private.appointment_propagate_sync_window()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.appointment_attendees a set sync_window = new.sync_window
  where a.appointment_id = new.id and a.sync_window is distinct from new.sync_window;
  update app.appointment_staff s set sync_window = new.sync_window
  where s.appointment_id = new.id and s.sync_window is distinct from new.sync_window;
  return null;
end $$;
create trigger appointments_propagate_sync_window after update on app.appointments for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.appointment_propagate_sync_window();

-- A message, call or timeline entry whose time is edited back into the last 12 months comes back at once (the
-- sweep only ever hides). The column is the trigger's argument.
create or replace function private.restore_sync_window_by_time()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) ->> tg_argv[0])::timestamptz >= now() - interval '12 months' then
    new.sync_window := true;
  end if;
  return new;
end $$;
create trigger messages_restore_sync_window before update of occurred_at on app.messages
  for each row execute function private.restore_sync_window_by_time('occurred_at');
create trigger calls_restore_sync_window before update of started_at on app.calls
  for each row execute function private.restore_sync_window_by_time('started_at');
create trigger activities_restore_sync_window before update of occurred_at on app.activities
  for each row execute function private.restore_sync_window_by_time('occurred_at');

-- A conversation that opens again (a customer from two years ago writes) brings its whole history back.
create or replace function private.conversation_restore_sync_window()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.messages m set sync_window = true where m.conversation_id = new.id and not m.sync_window;
  update app.calls c set sync_window = true where c.conversation_id = new.id and not c.sync_window;
  return null;
end $$;
create trigger conversations_restore_sync_window after update on app.conversations for each row
  when (old.status = 'closed' and new.status <> 'closed')
  execute function private.conversation_restore_sync_window();

-- System timeline entries are immutable (0006) for every role, the table's owner included; moving one in or out of a
-- phone's window isn't changing what it says, so a write that changes nothing but the flag goes through.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.kind = 'system' then
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at']) = (to_jsonb(old) - array['sync_window', 'updated_at']) then
      return new;
    end if;
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- The worker's nightly job, for the business it is scoped to: hides what has left the window, a batch per table
-- at a time (call again while any count equals the limit). Messages and calls stay while their conversation is
-- open or snoozed; estimates and invoices only go once closed (an estimate accepted, declined, expired or void;
-- an invoice paid or void), 12 months after they closed. Lines, payments and refunds follow their document, and
-- attendees and staff their appointment, through the triggers.
create or replace function private.sync_window_sweep(p_workspace uuid, p_limit integer default 10000)
returns table (table_name text, hidden integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_year constant timestamptz := now() - interval '12 months';
  v_quarter constant timestamptz := now() - interval '90 days';
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 10000), 1000000));
  v_count integer;
begin
  if p_workspace is null or p_workspace is distinct from private.system_scope_workspace() then
    raise exception 'The sweep runs for the business the worker is scoped to'
      using errcode = '42501', detail = 'sync_window_scope';
  end if;

  update app.messages m set sync_window = false
  where m.id in (
    select x.id from app.messages x
    where x.workspace_id = p_workspace and x.sync_window and x.occurred_at < v_year
      and not exists (select 1 from app.conversations c where c.id = x.conversation_id and c.status <> 'closed')
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'messages'; hidden := v_count; return next;

  update app.calls c set sync_window = false
  where c.id in (
    select x.id from app.calls x
    where x.workspace_id = p_workspace and x.sync_window and x.started_at < v_year
      and not exists (select 1 from app.conversations v where v.id = x.conversation_id and v.status <> 'closed')
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'calls'; hidden := v_count; return next;

  update app.activities a set sync_window = false
  where a.id in (
    select x.id from app.activities x
    where x.workspace_id = p_workspace and x.sync_window and x.occurred_at < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'activities'; hidden := v_count; return next;

  -- The appointments' own trigger works the flag out from ends_at; the update only asks it to.
  update app.appointments a set sync_window = false
  where a.id in (
    select x.id from app.appointments x
    where x.workspace_id = p_workspace and x.sync_window and x.starts_at < v_quarter and x.ends_at < v_quarter
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'appointments'; hidden := v_count; return next;

  update app.estimates e set sync_window = false
  where e.id in (
    select x.id from app.estimates x
    where x.workspace_id = p_workspace and x.sync_window
      and x.status in ('accepted', 'declined', 'expired', 'void')
      and coalesce(x.voided_at, x.declined_at, x.accepted_at, x.expires_on::timestamp at time zone 'UTC', x.updated_at) < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'estimates'; hidden := v_count; return next;

  update app.invoices i set sync_window = false
  where i.id in (
    select x.id from app.invoices x
    where x.workspace_id = p_workspace and x.sync_window and x.status in ('paid', 'void')
      and coalesce(x.voided_at, x.paid_at, x.updated_at) < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'invoices'; hidden := v_count; return next;
end $$;

-- What the sweep reads: the rows still in the window, oldest first (calls and appointments already have one).
create index messages_sync_window_idx on app.messages (workspace_id, occurred_at) where sync_window;
create index activities_sync_window_idx on app.activities (workspace_id, occurred_at) where sync_window;

-- ======================================================================
-- 5 · Members' money: member_viewer_ids
-- ======================================================================
-- The members who may see a document: the lead's assignee, or active staff on the booking it is for — the two arms
-- of private.money_member_sees() — among people whose role in the business may read money and may not manage it
-- (the member policies of 0050). A document tied to neither has nobody here: it is owner business.
create or replace function private.money_member_viewers(p_ws uuid, p_lead uuid, p_attendee uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct v.user_id order by v.user_id), '{}'::uuid[])
  from (
    select l.assignee_user_id as user_id from app.leads l
    where l.id = p_lead and l.workspace_id = p_ws and l.assignee_user_id is not null
    union
    select s.user_id from app.appointment_staff s
    where s.appointment_id = (select a.appointment_id from app.appointment_attendees a where a.id = p_attendee)
      and s.active and s.workspace_id = p_ws
  ) v
  join app.workspace_access wa on wa.user_id = v.user_id and wa.workspace_id = p_ws
  where exists (select 1 from app.role_permissions rp where rp.role = wa.role::text and rp.permission = 'money.read')
    and not exists (select 1 from app.role_permissions rp where rp.role = wa.role::text and rp.permission = 'money.manage')
$$;

-- On every write of an estimate or an invoice: its viewers, recomputed (so nobody can write them by hand), and an
-- open document back in the window.
create or replace function private.money_document_sync_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'invoices' then
    new.member_viewer_ids := private.money_member_viewers(new.workspace_id, new.lead_id, new.attendee_id);
    if new.status in ('draft', 'sent', 'partly_paid', 'overdue') then
      new.sync_window := true;
    end if;
  else
    new.member_viewer_ids := private.money_member_viewers(new.workspace_id, new.lead_id, null);
    if new.status in ('draft', 'sent') then
      new.sync_window := true;
    end if;
  end if;
  return new;
end $$;
create trigger estimates_sync_columns before insert or update on app.estimates
  for each row execute function private.money_document_sync_columns();
create trigger invoices_sync_columns before insert or update on app.invoices
  for each row execute function private.money_document_sync_columns();

-- Lines, payments and refunds carry their document's viewers and window: copied when they are written (anything a
-- caller sends is replaced), and whenever the document's change (below).
create or replace function private.money_child_sync_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_viewers uuid[];
  v_window boolean;
begin
  if tg_table_name = 'estimate_lines' then
    select e.member_viewer_ids, e.sync_window into v_viewers, v_window from app.estimates e where e.id = new.estimate_id;
  else
    select i.member_viewer_ids, i.sync_window into v_viewers, v_window from app.invoices i where i.id = new.invoice_id;
  end if;
  new.member_viewer_ids := coalesce(v_viewers, '{}'::uuid[]);
  new.sync_window := coalesce(v_window, true);
  return new;
end $$;
create trigger estimate_lines_sync_columns before insert or update of estimate_id, member_viewer_ids, sync_window
  on app.estimate_lines for each row execute function private.money_child_sync_columns();
create trigger invoice_lines_sync_columns before insert or update of invoice_id, member_viewer_ids, sync_window
  on app.invoice_lines for each row execute function private.money_child_sync_columns();
create trigger payments_sync_columns before insert or update of invoice_id, member_viewer_ids, sync_window
  on app.payments for each row execute function private.money_child_sync_columns();
create trigger refunds_sync_columns before insert or update of invoice_id, member_viewer_ids, sync_window
  on app.refunds for each row execute function private.money_child_sync_columns();

-- A document's change reaches its lines, payments and refunds. As the definer: a sent document's lines refuse
-- people's writes (0045), and this runs inside whatever person's command changed the document.
create or replace function private.money_document_propagate_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'estimates' then
    update app.estimate_lines l set member_viewer_ids = new.member_viewer_ids, sync_window = new.sync_window
    where l.estimate_id = new.id
      and (l.member_viewer_ids is distinct from new.member_viewer_ids or l.sync_window is distinct from new.sync_window);
  else
    update app.invoice_lines l set member_viewer_ids = new.member_viewer_ids, sync_window = new.sync_window
    where l.invoice_id = new.id
      and (l.member_viewer_ids is distinct from new.member_viewer_ids or l.sync_window is distinct from new.sync_window);
    update app.payments p set member_viewer_ids = new.member_viewer_ids, sync_window = new.sync_window
    where p.invoice_id = new.id
      and (p.member_viewer_ids is distinct from new.member_viewer_ids or p.sync_window is distinct from new.sync_window);
    update app.refunds r set member_viewer_ids = new.member_viewer_ids, sync_window = new.sync_window
    where r.invoice_id = new.id
      and (r.member_viewer_ids is distinct from new.member_viewer_ids or r.sync_window is distinct from new.sync_window);
  end if;
  return null;
end $$;
create trigger estimates_propagate_sync after update on app.estimates for each row
  when (old.member_viewer_ids is distinct from new.member_viewer_ids or old.sync_window is distinct from new.sync_window)
  execute function private.money_document_propagate_sync();
create trigger invoices_propagate_sync after update on app.invoices for each row
  when (old.member_viewer_ids is distinct from new.member_viewer_ids or old.sync_window is distinct from new.sync_window)
  execute function private.money_document_propagate_sync();

-- The roll-up (0047, 0053) recounts an invoice from its payments' and refunds' statuses. It ran on every write of a
-- payment or refund; carrying the viewers and window down would now make each such copy rewrite the invoice (and
-- move its updated_at, which drafts use as their revision). What it counts only changes with a row's status, or
-- when a row arrives or goes, so that is when it runs. amount_cents and invoice_id never change (0047).
drop trigger payments_roll_up on app.payments;
create trigger payments_roll_up after insert or delete or update of status on app.payments
  for each row execute function private.money_roll_up_invoice();
drop trigger refunds_roll_up on app.refunds;
create trigger refunds_roll_up after insert or delete or update of status on app.refunds
  for each row execute function private.money_roll_up_invoice();

-- What moves a document's viewers: a lead's assignee, staff joining, leaving or going inactive on a booking, an
-- attendee moving to another appointment, and a person's role in the business changing (or their access ending).
create or replace function private.money_viewers_lead_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.estimates e set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null)
  where e.lead_id = new.id
    and e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null);
  update app.invoices i set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id)
  where i.lead_id = new.id
    and i.member_viewer_ids is distinct from private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id);
  return null;
end $$;
create trigger leads_money_viewers after update on app.leads for each row
  when (old.assignee_user_id is distinct from new.assignee_user_id)
  execute function private.money_viewers_lead_changed();

create or replace function private.money_viewers_booking_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_appointments uuid[];
begin
  if tg_table_name = 'appointment_attendees' then
    update app.invoices i set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id)
    where i.attendee_id = new.id
      and i.member_viewer_ids is distinct from private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id);
    return null;
  end if;
  -- Staff: the appointment (both, if the row moved) whose bookings' invoices may change.
  v_appointments := array_remove(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.appointment_id end,
    case when tg_op in ('INSERT', 'UPDATE') then new.appointment_id end], null);
  update app.invoices i set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id)
  where i.attendee_id in (
      select a.id from app.appointment_attendees a where a.appointment_id = any (v_appointments))
    and i.member_viewer_ids is distinct from private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id);
  return null;
end $$;
create trigger appointment_staff_money_viewers after insert or delete on app.appointment_staff
  for each row execute function private.money_viewers_booking_changed();
create trigger appointment_staff_money_viewers_changed after update on app.appointment_staff for each row
  when (old.active is distinct from new.active or old.user_id is distinct from new.user_id
    or old.appointment_id is distinct from new.appointment_id or old.workspace_id is distinct from new.workspace_id)
  execute function private.money_viewers_booking_changed();
create trigger appointment_attendees_money_viewers after update on app.appointment_attendees for each row
  when (old.appointment_id is distinct from new.appointment_id)
  execute function private.money_viewers_booking_changed();

-- A person's role in a business changed, or their access began or ended: every document they are, or may now be,
-- a viewer of there.
create or replace function private.money_viewers_access_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  update app.estimates e set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null)
  where e.id in (
      select x.id from app.estimates x where x.workspace_id = v_ws and x.member_viewer_ids @> array[v_user]
      union
      select x.id from app.estimates x join app.leads l on l.id = x.lead_id
      where l.workspace_id = v_ws and l.assignee_user_id = v_user)
    and e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null);
  update app.invoices i set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id)
  where i.id in (
      select x.id from app.invoices x where x.workspace_id = v_ws and x.member_viewer_ids @> array[v_user]
      union
      select x.id from app.invoices x join app.leads l on l.id = x.lead_id
      where l.workspace_id = v_ws and l.assignee_user_id = v_user
      union
      select x.id from app.invoices x
      join app.appointment_attendees a on a.id = x.attendee_id
      join app.appointment_staff s on s.appointment_id = a.appointment_id
      where s.workspace_id = v_ws and s.user_id = v_user and s.active)
    and i.member_viewer_ids is distinct from private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id);
  return null;
end $$;
create trigger workspace_access_money_viewers after insert or delete on app.workspace_access
  for each row execute function private.money_viewers_access_changed();
create trigger workspace_access_money_viewers_changed after update on app.workspace_access for each row
  when (old.role is distinct from new.role)
  execute function private.money_viewers_access_changed();

-- "Which documents is Marco a viewer of", for the access trigger above.
create index estimates_member_viewer_ids_idx on app.estimates using gin (member_viewer_ids);
create index invoices_member_viewer_ids_idx on app.invoices using gin (member_viewer_ids);

-- Every document's viewers today; the triggers carry them to lines, payments and refunds.
update app.estimates e set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null)
where e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null);
update app.invoices i set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id)
where i.member_viewer_ids is distinct from private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id);

-- And the window as it stands today, in every business (the sweep checks its caller's scope, so each pass names it).
do $$
declare
  w record;
begin
  for w in select id from app.workspaces loop
    perform set_config('app.system_scope.workspace_id', w.id::text, true);
    perform private.sync_window_sweep(w.id, 1000000);
  end loop;
  perform set_config('app.system_scope.workspace_id', '', true);
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.refresh_workspace_access(uuid, uuid), private.workspace_membership_access(),
  private.organization_membership_access(), private.workspace_organization_access(),
  private.refresh_user_memberships(uuid), private.membership_user_lists(),
  private.set_updated_at_unless_bookkeeping(), private.appointment_sync_window(),
  private.appointment_child_sync_window(), private.appointment_propagate_sync_window(),
  private.restore_sync_window_by_time(), private.conversation_restore_sync_window(),
  private.sync_window_sweep(uuid, integer), private.money_member_viewers(uuid, uuid, uuid),
  private.money_document_sync_columns(), private.money_child_sync_columns(), private.money_document_propagate_sync(),
  private.money_viewers_lead_changed(), private.money_viewers_booking_changed(), private.money_viewers_access_changed()
  from public;
grant execute on function
  private.workspace_membership_access(), private.organization_membership_access(),
  private.workspace_organization_access(), private.membership_user_lists(),
  private.set_updated_at_unless_bookkeeping(), private.appointment_sync_window(),
  private.appointment_child_sync_window(), private.appointment_propagate_sync_window(),
  private.restore_sync_window_by_time(), private.conversation_restore_sync_window(),
  private.money_document_sync_columns(), private.money_child_sync_columns(), private.money_document_propagate_sync(),
  private.money_viewers_lead_changed(), private.money_viewers_booking_changed(), private.money_viewers_access_changed()
  to authenticated, service_actor;
-- Deleting an account (Auth) removes the person's memberships, which runs the membership triggers.
grant execute on function
  private.workspace_membership_access(), private.organization_membership_access(), private.membership_user_lists()
  to supabase_auth_admin;
grant execute on function private.sync_window_sweep(uuid, integer) to service_actor;

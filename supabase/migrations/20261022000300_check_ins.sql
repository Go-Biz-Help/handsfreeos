-- =============================================================================
-- Check-ins: a person's safety when they're alone at a customer's place (Real
-- Estate round six, step 5; core).
--
--        The spec's X-41 asks for showing safety: check-in and check-out,
--        trusted contacts, a missed check-out escalated, and an emergency
--        path, without oversharing where anyone is. Chris decided
--        (2026-10-03) to build it in core for everyone (a technician alone in
--        a customer's home needs it too), with Real Estate first, and that an
--        outside contact gets a text and an email, once they've agreed by text.
--
--        **A person's own.** Their contacts (a teammate, or someone outside
--        with a phone and an email) and their check-ins are theirs alone: not
--        their owner's, not support's. Events and audit lines carry only ids,
--        never the place, because owners read the audit.
--
--        **A check-in** has a place (the appointment's address, or words), an
--        optional location taken as it starts, a planned end, and where it
--        stands: in, asked ("Still there?"), alerted (the contacts were told),
--        ok (someone said they're fine), out, or help. The phone makes its id,
--        so a check-in made with no signal still counts from when it was made.
--
--        **Who is told what.** At the planned end the worker asks the person;
--        if nobody answers, each contact gets the place, the planned end and
--        how to reach them: a teammate in the app, someone outside by text and
--        email with a link to a page that shows just this check-in. A teammate
--        alerted, and that page, read the check-in through the functions below,
--        and nothing else. (The worker's ladder and the page are step 11.)
-- =============================================================================

create table app.safety_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Whose contact this is.
  user_id uuid not null references app.users (id) on delete cascade,
  -- A teammate, told in the app; or someone outside, by name, phone and email.
  contact_user_id uuid references app.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  -- An outside contact agrees once, by text (Reply YES), before anything else is sent them.
  asked_at timestamptz,
  agreed_at timestamptz,
  stopped_at timestamptz,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_user_id is not null or phone_e164 is not null or email is not null),
  check (contact_user_id is distinct from user_id)
);
create index safety_contacts_owner_idx on app.safety_contacts (workspace_id, user_id);
create unique index safety_contacts_one_teammate on app.safety_contacts (workspace_id, user_id, contact_user_id)
  where contact_user_id is not null;
create trigger safety_contacts_updated_at before update on app.safety_contacts
  for each row execute function private.set_updated_at();
create trigger safety_contacts_immutable before update on app.safety_contacts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id');
comment on table app.safety_contacts is
  'Who a person wants told if they miss a check-out (round six): a teammate, or someone outside who agreed by text. Seen only by that person.';

create table app.safety_checkins (
  -- Made on the phone, so a check-in made with no signal is the same one when it arrives.
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  appointment_id uuid references app.appointments (id) on delete set null,
  place text not null check (length(btrim(place)) between 1 and 300),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  located_at timestamptz,
  started_at timestamptz not null,
  planned_end_at timestamptz not null,
  extended_count integer not null default 0,
  state text not null default 'in' check (state in ('in', 'asked', 'alerted', 'ok', 'out', 'help')),
  asked_at timestamptz,
  alerted_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  resolved_via text check (resolved_via is null or resolved_via in ('person', 'teammate', 'contact_page')),
  -- How many times the contacts have been told, and when last (the worker's ladder repeats every few minutes).
  alert_round integer not null default 0 check (alert_round between 0 and 20),
  last_alerted_at timestamptz,
  checked_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (planned_end_at > started_at),
  check (planned_end_at <= started_at + interval '12 hours')
);
create index safety_checkins_open_idx on app.safety_checkins (workspace_id, user_id)
  where state in ('in', 'asked', 'alerted', 'help');
create trigger safety_checkins_updated_at before update on app.safety_checkins
  for each row execute function private.set_updated_at();
create trigger safety_checkins_immutable before update on app.safety_checkins
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'started_at');
comment on table app.safety_checkins is
  'A person checked in somewhere alone, with a planned end (round six). Seen only by them; a teammate they asked to be told, and their outside contact''s page, read it through private.safety_checkin_for_contact().';

create table app.safety_escalations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  checkin_id uuid not null references app.safety_checkins (id) on delete cascade,
  contact_id uuid references app.safety_contacts (id) on delete set null,
  -- Who was told in the app: a teammate contact, or with nobody else to tell, the safety person or a manager.
  told_user_id uuid references app.users (id) on delete set null,
  channel text not null check (channel in ('app', 'email', 'text')),
  -- An outside contact's page: only the token's SHA-256 is kept.
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  round integer not null default 1 check (round between 1 and 20),
  sent_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
create index safety_escalations_checkin_idx on app.safety_escalations (checkin_id);
create index safety_escalations_contact_idx on app.safety_escalations (contact_id) where contact_id is not null;
create index safety_escalations_told_idx on app.safety_escalations (told_user_id) where told_user_id is not null;
comment on table app.safety_escalations is
  'Each time a contact was told about a missed check-out, and how (round six). Written by the worker.';

alter table app.safety_contacts enable row level security;
alter table app.safety_checkins enable row level security;
alter table app.safety_escalations enable row level security;

-- A person's own, in a business they can open.
create policy safety_contacts_own on app.safety_contacts for all to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids())
              and (contact_user_id is null or private.works_in(contact_user_id, workspace_id)));
create policy safety_checkins_own on app.safety_checkins for all to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
-- They see who was told, and when; never the token.
create policy safety_escalations_own on app.safety_escalations for select to authenticated
  using (checkin_id in (select c.id from app.safety_checkins c where c.user_id = (select auth.uid())));

create policy safety_contacts_service on app.safety_contacts for all to service_actor
  using (workspace_id = private.system_scope_workspace()) with check (workspace_id = private.system_scope_workspace());
create policy safety_checkins_service on app.safety_checkins for all to service_actor
  using (workspace_id = private.system_scope_workspace()) with check (workspace_id = private.system_scope_workspace());
create policy safety_escalations_service on app.safety_escalations for all to service_actor
  using (workspace_id = private.system_scope_workspace()) with check (workspace_id = private.system_scope_workspace());

grant select, insert, update, delete on app.safety_contacts to authenticated;
grant select, insert, update on app.safety_checkins to authenticated;
grant select (id, workspace_id, checkin_id, contact_id, told_user_id, channel, round, sent_at, acknowledged_at,
  created_at) on app.safety_escalations to authenticated;
grant select, insert, update, delete on app.safety_contacts, app.safety_checkins, app.safety_escalations to service_actor;
revoke all on app.safety_contacts, app.safety_checkins, app.safety_escalations from anon;

-- What a teammate who was told sees of a check-in: the place, the planned end and how to reach the person. Only
-- while it's theirs to answer (they were alerted, and it isn't settled), and only for them.
create or replace function private.safety_checkin_for_contact(p_ws uuid, p_checkin uuid)
returns table (id uuid, person_name text, person_phone text, place text, latitude numeric, longitude numeric,
               located_at timestamptz, started_at timestamptz, planned_end_at timestamptz, state text)
language sql stable security definer set search_path = '' as $$
  select c.id, coalesce(nullif(u.full_name, ''), u.email::text),
         (select p.e164 from app.user_phones p where p.user_id = c.user_id and p.verified_at is not null
          order by p.created_at limit 1),
         c.place, c.latitude, c.longitude, c.located_at, c.started_at, c.planned_end_at, c.state
  from app.safety_checkins c
  join app.users u on u.id = c.user_id
  where c.id = p_checkin and c.workspace_id = p_ws
    and p_ws in (select private.accessible_workspace_ids())
    and c.state in ('alerted', 'help')
    and exists (select 1 from app.safety_escalations e
                where e.checkin_id = c.id and e.channel = 'app' and e.told_user_id = auth.uid())
$$;
revoke all on function private.safety_checkin_for_contact(uuid, uuid) from public;
grant execute on function private.safety_checkin_for_contact(uuid, uuid) to authenticated;

-- A teammate who was told says they reached the person: the alerts stop for everyone.
create or replace function private.safety_resolve_as_contact(p_ws uuid, p_checkin uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.safety_checkin_for_contact(p_ws, p_checkin)) then
    return false;
  end if;
  update app.safety_checkins c
  set state = 'ok', resolved_at = now(), resolved_by = auth.uid(), resolved_via = 'teammate'
  where c.id = p_checkin and c.state in ('alerted', 'help');
  update app.safety_escalations e set acknowledged_at = now()
  where e.checkin_id = p_checkin and e.acknowledged_at is null;
  return true;
end $$;
revoke all on function private.safety_resolve_as_contact(uuid, uuid) from public;
grant execute on function private.safety_resolve_as_contact(uuid, uuid) to authenticated;

-- An outside contact's link: which check-in (and business) a token's hash opens, for the worker's public page. The
-- page works while the check-in is still being told about, and says it's settled after.
create or replace function private.safety_link_lookup(p_hash text)
returns table (workspace_id uuid, organization_id uuid, checkin_id uuid, escalation_id uuid, contact_id uuid)
language sql stable security definer set search_path = '' as $$
  select e.workspace_id, w.organization_id, e.checkin_id, e.id, e.contact_id
  from app.safety_escalations e
  join app.workspaces w on w.id = e.workspace_id
  where e.token_hash = p_hash
$$;
revoke all on function private.safety_link_lookup(text) from public;
grant execute on function private.safety_link_lookup(text) to service_actor;

-- ---------- the phone switch for it ----------
-- `safety`: a check-in's "Still there?" and a contact's alert (round six). Not a switch anyone turns off: a missed
-- one is a false alarm, or nobody told. Every switch 20261018000400 knows stays as it was.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key = 'safety' then
    return true;
  end if;
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons', 'supportTickets',
                                    'qualifying') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

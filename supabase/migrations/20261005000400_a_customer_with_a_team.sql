-- =============================================================================
-- 0103 · More than one person on a customer. A customer had one owner, and
--        real work is not shaped like that: one teammate installs a client's
--        automations while another runs their SEO, and both of them talk to
--        the client and bill them. So a person and a company now keep a team:
--        team_user_ids, everyone on the customer besides the owner.
--
--        **The owner stays the main person.** owner_user_id keeps meaning what
--        it has meant — who a hand-off falls back to, whose card a
--        maintenance reminder is, what "the customer's owner" names in a
--        workflow — and the team is everyone else on the customer. Taken
--        together they are "assigned to", which is how the screens say it.
--        The owner is never also in the team: a trigger takes them out, so
--        making a teammate the owner is one update, whoever writes it.
--
--        **Being on the team is being on the customer.** Two rules that
--        already decide what a member sees gain one arm each, so a member on
--        a customer's team sees what the customer's owner sees:
--
--          money   private.money_member_sees() — the lead's assignee, or staff
--                  on the booking — now also the customer's owner and team,
--                  for the estimates and invoices of that customer, and
--                  private.money_member_viewers(), the phone's copy of it
--          inbox   private.inbox_member_viewers() — the thread's assignee, or
--                  the people its number rings — now also the customer's owner
--                  and team, while a business narrows its inbox (0083)
--
--        Each keeps the shape 0050 and 0083 gave it: one definer function, the
--        stored lists kept by triggers (including a new one on the customer
--        themselves), and the parity helpers of 0057 and 0084 unchanged,
--        because they read the policies and the lists rather than a copy of
--        the rule. The three-argument forms stay, as the rule for a document
--        with no customer, so nothing that asks them the old way breaks
--        while it is being deployed.
--
--        **Owners and admins are unaffected**: they see all of it already.
--        Somebody who leaves the business stays listed, as an owner does
--        ("Former member"), and sees nothing, because both rules only ever
--        name people who can still open the business.
--
--        **Owners and admins decide who is on a customer.** Because being on
--        one now shows its bills and threads, a member who could put
--        themselves on any customer could read any of them. So changing an
--        existing customer's owner or team takes a new permission,
--        records.assign, which owners and admins have. A new customer is
--        anybody's to start (there is nothing on it to see yet), and the
--        system — imports, the booking page — is not asked.
-- =============================================================================

alter table app.people
  add column team_user_ids uuid[] not null default '{}'
    check (cardinality(team_user_ids) <= 20);
alter table app.companies
  add column team_user_ids uuid[] not null default '{}'
    check (cardinality(team_user_ids) <= 20);

comment on column app.people.team_user_ids is
  'Everyone on this customer besides the owner (0103), in the order they were added. Never the owner; always people of the business when they were added.';
comment on column app.companies.team_user_ids is
  'Everyone on this company besides the owner (0103), in the order they were added. Never the owner; always people of the business when they were added.';

insert into app.role_permissions (role, permission) values
  ('owner', 'records.assign'), ('admin', 'records.assign');

-- ---------- who may be on a team ----------
-- Each person once, in the order they joined, never the owner. Somebody newly added belongs to the business;
-- somebody already on the customer who has since left — on the team, or its owner stepping aside for a teammate
-- — is left alone, like an owner who left. Only owners and admins change who is on a customer that exists.
create or replace function private.guard_customer_team()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid[];
  v_added uuid;
begin
  if tg_op = 'UPDATE'
     and (new.owner_user_id is distinct from old.owner_user_id
          or new.team_user_ids is distinct from old.team_user_ids)
     and auth.uid() is not null
     and not coalesce(private.system_scope_workspace() = new.workspace_id, false)
     and not private.has_permission(new.workspace_id, 'records.assign') then
    raise exception 'Only owners and admins change who a customer is assigned to'
      using errcode = '42501', detail = 'customer_team_managers_only';
  end if;
  select coalesce(array_agg(x.u order by x.n), '{}'::uuid[]) into v_team
  from (
    select t.u, min(t.n) as n
    from unnest(new.team_user_ids) with ordinality as t(u, n)
    where t.u is not null and t.u is distinct from new.owner_user_id
    group by t.u
  ) x;
  for v_added in
    select a.u from unnest(v_team) as a(u)
    where tg_op = 'INSERT'
       or not (a.u = any (old.team_user_ids) or a.u is not distinct from old.owner_user_id)
  loop
    if not private.workspace_has_user(new.workspace_id, v_added) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end loop;
  new.team_user_ids := v_team;
  return new;
end $$;
create trigger people_guard_team before insert or update of team_user_ids, owner_user_id on app.people
  for each row execute function private.guard_customer_team();
create trigger companies_guard_team before insert or update of team_user_ids, owner_user_id on app.companies
  for each row execute function private.guard_customer_team();

-- "My customers": the ones I own, and the ones I am on.
create index people_team_idx on app.people using gin (team_user_ids);
create index companies_team_idx on app.companies using gin (team_user_ids);
create index people_owner_idx on app.people (workspace_id, owner_user_id) where owner_user_id is not null;
create index companies_owner_idx on app.companies (workspace_id, owner_user_id) where owner_user_id is not null;

-- ======================================================================
-- Money: a member on the customer sees the customer's documents
-- ======================================================================
-- The rule of 0050 with a third arm. Still a handful of primary-key probes: the lead, the booking's staff row, and
-- now the customer's row. A null customer matches nothing, exactly like a null lead.
create or replace function private.money_member_sees(p_ws uuid, p_lead uuid, p_attendee uuid, p_person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from app.leads l
      where l.id = p_lead and l.workspace_id = p_ws and l.assignee_user_id = auth.uid())
    or exists (
      select 1 from app.appointment_staff s
      where s.appointment_id = (select a.appointment_id from app.appointment_attendees a where a.id = p_attendee)
        and s.user_id = auth.uid() and s.active and s.workspace_id = p_ws)
    or exists (
      select 1 from app.people p
      where p.id = p_person and p.workspace_id = p_ws
        and (p.owner_user_id = auth.uid() or p.team_user_ids @> array[auth.uid()]))
$$;

-- The same rule for a document with no customer to ask about.
create or replace function private.money_member_sees(p_ws uuid, p_lead uuid, p_attendee uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.money_member_sees(p_ws, p_lead, p_attendee, null)
$$;

create or replace function private.money_estimate_visible(p_ws uuid, p_estimate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.estimates e
    where e.id = p_estimate and e.workspace_id = p_ws
      and private.money_member_sees(e.workspace_id, e.lead_id, null, e.person_id))
$$;

create or replace function private.money_invoice_visible(p_ws uuid, p_invoice uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.invoices i
    where i.id = p_invoice and i.workspace_id = p_ws
      and private.money_member_sees(i.workspace_id, i.lead_id, i.attendee_id, i.person_id))
$$;

-- The same two policies, now naming the customer. Their first two checks are unchanged, which is what
-- private.sync_viewer_mismatches() expects to find.
drop policy estimates_member_select on app.estimates;
create policy estimates_member_select on app.estimates for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_member_sees(workspace_id, lead_id, null, person_id));
drop policy invoices_member_select on app.invoices;
create policy invoices_member_select on app.invoices for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_member_sees(workspace_id, lead_id, attendee_id, person_id));

-- The phone's copy of it (0056), with the same third arm.
create or replace function private.money_member_viewers(p_ws uuid, p_lead uuid, p_attendee uuid, p_person uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct v.user_id order by v.user_id), '{}'::uuid[])
  from (
    select l.assignee_user_id as user_id from app.leads l
    where l.id = p_lead and l.workspace_id = p_ws and l.assignee_user_id is not null
    union
    select s.user_id from app.appointment_staff s
    where s.appointment_id = (select a.appointment_id from app.appointment_attendees a where a.id = p_attendee)
      and s.active and s.workspace_id = p_ws
    union
    select o.user_id from app.people p
    cross join lateral unnest(array_append(p.team_user_ids, p.owner_user_id)) as o(user_id)
    where p.id = p_person and p.workspace_id = p_ws and o.user_id is not null
  ) v
  join app.workspace_access wa on wa.user_id = v.user_id and wa.workspace_id = p_ws
  where exists (select 1 from app.role_permissions rp where rp.role = wa.role::text and rp.permission = 'money.read')
    and not exists (select 1 from app.role_permissions rp where rp.role = wa.role::text and rp.permission = 'money.manage')
$$;

create or replace function private.money_member_viewers(p_ws uuid, p_lead uuid, p_attendee uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select private.money_member_viewers(p_ws, p_lead, p_attendee, null)
$$;

create or replace function private.money_document_sync_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'invoices' then
    new.member_viewer_ids :=
      private.money_member_viewers(new.workspace_id, new.lead_id, new.attendee_id, new.person_id);
    if new.status in ('draft', 'sent', 'partly_paid', 'overdue') then
      new.sync_window := true;
    end if;
  else
    new.member_viewer_ids := private.money_member_viewers(new.workspace_id, new.lead_id, null, new.person_id);
    if new.status in ('draft', 'sent') then
      new.sync_window := true;
    end if;
  end if;
  return new;
end $$;

create or replace function private.money_viewers_lead_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.estimates e
  set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id)
  where e.lead_id = new.id
    and e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id);
  update app.invoices i
  set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
  where i.lead_id = new.id
    and i.member_viewer_ids is distinct from
        private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
  return null;
end $$;

create or replace function private.money_viewers_booking_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_appointments uuid[];
begin
  if tg_table_name = 'appointment_attendees' then
    update app.invoices i
    set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
    where i.attendee_id = new.id
      and i.member_viewer_ids is distinct from
          private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
    return null;
  end if;
  v_appointments := array_remove(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.appointment_id end,
    case when tg_op in ('INSERT', 'UPDATE') then new.appointment_id end], null);
  update app.invoices i
  set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
  where i.attendee_id in (
      select a.id from app.appointment_attendees a where a.appointment_id = any (v_appointments))
    and i.member_viewer_ids is distinct from
        private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
  return null;
end $$;

create or replace function private.money_viewers_access_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  update app.estimates e
  set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id)
  where e.id in (
      select x.id from app.estimates x where x.workspace_id = v_ws and x.member_viewer_ids @> array[v_user]
      union
      select x.id from app.estimates x join app.leads l on l.id = x.lead_id
      where l.workspace_id = v_ws and l.assignee_user_id = v_user
      union
      select x.id from app.estimates x join app.people p on p.id = x.person_id
      where p.workspace_id = v_ws and (p.owner_user_id = v_user or p.team_user_ids @> array[v_user]))
    and e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id);
  update app.invoices i
  set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
  where i.id in (
      select x.id from app.invoices x where x.workspace_id = v_ws and x.member_viewer_ids @> array[v_user]
      union
      select x.id from app.invoices x join app.leads l on l.id = x.lead_id
      where l.workspace_id = v_ws and l.assignee_user_id = v_user
      union
      select x.id from app.invoices x
      join app.appointment_attendees a on a.id = x.attendee_id
      join app.appointment_staff s on s.appointment_id = a.appointment_id
      where s.workspace_id = v_ws and s.user_id = v_user and s.active
      union
      select x.id from app.invoices x join app.people p on p.id = x.person_id
      where p.workspace_id = v_ws and (p.owner_user_id = v_user or p.team_user_ids @> array[v_user]))
    and i.member_viewer_ids is distinct from
        private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
  return null;
end $$;

-- A customer's owner or team changed: their documents' viewers.
create or replace function private.money_viewers_customer_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.estimates e
  set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id)
  where e.person_id = new.id
    and e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id);
  update app.invoices i
  set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
  where i.person_id = new.id
    and i.member_viewer_ids is distinct from
        private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
  return null;
end $$;
create trigger people_money_viewers after update on app.people for each row
  when (old.owner_user_id is distinct from new.owner_user_id or old.team_user_ids is distinct from new.team_user_ids)
  execute function private.money_viewers_customer_changed();

-- ======================================================================
-- Inbox: a member on the customer sees the customer's threads
-- ======================================================================
-- The rule of 0083 with a third arm, and the same fallback: a thread that names nobody is everybody's.
create or replace function private.inbox_member_viewers(p_ws uuid, p_assignee uuid, p_number uuid, p_person uuid)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if not private.inbox_per_person(p_ws) then
    return '{}'::uuid[];
  end if;
  select array_agg(distinct o.user_id order by o.user_id) into v_ids
  from (
    select e.user_id from private.inbox_eligible_members(p_ws) e where e.user_id = p_assignee
    union
    select e.user_id from private.inbox_eligible_members(p_ws) e
    join app.phone_number_members m on m.user_id = e.user_id
    where m.phone_number_id = p_number and m.workspace_id = p_ws
    union
    select e.user_id from private.inbox_eligible_members(p_ws) e
    join app.people p on p.owner_user_id = e.user_id or p.team_user_ids @> array[e.user_id]
    where p.id = p_person and p.workspace_id = p_ws
  ) o;
  if v_ids is not null then
    return v_ids;
  end if;
  select coalesce(array_agg(distinct e.user_id order by e.user_id), '{}'::uuid[]) into v_ids
  from private.inbox_eligible_members(p_ws) e;
  return v_ids;
end $$;

create or replace function private.inbox_member_viewers(p_ws uuid, p_assignee uuid, p_number uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select private.inbox_member_viewers(p_ws, p_assignee, p_number, null)
$$;

-- As 0083's, and a thread moving to another customer now moves its list too.
create or replace function private.inbox_conversation_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and old.assignee_user_id is not distinct from new.assignee_user_id
     and old.phone_number_id is not distinct from new.phone_number_id
     and old.person_id is not distinct from new.person_id
     and new.member_viewer_ids is not distinct from old.member_viewer_ids then
    return new;
  end if;
  new.member_viewer_ids :=
    private.inbox_member_viewers(new.workspace_id, new.assignee_user_id, new.phone_number_id, new.person_id);
  return new;
end $$;

create or replace function private.inbox_repaint_workspace(p_ws uuid, p_max integer default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_touched integer;
begin
  if p_max is not null then
    select count(*) into v_count from app.conversations c where c.workspace_id = p_ws;
    if v_count > p_max then
      raise exception 'Too many conversations to change this in one go (%). Ask HandsFreeOS to run it.', v_count
        using errcode = '55000', detail = 'inbox_repaint_too_large';
    end if;
  end if;
  update app.conversations c
  set member_viewer_ids =
    private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id)
  where c.workspace_id = p_ws
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id);
  get diagnostics v_touched = row_count;
  update app.calls k set member_viewer_ids = private.inbox_member_viewers(k.workspace_id, null, null, null)
  where k.workspace_id = p_ws and k.conversation_id is null
    and k.member_viewer_ids is distinct from private.inbox_member_viewers(k.workspace_id, null, null, null);
  update app.attention_items a set member_viewer_ids = private.inbox_member_viewers(a.workspace_id, null, null, null)
  where a.workspace_id = p_ws and a.conversation_id is null
    and a.member_viewer_ids is distinct from private.inbox_member_viewers(a.workspace_id, null, null, null);
  return v_touched;
end $$;

create or replace function private.inbox_viewers_number_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  v_number uuid := coalesce(new.phone_number_id, old.phone_number_id);
begin
  if not private.inbox_per_person(v_ws) then
    return null;
  end if;
  update app.conversations c
  set member_viewer_ids =
    private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id)
  where c.workspace_id = v_ws and c.phone_number_id = v_number
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id);
  return null;
end $$;

-- A customer's owner or team changed: their threads, while the business narrows its inbox. One index probe and
-- nothing else while it doesn't.
create or replace function private.inbox_viewers_customer_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.inbox_per_person(new.workspace_id) then
    return null;
  end if;
  update app.conversations c
  set member_viewer_ids =
    private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id)
  where c.workspace_id = new.workspace_id and c.person_id = new.id
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id);
  return null;
end $$;
create trigger people_inbox_viewers after update on app.people for each row
  when (old.owner_user_id is distinct from new.owner_user_id or old.team_user_ids is distinct from new.team_user_ids)
  execute function private.inbox_viewers_customer_changed();

-- ---------- every list as it stands today ----------
update app.estimates e
set member_viewer_ids = private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id)
where e.member_viewer_ids is distinct from private.money_member_viewers(e.workspace_id, e.lead_id, null, e.person_id);
update app.invoices i
set member_viewer_ids = private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id)
where i.member_viewer_ids is distinct from
      private.money_member_viewers(i.workspace_id, i.lead_id, i.attendee_id, i.person_id);
do $$
declare
  w record;
begin
  for w in select c.workspace_id from app.conversations c group by c.workspace_id loop
    if private.inbox_per_person(w.workspace_id) then
      perform private.inbox_repaint_workspace(w.workspace_id);
    end if;
  end loop;
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.guard_customer_team(), private.money_member_sees(uuid, uuid, uuid, uuid),
  private.money_member_viewers(uuid, uuid, uuid, uuid), private.money_viewers_customer_changed(),
  private.inbox_member_viewers(uuid, uuid, uuid, uuid), private.inbox_viewers_customer_changed()
  from public;
grant execute on function private.guard_customer_team() to authenticated, service_actor;
-- The policies call it as whoever reads, like the three-argument form (0050).
grant execute on function private.money_member_sees(uuid, uuid, uuid, uuid) to authenticated, service_actor;
grant execute on function private.money_viewers_customer_changed(), private.inbox_viewers_customer_changed()
  to authenticated, service_actor;
-- As 0083 did for the three-argument form: the worker's repaints ask it directly.
grant execute on function private.inbox_member_viewers(uuid, uuid, uuid, uuid) to service_actor;

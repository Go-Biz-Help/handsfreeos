-- =============================================================================
-- Records kept to the people on them (Real Estate, step 4).
--
--        Every custom record was readable by everyone in the business. A
--        real estate deal holds a client's money, dates and papers, and Chris
--        decided (2026-09-30) that an agent sees only the deals they're on,
--        while owners, admins and anyone given "See every deal" see them all.
--        Core owns the rule, so any add-on can keep its records this way.
--
--        **A private kind.** An add-on declares one of its kinds
--        `keptToTeam`, naming the permission that sees every record of it.
--        The worker writes kept_to_team and see_all_permission on the kind
--        when it seeds it; nobody changes either afterwards, and only an
--        add-on's kind can be private in this round.
--
--        **Who is on a record.** A private record keeps owner_user_id (its
--        main person: the deal's main agent) and team_user_ids (everyone
--        else on it), as a customer does since 0104. A person who makes one
--        is its owner unless they name someone else. The owner puts people on
--        it and takes them off; so does anyone holding records.assign
--        (owners and admins); nobody else. Everyone added must work in the
--        business.
--
--        **Who sees one:** its owner, its team, and anyone holding its kind's
--        See-every permission (an owner holds every permission, and the
--        founder's session answers as an owner). Everyone else in the
--        business doesn't know it's there.
--
--        **What hangs off it follows it.** Its timeline lines, tasks, files
--        (and their Storage objects), Home cards and relationships. The first
--        four gain `sealed`, kept by a trigger from the record they hang on
--        (a record's privacy never changes, so neither does `sealed`), and
--        every policy gains "and it isn't sealed, or its record is visible".
--        A relationship is seen only when both its ends are. An add-on's own
--        tables follow a record through private.addon_table_policies' new
--        record column. A task on a private record goes only to someone on
--        it. Appointments are left as they are: a deal's appointments stay
--        on the calendar as busy (the owner's decision), and the add-on makes
--        none this round.
--
--        **HandsFreeOS support.** A support look (M13) reads a business as
--        its staff member, through accessible_workspace_ids, and so sees no
--        private record. app.record_support_grants lets them in: the owner of
--        a private record or anyone with records.assign gives access, or
--        support asks from their look and one of them approves. It lasts 24
--        hours unless ended sooner, and shows support, read-only and only
--        while their look is open, what the person who gave it sees
--        (private.user_sees_record). Every request, access and ending is an
--        event and an audit line.
--
--        **The phone.** business_v1's tasks, timeline lines, files and Home
--        cards send only `sealed = false` rows, and me_v1's cards the same,
--        narrowed in place like 0083 and M19. Private records themselves
--        never reached the phone.
-- =============================================================================

-- ---------- a private kind ----------
alter table app.custom_record_types
  add column kept_to_team boolean not null default false,
  add column see_all_permission text,
  add constraint custom_record_types_private_is_addons check (
    not kept_to_team
    or (addon_id is not null and see_all_permission is not null
        and see_all_permission like addon_id || '.%'));

comment on column app.custom_record_types.kept_to_team is
  'Each record of this kind is seen only by the people on it and holders of see_all_permission (Real Estate step 4). An add-on''s kind only; fixed once made.';

create or replace function private.guard_private_kind()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.kept_to_team and current_user = 'authenticated' then
      raise exception 'Only an add-on''s kinds of records are kept to their people'
        using errcode = '42501', detail = 'private_kind_is_addons';
    end if;
    return new;
  end if;
  if new.kept_to_team is distinct from old.kept_to_team
     or new.see_all_permission is distinct from old.see_all_permission then
    raise exception 'Whether a kind of record is kept to its people never changes'
      using errcode = '42501', detail = 'private_kind_fixed';
  end if;
  return new;
end $$;

create trigger custom_record_types_private before insert or update on app.custom_record_types
  for each row execute function private.guard_private_kind();

-- ---------- who is on a record ----------
alter table app.custom_records
  add column kept_to_team boolean not null default false,
  add column owner_user_id uuid references app.users (id) on delete set null,
  add column team_user_ids uuid[] not null default '{}' check (cardinality(team_user_ids) <= 20),
  add constraint custom_records_team_is_private check (
    kept_to_team or (owner_user_id is null and team_user_ids = '{}'));

create index custom_records_owner_idx on app.custom_records (workspace_id, owner_user_id) where kept_to_team;
create index custom_records_team_idx on app.custom_records using gin (team_user_ids) where kept_to_team;

comment on column app.custom_records.owner_user_id is
  'A private record''s main person (a deal''s main agent): on it, and able to put others on it (Real Estate step 4).';
comment on column app.custom_records.team_user_ids is
  'Everyone else on a private record. Only they, its owner and holders of the kind''s see-all permission see it.';

-- Copies the kind's privacy onto a new record, makes its maker its owner, and holds who may change who is on it.
create or replace function private.guard_record_team()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_kept boolean;
  v_added uuid;
begin
  if tg_op = 'INSERT' then
    select t.kept_to_team into v_kept from app.custom_record_types t where t.id = new.type_id;
    new.kept_to_team := coalesce(v_kept, false);
    -- Its maker is its owner, when they work here (the founder, looking in as an owner, doesn't).
    if new.kept_to_team and new.owner_user_id is null and v_user is not null
       and private.works_in(v_user, new.workspace_id) then
      new.owner_user_id := v_user;
    end if;
  else
    if new.kept_to_team is distinct from old.kept_to_team then
      raise exception 'Whether a record is kept to its people never changes'
        using errcode = '42501', detail = 'private_kind_fixed';
    end if;
    if (new.owner_user_id is distinct from old.owner_user_id
        or new.team_user_ids is distinct from old.team_user_ids)
       -- A person (the function runs as its owner, so the session's role says who is writing); the worker and
       -- the add-on acting as the system are not asked, as for a customer's team (0104).
       and coalesce(current_setting('role', true), '') = 'authenticated'
       and not private.has_permission(new.workspace_id, 'records.assign')
       and not (old.kept_to_team and old.owner_user_id = v_user
                and new.owner_user_id is not distinct from old.owner_user_id) then
      raise exception 'Only its main person, or an owner or admin, changes who is on it'
        using errcode = '42501', detail = 'record_team_not_yours';
    end if;
  end if;

  -- The team is everyone else: no repeats, and never the owner too.
  new.team_user_ids := coalesce(
    (select array_agg(distinct u) from unnest(new.team_user_ids) u
     where u is not null and u is distinct from new.owner_user_id),
    '{}');

  if tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id
     or new.team_user_ids is distinct from old.team_user_ids then
    for v_added in
      select u from unnest(array_append(new.team_user_ids, new.owner_user_id)) u
      where u is not null
        and (tg_op = 'INSERT' or not (u = any (array_append(old.team_user_ids, old.owner_user_id))))
    loop
      if not private.works_in(v_added, new.workspace_id) then
        raise exception 'Only someone who works in this business can be on it'
          using errcode = '23514', detail = 'record_team_outsider';
      end if;
    end loop;
  end if;
  return new;
end $$;

create trigger custom_records_team before insert or update on app.custom_records
  for each row execute function private.guard_record_team();

-- People write who is on a record (the columns are granted one by one, 0101); the trigger above decides who may.
grant update (owner_user_id, team_user_ids) on app.custom_records to authenticated;

-- ---------- who sees one ----------
-- The private kinds, in businesses the caller can open, whose see-all permission they hold. Asked once per query.
create or replace function private.private_kinds_seen_whole()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select t.id from app.custom_record_types t
  where t.kept_to_team
    and t.workspace_id in (select private.accessible_workspace_ids())
    and private.has_permission(t.workspace_id, t.see_all_permission)
$$;

-- The same question about someone other than the caller (the worker choosing whom to tell, a support grant).
create or replace function private.user_sees_record(p_user uuid, p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    where r.id = p_record and private.works_in(p_user, r.workspace_id)
      and (not r.kept_to_team
           or r.owner_user_id = p_user
           or r.team_user_ids @> array[p_user]
           or private.user_has_permission(p_user, r.workspace_id, t.see_all_permission)))
$$;

-- ---------- support access ----------
create table app.record_support_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  status text not null check (status in ('requested', 'active', 'declined', 'ended')),
  -- Support's ask, from their look at the business; null when someone here gave it unasked.
  requested_by uuid references app.users (id) on delete set null,
  request_note text check (request_note is null or length(request_note) between 1 and 500),
  -- Whose view it opens: everything this person sees.
  granted_by uuid references app.users (id) on delete set null,
  granted_at timestamptz,
  expires_at timestamptz,
  decided_by uuid references app.users (id) on delete set null,
  ended_at timestamptz,
  ended_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'active' or (granted_by is not null and granted_at is not null and expires_at is not null))
);
create index record_support_grants_ws_idx on app.record_support_grants (workspace_id, status);
create index record_support_grants_requested_by_idx on app.record_support_grants (requested_by);
create index record_support_grants_granted_by_idx on app.record_support_grants (granted_by);
create index record_support_grants_decided_by_idx on app.record_support_grants (decided_by);
create index record_support_grants_ended_by_idx on app.record_support_grants (ended_by);
create trigger record_support_grants_updated_at before update on app.record_support_grants
  for each row execute function private.set_updated_at();

comment on table app.record_support_grants is
  'HandsFreeOS support let into a business''s private records for 24 hours: what the person who gave it sees, read-only, while their look is open (Real Estate step 4).';

alter table app.record_support_grants enable row level security;
-- Everyone who can open the business sees where it stands, support in their look included.
create policy record_support_grants_select on app.record_support_grants for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy record_support_grants_service_all on app.record_support_grants for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.record_support_grants to authenticated;
grant select, insert, update, delete on app.record_support_grants to service_actor;
revoke all on app.record_support_grants from anon;

-- HandsFreeOS support, looking at this business now, let in by someone who sees this record.
create or replace function private.support_sees_record(p_ws uuid, p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.active_view_as(auth.uid(), p_ws))
    and exists (
      select 1 from app.record_support_grants g
      where g.workspace_id = p_ws and g.status = 'active' and g.expires_at > now()
        and private.user_sees_record(g.granted_by, p_record))
$$;

-- Who may let support in: an owner or admin (records.assign), or the main person on a private record here.
create or replace function private.can_let_support_in(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission(p_ws, 'records.assign')
    or exists (select 1 from app.custom_records r
               where r.workspace_id = p_ws and r.kept_to_team and r.owner_user_id = auth.uid())
$$;

-- Support asks, from an open look at the business.
create or replace function private.request_support_access(p_ws uuid, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from private.active_view_as(auth.uid(), p_ws)) then
    raise exception 'Open this business from its support page first' using errcode = '42501',
      detail = 'support_access_needs_look';
  end if;
  select g.id into v_id from app.record_support_grants g
  where g.workspace_id = p_ws and g.status = 'requested' and g.requested_by = auth.uid();
  if v_id is not null then
    return v_id;
  end if;
  insert into app.record_support_grants (workspace_id, status, requested_by, request_note)
  values (p_ws, 'requested', auth.uid(), nullif(btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Someone here lets support in: answering a request, or unasked. For 24 hours, as what they see.
create or replace function private.grant_support_access(p_ws uuid, p_request uuid)
returns table (id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_until timestamptz := now() + interval '24 hours';
begin
  if not private.can_let_support_in(p_ws) then
    raise exception 'Only an owner or admin, or a record''s main person, lets support in'
      using errcode = '42501', detail = 'support_access_not_yours';
  end if;
  if p_request is not null then
    update app.record_support_grants g
       set status = 'active', granted_by = auth.uid(), granted_at = now(), expires_at = v_until,
           decided_by = auth.uid()
     where g.id = p_request and g.workspace_id = p_ws and g.status = 'requested'
    returning g.id into v_id;
    if v_id is null then
      raise exception 'That request isn''t waiting anymore' using errcode = '23514',
        detail = 'support_access_not_waiting';
    end if;
  else
    insert into app.record_support_grants (workspace_id, status, granted_by, granted_at, expires_at, decided_by)
    values (p_ws, 'active', auth.uid(), now(), v_until, auth.uid())
    returning app.record_support_grants.id into v_id;
  end if;
  return query select v_id, v_until;
end $$;

create or replace function private.decline_support_access(p_ws uuid, p_request uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_let_support_in(p_ws) then
    raise exception 'Only an owner or admin, or a record''s main person, answers support'
      using errcode = '42501', detail = 'support_access_not_yours';
  end if;
  update app.record_support_grants g set status = 'declined', decided_by = auth.uid()
   where g.id = p_request and g.workspace_id = p_ws and g.status = 'requested';
  if not found then
    raise exception 'That request isn''t waiting anymore' using errcode = '23514',
      detail = 'support_access_not_waiting';
  end if;
end $$;

-- The person who gave it, or an owner or admin, ends it early.
create or replace function private.end_support_access(p_ws uuid, p_grant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app.record_support_grants g set status = 'ended', ended_at = now(), ended_by = auth.uid()
   where g.id = p_grant and g.workspace_id = p_ws and g.status = 'active'
     and (g.granted_by = auth.uid() or private.has_permission(p_ws, 'records.assign'));
  if not found then
    raise exception 'That access isn''t open, or isn''t yours to end' using errcode = '42501',
      detail = 'support_access_not_yours';
  end if;
end $$;

revoke execute on function private.request_support_access(uuid, text) from public;
revoke execute on function private.grant_support_access(uuid, uuid) from public;
revoke execute on function private.decline_support_access(uuid, uuid) from public;
revoke execute on function private.end_support_access(uuid, uuid) from public;
grant execute on function private.request_support_access(uuid, text) to authenticated;
grant execute on function private.grant_support_access(uuid, uuid) to authenticated;
grant execute on function private.decline_support_access(uuid, uuid) to authenticated;
grant execute on function private.end_support_access(uuid, uuid) to authenticated;

-- A record the caller may see: its own rule, in one lookup. Used by what hangs off a private record.
create or replace function private.custom_record_visible(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.custom_records r
    where r.id = p_record
      and r.workspace_id in (select private.accessible_workspace_ids())
      and not (r.type_id in (select private.hidden_record_kinds()))
      and (not r.kept_to_team
           or r.owner_user_id = auth.uid()
           or r.team_user_ids @> array[auth.uid()]
           or r.type_id in (select private.private_kinds_seen_whole())
           or private.support_sees_record(r.workspace_id, r.id)))
$$;

grant execute on function private.private_kinds_seen_whole() to authenticated, service_actor;
grant execute on function private.user_sees_record(uuid, uuid) to authenticated, service_actor;
grant execute on function private.support_sees_record(uuid, uuid) to authenticated, service_actor;
grant execute on function private.custom_record_visible(uuid) to authenticated, service_actor;
grant execute on function private.can_let_support_in(uuid) to authenticated, service_actor;

-- ---------- the records' own policies ----------
drop policy custom_records_select on app.custom_records;
create policy custom_records_select on app.custom_records for select to authenticated
  using (
    workspace_id in (select private.accessible_workspace_ids())
    and not (type_id in (select private.hidden_record_kinds()))
    and (not kept_to_team
         or owner_user_id = (select auth.uid())
         or team_user_ids @> array[(select auth.uid())]
         or type_id in (select private.private_kinds_seen_whole())
         or private.support_sees_record(workspace_id, id)));

drop policy custom_records_insert on app.custom_records;
create policy custom_records_insert on app.custom_records for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'records.write')
    and created_by = (select auth.uid())
    and archived_at is null
    and (not kept_to_team
         or owner_user_id = (select auth.uid())
         or team_user_ids @> array[(select auth.uid())]
         or type_id in (select private.private_kinds_seen_whole())));

drop policy custom_records_update on app.custom_records;
create policy custom_records_update on app.custom_records for update to authenticated
  using (
    private.has_permission(workspace_id, 'records.write')
    and (not kept_to_team
         or owner_user_id = (select auth.uid())
         or team_user_ids @> array[(select auth.uid())]
         or type_id in (select private.private_kinds_seen_whole())))
  with check (
    private.has_permission(workspace_id, 'records.write')
    and (not kept_to_team
         or owner_user_id = (select auth.uid())
         or team_user_ids @> array[(select auth.uid())]
         or type_id in (select private.private_kinds_seen_whole())
         -- The main person handing the record on keeps writing it until the statement ends.
         or private.has_permission(workspace_id, 'records.assign')));

-- ---------- what hangs off a record: sealed ----------
alter table app.activities add column sealed boolean not null default false;
alter table app.tasks add column sealed boolean not null default false;
alter table app.files add column sealed boolean not null default false;
alter table app.attention_items
  add column custom_record_id uuid references app.custom_records (id) on delete set null,
  add column sealed boolean not null default false;
create index attention_items_custom_record_idx on app.attention_items (custom_record_id)
  where custom_record_id is not null;

comment on column app.activities.sealed is
  'On a private record (Real Estate step 4): seen only by the people who see that record. Kept by a trigger.';
comment on column app.tasks.sealed is
  'On a private record (Real Estate step 4): seen only by the people who see that record. Kept by a trigger.';
comment on column app.files.sealed is
  'On a private record (Real Estate step 4): seen only by the people who see that record. Kept by a trigger.';
comment on column app.attention_items.sealed is
  'About a private record (Real Estate step 4): seen only by the people who see that record. Kept by a trigger.';

create or replace function private.record_is_private(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select r.kept_to_team from app.custom_records r where r.id = p_record), false)
$$;

-- activities and tasks: custom_record_id; files: record_id when it's a record's.
create or replace function private.keep_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'files' then
    new.sealed := new.record_type = 'custom_record' and private.record_is_private(new.record_id);
  else
    new.sealed := new.custom_record_id is not null and private.record_is_private(new.custom_record_id);
  end if;
  return new;
end $$;

create trigger activities_sealed before insert or update of custom_record_id, sealed on app.activities
  for each row execute function private.keep_sealed();
create trigger tasks_sealed before insert or update of custom_record_id, sealed on app.tasks
  for each row execute function private.keep_sealed();
create trigger files_sealed before insert or update of record_id, record_type, sealed on app.files
  for each row execute function private.keep_sealed();

-- A Home card about a task on a private record is about that record too.
create or replace function private.keep_attention_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subject_type = 'task' then
    select t.custom_record_id into new.custom_record_id from app.tasks t where t.id = new.subject_id;
  end if;
  new.sealed := new.custom_record_id is not null and private.record_is_private(new.custom_record_id);
  return new;
end $$;

create trigger attention_items_sealed
  before insert or update of subject_type, subject_id, custom_record_id, sealed on app.attention_items
  for each row execute function private.keep_attention_sealed();

-- A task on a private record goes only to someone on it.
create or replace function private.guard_sealed_task_assignee()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.sealed and new.assignee_user_id is not null
     and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id
          or new.custom_record_id is distinct from old.custom_record_id)
     and not private.user_sees_record(new.assignee_user_id, new.custom_record_id) then
    raise exception 'That person isn''t on this record' using errcode = '23514',
      detail = 'task_assignee_not_on_record';
  end if;
  return null;
end $$;

create constraint trigger tasks_sealed_assignee after insert or update of assignee_user_id, custom_record_id
  on app.tasks for each row execute function private.guard_sealed_task_assignee();

-- ---------- their policies ----------
drop policy activities_select on app.activities;
create policy activities_select on app.activities for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy activities_insert on app.activities;
create policy activities_insert on app.activities for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write')
              and actor_type = 'human'::app.actor_type
              and author_user_id = (select auth.uid())
              and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy activities_update on app.activities;
create policy activities_update on app.activities for update to authenticated
  using (kind <> 'system'::app.activity_kind and author_user_id = (select auth.uid())
         and (not sealed or private.custom_record_visible(custom_record_id)))
  with check (kind <> 'system'::app.activity_kind and author_user_id = (select auth.uid())
              and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy activities_delete on app.activities;
create policy activities_delete on app.activities for delete to authenticated
  using (kind <> 'system'::app.activity_kind
         and (author_user_id = (select auth.uid()) or private.has_permission(workspace_id, 'records.archive'))
         and (not sealed or private.custom_record_visible(custom_record_id)));

drop policy tasks_select on app.tasks;
create policy tasks_select on app.tasks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy tasks_insert on app.tasks;
create policy tasks_insert on app.tasks for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid())
              and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy tasks_update on app.tasks;
create policy tasks_update on app.tasks for update to authenticated
  using (private.has_permission(workspace_id, 'records.write')
         and (not sealed or private.custom_record_visible(custom_record_id)))
  with check (private.has_permission(workspace_id, 'records.write')
              and (not sealed or private.custom_record_visible(custom_record_id)));
drop policy tasks_delete on app.tasks;
create policy tasks_delete on app.tasks for delete to authenticated
  using ((created_by = (select auth.uid()) or private.has_permission(workspace_id, 'records.archive'))
         and (not sealed or private.custom_record_visible(custom_record_id)));

drop policy files_select on app.files;
create policy files_select on app.files for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or private.custom_record_visible(record_id)));
drop policy files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
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
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)))
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)));

-- Home cards: one restrictive rule beside both select arms and the update, rather than a change to each, so the
-- inbox's parity check (private.sync_inbox_mismatches, which reads the members' arm) is still comparing like
-- with like. me_v1 and business_v1 send no sealed card at all.
create policy attention_items_sealed on app.attention_items as restrictive for all to authenticated
  using (not sealed or private.custom_record_visible(custom_record_id))
  with check (not sealed or private.custom_record_visible(custom_record_id));

-- A relationship is seen, made and taken away only when both its ends can be seen.
drop policy relationships_select on app.relationships;
create policy relationships_select on app.relationships for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (a_custom_record_id is null or private.custom_record_visible(a_custom_record_id))
         and (b_custom_record_id is null or private.custom_record_visible(b_custom_record_id)));
drop policy relationships_insert on app.relationships;
create policy relationships_insert on app.relationships for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid())
              and (a_custom_record_id is null or private.custom_record_visible(a_custom_record_id))
              and (b_custom_record_id is null or private.custom_record_visible(b_custom_record_id)));
drop policy relationships_update on app.relationships;
create policy relationships_update on app.relationships for update to authenticated
  using (private.has_permission(workspace_id, 'records.write')
         and (a_custom_record_id is null or private.custom_record_visible(a_custom_record_id))
         and (b_custom_record_id is null or private.custom_record_visible(b_custom_record_id)))
  with check (private.has_permission(workspace_id, 'records.write')
              and (a_custom_record_id is null or private.custom_record_visible(a_custom_record_id))
              and (b_custom_record_id is null or private.custom_record_visible(b_custom_record_id)));
drop policy relationships_delete on app.relationships;
create policy relationships_delete on app.relationships for delete to authenticated
  using (private.has_permission(workspace_id, 'records.write')
         and (a_custom_record_id is null or private.custom_record_visible(a_custom_record_id))
         and (b_custom_record_id is null or private.custom_record_visible(b_custom_record_id)));

-- ---------- Storage: a sealed file's object follows it ----------
create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'telephony' then
      coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
      and (not private.inbox_narrowed(private.path_workspace(p_name))
        or exists (
          select 1 from app.calls c
          where c.workspace_id = private.path_workspace(p_name)
            and c.member_viewer_ids @> array[(select auth.uid())]
            and (c.recording_object_path = p_name
              or (split_part(p_name, '/', 2) = 'calls'
                and c.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end)))
        or exists (
          select 1 from app.messages m
          where m.workspace_id = private.path_workspace(p_name)
            and m.member_viewer_ids @> array[(select auth.uid())]
            and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
              or (split_part(p_name, '/', 2) = 'messages'
                and m.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end))))
      and not exists (
        select 1 from app.messages m
        where m.private_to is not null and m.private_to <> (select auth.uid())
          and m.workspace_id = private.path_workspace(p_name)
          and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
            or (split_part(p_name, '/', 2) = 'messages'
              and m.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;

create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    else false
  end
$$;

-- ---------- an add-on's own tables follow a record ----------
drop function private.addon_table_policies(regclass, text, text, text);
create or replace function private.addon_table_policies(
  p_table regclass, p_read text, p_write text, p_delete text default null, p_record_column name default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_addon text;
  v_read text;
  v_write text;
  v_follow text := 'true';
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_schema !~ '^addon_[a-z]{2,16}$' then
    raise exception '% is not in an add-on''s schema', p_table using errcode = '23514';
  end if;
  v_addon := substr(v_schema, 7);
  if p_read not like v_addon || '.%' or p_write not like v_addon || '.%'
     or (p_delete is not null and p_delete not like v_addon || '.%') then
    raise exception 'An add-on''s table is guarded by the add-on''s own permissions' using errcode = '23514';
  end if;
  if not exists (
      select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'workspace_id'
        and a.attnotnull and not a.attisdropped) then
    raise exception '% needs workspace_id uuid not null', p_table using errcode = '23514';
  end if;
  -- A row about a record (a deal) is seen and changed only by people who see that record.
  if p_record_column is not null then
    if not exists (
        select 1 from pg_attribute a where a.attrelid = p_table and a.attname = p_record_column
          and not a.attisdropped and a.atttypid = 'uuid'::regtype) then
      raise exception '% has no uuid column %', p_table, p_record_column using errcode = '23514';
    end if;
    v_follow := format('(%I is null or private.custom_record_visible(%I))', p_record_column, p_record_column);
  end if;
  v_read := format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_read, v_follow);
  v_write := format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_write, v_follow);
  execute format('alter table %s enable row level security', p_table);
  execute format('create policy %I on %s for select to authenticated using (%s)', v_name || '_select', p_table, v_read);
  -- Support, let in to a record, reads what hangs off it too (never writes).
  if p_record_column is not null then
    execute format('create policy %I on %s for select to authenticated using (%I is not null and '
                   'private.support_sees_record(workspace_id, %I))',
      v_name || '_support_select', p_table, p_record_column, p_record_column);
  end if;
  execute format('create policy %I on %s for insert to authenticated with check (%s)', v_name || '_insert', p_table, v_write);
  execute format('create policy %I on %s for update to authenticated using (%s) with check (%s)',
    v_name || '_update', p_table, v_write, v_write);
  if p_delete is not null then
    execute format('create policy %I on %s for delete to authenticated using (%s)', v_name || '_delete', p_table,
      format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_delete, v_follow));
  end if;
  execute format(
    'create policy %I on %s for all to service_actor using (workspace_id = private.system_scope_workspace()) '
    'with check (workspace_id = private.system_scope_workspace() and private.addon_writable(workspace_id, %L))',
    v_name || '_service_all', p_table, v_addon);
  if exists (select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'updated_at' and not a.attisdropped) then
    execute format('create trigger %I before update on %s for each row execute function private.set_updated_at()',
      v_name || '_updated_at', p_table);
  end if;
  execute format(
    'create trigger %I before update on %s for each row execute function private.forbid_tenant_column_change(%L)',
    v_name || '_immutable', p_table, 'workspace_id');
  execute format('grant select, insert, update%s on %s to authenticated',
    case when p_delete is not null then ', delete' else '' end, p_table);
  execute format('grant select, insert, update, delete on %s to service_actor', p_table);
  execute format('revoke all on %s from anon', p_table);
end $$;
revoke execute on function private.addon_table_policies(regclass, text, text, text, name) from public;

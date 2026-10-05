-- =============================================================================
-- Records on hold: legal holds and keeping records (Real Estate round six,
-- step 4; core).
--
--        The spec's §18 asks for brokerage-set retention and legal holds.
--        Chris decided (2026-10-03): a business keeps closed records for at
--        least the years it sets (Real Estate: closed deals, 7 by default),
--        which stops anyone deleting the add-on's data before then; a legal
--        hold freezes a record's files and history until it's lifted; and
--        nothing is ever deleted on its own. Signed files were already kept
--        for good (20261013002300) and deals are never deleted.
--
--        **A hold** is on one record: `legal` (placed by a person, with a
--        reason, until someone lifts it, with a reason) or `retention` (the
--        add-on's worker keeps one per record: no end while it's open, its end
--        date plus the years set once it's done). Owners and admins place and
--        lift legal holds (records.hold, which a business can give others).
--        Every hold placed or lifted is an event and an audit line.
--
--        **What a hold stops:**
--          - under a legal hold, a record's files can't be deleted or renamed
--            and its timeline lines can't be changed or deleted (new ones can
--            be added);
--          - while any hold is active, the add-on whose record it is can't
--            have its data deleted (the move to `purging` is refused);
--          - while a legal hold is active, the business can't be deleted.
-- =============================================================================

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values ('owner', 'records.hold'), ('admin', 'records.hold');
insert into app.customizable_permissions (permission, requires) values ('records.hold', '{records.read}');

-- ---------- holds ----------
create table app.record_holds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  custom_record_id uuid not null references app.custom_records (id) on delete cascade,
  -- The add-on whose record it is (from its kind), so deleting that add-on's data can find its holds.
  addon_id text,
  kind text not null check (kind in ('legal', 'retention')),
  -- A retention hold's end; null while the record is open. A legal hold has none: it lasts until lifted.
  held_until timestamptz,
  reason text check (reason is null or length(btrim(reason)) between 1 and 500),
  placed_by uuid references app.users (id) on delete set null,
  placed_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references app.users (id) on delete set null,
  lift_reason text check (lift_reason is null or length(btrim(lift_reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'retention' or (held_until is null and reason is not null)),
  check ((lifted_at is null) = (lift_reason is null) or kind = 'retention')
);
create unique index record_holds_one_open on app.record_holds (custom_record_id, kind) where lifted_at is null;
create index record_holds_workspace_idx on app.record_holds (workspace_id) where lifted_at is null;
create index record_holds_addon_idx on app.record_holds (workspace_id, addon_id) where lifted_at is null;
create trigger record_holds_updated_at before update on app.record_holds
  for each row execute function private.set_updated_at();
create trigger record_holds_immutable before update on app.record_holds
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'custom_record_id', 'kind');

comment on table app.record_holds is
  'A record kept as it is: a legal hold (a person, with a reason, until lifted) or a retention hold (the add-on, until a date). Stops deleting what it holds (Real Estate round six).';

-- The add-on a record belongs to, written on each new hold.
create or replace function private.record_hold_addon()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select t.addon_id into new.addon_id
  from app.custom_records r join app.custom_record_types t on t.id = r.type_id
  where r.id = new.custom_record_id and r.workspace_id = new.workspace_id;
  if not found then
    raise exception 'That record isn''t in this business' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

create trigger record_holds_addon before insert on app.record_holds
  for each row execute function private.record_hold_addon();

alter table app.record_holds enable row level security;

-- Whoever sees the record sees its holds.
create policy record_holds_select on app.record_holds for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and not (custom_record_id in (select private.unseen_private_records())));
-- A person places and lifts legal holds, with records.hold, on a record they see.
create policy record_holds_insert on app.record_holds for insert to authenticated
  with check (kind = 'legal' and private.has_permission(workspace_id, 'records.hold')
              and placed_by = (select auth.uid()) and lifted_at is null
              and not (custom_record_id in (select private.unseen_private_records())));
create policy record_holds_update on app.record_holds for update to authenticated
  using (kind = 'legal' and private.has_permission(workspace_id, 'records.hold')
         and not (custom_record_id in (select private.unseen_private_records())))
  with check (kind = 'legal' and private.has_permission(workspace_id, 'records.hold'));
-- The worker keeps retention holds.
create policy record_holds_service_all on app.record_holds for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, update on app.record_holds to authenticated;
grant select, insert, update, delete on app.record_holds to service_actor;
revoke all on app.record_holds from anon;

-- A legal hold, once lifted, stays lifted; only its lifting is written.
create or replace function private.guard_record_hold()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.kind = 'legal' and (
       old.lifted_at is not null
       or new.reason is distinct from old.reason or new.placed_by is distinct from old.placed_by
       or new.placed_at is distinct from old.placed_at or new.held_until is distinct from old.held_until) then
    raise exception 'A legal hold is only ever lifted' using errcode = '42501', detail = 'record_hold_fixed';
  end if;
  return new;
end $$;

create trigger record_holds_guard before update on app.record_holds
  for each row execute function private.guard_record_hold();

-- Whether a record is held now: a legal hold, or (asking for any) also a retention hold not yet over.
create or replace function private.record_on_legal_hold(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.record_holds h
                 where h.custom_record_id = p_record and h.kind = 'legal' and h.lifted_at is null)
$$;
grant execute on function private.record_on_legal_hold(uuid) to authenticated, service_actor;

-- The worker's retention hold on a record: no end while it's open, or until a date. Null lifts it.
create or replace function private.set_retention_hold(p_ws uuid, p_record uuid, p_open boolean, p_until timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_worker_scope(p_ws);
  if not p_open and p_until is null then
    update app.record_holds h set lifted_at = now()
    where h.custom_record_id = p_record and h.kind = 'retention' and h.lifted_at is null;
    return;
  end if;
  insert into app.record_holds (workspace_id, custom_record_id, kind, held_until)
  values (p_ws, p_record, 'retention', case when p_open then null else p_until end)
  on conflict (custom_record_id, kind) where lifted_at is null
  do update set held_until = excluded.held_until
  where app.record_holds.held_until is distinct from excluded.held_until;
end $$;
revoke all on function private.set_retention_hold(uuid, uuid, boolean, timestamptz) from public;
grant execute on function private.set_retention_hold(uuid, uuid, boolean, timestamptz) to service_actor;

-- What an add-on's holds keep in one business: how many records, until when at the latest (null: one is still
-- open), and how many on legal hold. What deleting its data is refused with, and what the Add-ons page says first.
create or replace function private.addon_holds(p_ws uuid, p_addon text)
returns table (records integer, open_records integer, held_until timestamptz, legal integer)
language sql stable security definer set search_path = '' as $$
  select count(distinct h.custom_record_id)::integer,
         count(distinct h.custom_record_id) filter (where h.kind = 'retention' and h.held_until is null)::integer,
         max(h.held_until) filter (where h.kind = 'retention'),
         count(distinct h.custom_record_id) filter (where h.kind = 'legal')::integer
  from app.record_holds h
  where h.workspace_id = p_ws and h.addon_id = p_addon and h.lifted_at is null
    and (h.kind = 'legal' or h.held_until is null or h.held_until > now())
$$;
grant execute on function private.addon_holds(uuid, text) to authenticated, service_actor;

-- ---------- what a hold stops ----------
-- A file on a record under a legal hold isn't deleted, marked deleted or renamed. New ones may be added, and an
-- upload that never finished may still be cleared away.
create or replace function private.guard_held_file()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.record_type <> 'custom_record' or old.status <> 'ready' or private.purging_workspace(old.workspace_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if (tg_op = 'DELETE' or new.deleted_at is distinct from old.deleted_at or new.name is distinct from old.name
      or new.record_id is distinct from old.record_id)
     and private.record_on_legal_hold(old.record_id) then
    raise exception '% is on a record under a legal hold, so it can''t be deleted or renamed', old.name
      using errcode = '42501', detail = 'record_on_hold';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger files_held before update or delete on app.files
  for each row execute function private.guard_held_file();

-- A record's timeline lines under a legal hold aren't changed or deleted by people. (HandsFreeOS's own bookkeeping
-- on a line, such as a message's delivery, goes on.)
create or replace function private.guard_held_activity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.custom_record_id is null or current_user <> 'authenticated' or private.purging_workspace(old.workspace_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if (tg_op = 'DELETE' or new.body is distinct from old.body or new.meta is distinct from old.meta
      or new.custom_record_id is distinct from old.custom_record_id or new.occurred_at is distinct from old.occurred_at)
     and private.record_on_legal_hold(old.custom_record_id) then
    raise exception 'This line is on a record under a legal hold, so it can''t be changed or deleted'
      using errcode = '42501', detail = 'record_on_hold';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger activities_held before update or delete on app.activities
  for each row execute function private.guard_held_activity();

-- An add-on's data isn't deleted while its records are held (the move to purging).
create or replace function private.guard_held_addon_purge()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.state = 'purging' and old.state is distinct from 'purging'
     and exists (select 1 from private.addon_holds(new.workspace_id, new.addon_id) h where h.records > 0) then
    raise exception 'This add-on keeps records your business holds, so its data can''t be deleted yet'
      using errcode = '42501', detail = 'addon_data_held';
  end if;
  return new;
end $$;

create trigger addon_installations_held before update of state on app.addon_installations
  for each row execute function private.guard_held_addon_purge();

-- A business with a record under a legal hold isn't deleted.
create or replace function private.guard_held_workspace_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.deletion_requested_at is not null and old.deletion_requested_at is null
     and exists (select 1 from app.record_holds h
                 where h.workspace_id = new.id and h.kind = 'legal' and h.lifted_at is null) then
    raise exception 'A record in this business is under a legal hold, so the business can''t be deleted'
      using errcode = '42501', detail = 'workspace_data_held';
  end if;
  return new;
end $$;

create trigger workspaces_held before update of deletion_requested_at on app.workspaces
  for each row execute function private.guard_held_workspace_deletion();

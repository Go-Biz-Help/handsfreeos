-- =============================================================================
-- 0093 · Deleting a business, and everything in it.
--
--        `workspace.delete` has been an owner's permission since 0002 and the
--        table has had a delete policy since 0005, but nothing could use
--        either: the event log and the audit log hold every business's
--        history `on delete restrict` and refuse deletes outright, so the
--        first row of history a business ever wrote kept it alive for good.
--        Several other append-only rules (a system timeline entry, the usage
--        ledger, the last owner) would have refused the same delete a step
--        later.
--
--        **Two steps, because a business is more than its rows.** It has a
--        phone sub-account that bills every month, files in Storage, a
--        payment account connected to it, sending domains and its own web
--        address, and every one of those has to be let go while we can
--        still read the credentials that let us do it. So:
--
--        1. `private.request_workspace_deletion` (an owner, through the
--           `workspace.delete` command) marks the business. It is hidden
--           from everybody at once and nothing more can be done in it.
--        2. The worker's job lets go of what lives outside the database,
--           then calls `private.purge_workspace`, which takes the history
--           first and then the business itself: every other table follows
--           the business `on delete cascade`.
--
--        **What survives.** One organization-level line in the audit log
--        saying who deleted which business and when (it names the business
--        and nothing in it), a support ticket (its business is set to null,
--        0070) and an agency’s migration (the same, 0068). Nothing that was
--        in the business does.
--
--        **The append-only rules stay append-only.** They let a delete
--        through only while `private.workspace_purges` has a row, and that
--        row is written and removed inside the purge's own transaction, so no
--        other transaction can ever see it.
-- =============================================================================

-- ---------- the mark ----------
alter table app.workspaces
  add column deletion_requested_at timestamptz,
  add column deletion_requested_by uuid references app.users (id) on delete set null;

comment on column app.workspaces.deletion_requested_at is
  'An owner asked for this business to be deleted. It is hidden from everybody from this moment, and the worker deletes it.';

-- Only the request function sets the mark, and nothing takes it off: a person's own update, through the
-- update policy an admin also passes, may not touch either column.
create or replace function private.guard_deletion_mark()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated'
     and (new.deletion_requested_at is distinct from old.deletion_requested_at
          or new.deletion_requested_by is distinct from old.deletion_requested_by) then
    raise exception 'Deleting a business goes through its own request'
      using errcode = '42501', detail = 'workspace_deletion_mark';
  end if;
  return new;
end $$;

create trigger workspaces_deletion_mark before update on app.workspaces
  for each row execute function private.guard_deletion_mark();

-- ---------- hidden at once ----------
-- Every read and write policy asks one of these three who can reach a business. A business being deleted is
-- reachable by nobody, whatever their role, so it drops out of every list and every command refuses it while
-- the worker finishes the job.
create or replace function private.direct_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm
  join app.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid() and w.deletion_requested_at is null
$$;

create or replace function private.accessible_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm
  join app.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid() and w.deletion_requested_at is null
  union
  select w.id from app.workspaces w
  join app.organization_memberships om on om.organization_id = w.organization_id
  where om.user_id = auth.uid() and w.deletion_requested_at is null
  union
  select v.workspace_id from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  join app.workspaces w on w.id = v.workspace_id
  where v.staff_user_id = auth.uid() and v.ended_at is null and v.expires_at > now()
    and w.deletion_requested_at is null
$$;

create or replace function private.effective_workspace_role(p_ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select r from (
    select wm.role::text as r from app.workspace_memberships wm
    join app.workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = p_ws and wm.user_id = auth.uid() and w.deletion_requested_at is null
    union all
    select om.role::text from app.organization_memberships om
    join app.workspaces w on w.organization_id = om.organization_id
    where w.id = p_ws and om.user_id = auth.uid() and w.deletion_requested_at is null
  ) roles
  order by private.role_rank(r) desc
  limit 1
$$;

-- The business's own row is read through the organization as well (member_organization_ids), so it says the same.
drop policy workspaces_select on app.workspaces;
create policy workspaces_select on app.workspaces
  for select to authenticated using (
    deletion_requested_at is null
    and (
      id in (select private.direct_workspace_ids())
      or organization_id in (select private.member_organization_ids())
    )
  );

create or replace function private.request_workspace_deletion(p_workspace uuid)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  -- Asked here, not taken on trust: this writes past every policy.
  if not private.has_permission(p_workspace, 'workspace.delete') then
    raise exception 'Only an owner can delete a business' using errcode = '42501', detail = 'workspace_delete_forbidden';
  end if;
  update app.workspaces w
     set deletion_requested_at = coalesce(w.deletion_requested_at, now()),
         deletion_requested_by = coalesce(w.deletion_requested_by, v_uid)
   where w.id = p_workspace
  returning w.deletion_requested_at into v_at;
  if v_at is null then
    raise exception 'Workspace not found' using errcode = 'P0002', detail = 'workspace_missing';
  end if;
  return v_at;
end $$;

revoke all on function private.request_workspace_deletion(uuid) from public;
grant execute on function private.request_workspace_deletion(uuid) to authenticated;

-- ---------- the purge ----------
create table private.workspace_purges (
  workspace_id uuid primary key
);
revoke all on private.workspace_purges from public;

-- True only inside private.purge_workspace's own transaction (the row is never committed).
create or replace function private.purging_workspace(p_workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.workspace_purges p where p.workspace_id = p_workspace)
$$;
grant execute on function private.purging_workspace(uuid) to public;

-- The event log and the audit log: append-only, except for the business being purged.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace((to_jsonb(old) ->> 'workspace_id')::uuid) then
    return old;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501';
end $$;

-- A system timeline entry (0006, as 0056 left it): the same, plus the purge.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace(old.workspace_id) then
    return old;
  end if;
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

-- The usage ledger (0072): the same, plus the purge.
create or replace function private.guard_usage_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace(old.workspace_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'The usage ledger is append-only: add an adjustment instead of changing a row'
      using errcode = '42501', detail = 'usage_ledger_append_only';
  end if;
  if private.system_scope_workspace() is distinct from new.workspace_id then
    raise exception 'Only HandsFreeOS writes the usage ledger'
      using errcode = '42501', detail = 'usage_ledger_is_ours';
  end if;
  return new;
end $$;

-- The last owner (0002): a business that is going needs no owner left on it.
create or replace function private.protect_last_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace(old.workspace_id) then
    return old;
  end if;
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not exists (
      select 1 from app.workspace_memberships m
      where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id
    ) and not exists (
      select 1 from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id
      where w.id = old.workspace_id and om.role = 'owner' and om.user_id <> old.user_id
    ) then
      raise exception 'A workspace must keep at least one Owner' using errcode = '23514', detail = 'last_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function private.purge_workspace(p_workspace uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_marked timestamptz;
begin
  select w.deletion_requested_at into v_marked from app.workspaces w where w.id = p_workspace;
  if not found then
    return; -- already gone: a retry has nothing left to do
  end if;
  if v_marked is null then
    raise exception 'That business was never asked to be deleted'
      using errcode = '55000', detail = 'workspace_not_marked';
  end if;

  insert into private.workspace_purges (workspace_id) values (p_workspace) on conflict do nothing;

  -- History first: nothing else can go while an event or its audit row still points at the business.
  delete from app.audit_logs a
   where a.workspace_id = p_workspace
      or a.event_id in (select e.id from app.events e where e.workspace_id = p_workspace);
  delete from app.activities a where a.workspace_id = p_workspace;
  delete from app.workflow_runs r where r.workspace_id = p_workspace;
  delete from app.events e where e.workspace_id = p_workspace;

  -- Then the business, and with it every table that hangs off it.
  delete from app.workspaces w where w.id = p_workspace;

  delete from private.workspace_purges p where p.workspace_id = p_workspace;
end $$;

revoke all on function private.purge_workspace(uuid) from public;
grant execute on function private.purge_workspace(uuid) to service_actor;

-- ---------- what is stored outside the tables ----------
-- Every object a business has in Storage — attachments, imports, recordings, texts' pictures, email
-- attachments, knowledge files, port papers — lives under `<workspace id>/`, in whichever bucket. The worker
-- removes each one through the Storage API (which also removes the file, not just the row), and asks here
-- which there are, because the files table only knows about the attachments. Only for a business that is
-- being deleted.
create or replace function private.workspace_stored_objects(p_workspace uuid)
returns table (bucket text, name text)
language sql stable security definer set search_path = '' as $$
  select o.bucket_id, o.name from storage.objects o
  where o.name like p_workspace::text || '/%'
    and exists (select 1 from app.workspaces w where w.id = p_workspace and w.deletion_requested_at is not null)
  order by o.bucket_id, o.name
$$;

revoke all on function private.workspace_stored_objects(uuid) from public;
grant execute on function private.workspace_stored_objects(uuid) to service_actor;

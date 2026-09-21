-- =============================================================================
-- 0078 · A number rings the people it belongs to.
--
--        Today every inbound call rings **everybody**. private.phone_route()
--        hands back the browser identity of every workspace member and every
--        organization member holding `inbox.use`, and since `inbox.use` is
--        seeded for `member`, that is the whole team — for every number, on
--        every call. One business with one number and three people is fine.
--        A business with a front desk number and a dispatch number is three
--        phones ringing for a call meant for one of them.
--
--        So a number can have people. `app.phone_number_members` is the same
--        shape `calendar_members` and `service_staff` already use, including
--        the denormalised `workspace_id` — RLS then asks one question instead
--        of joining back through the number.
--
--        **The fallback is the entire safety story.** A number with nobody on
--        it rings everybody, exactly as today. That is what makes this change
--        invisible to every business that has not opted into it, and it is
--        why the expression below is a `coalesce(nullif(..., '{}'), ...)`
--        rather than a simple filter: get it wrong and inbound calls ring
--        nobody at all, which is the worst thing this system can do.
--
--        **Being on a number does not grant the inbox.** The `inbox.use`
--        filter stays on the member arm too, so somebody taken off the inbox
--        stops ringing even if nobody remembered to take them off the number.
-- =============================================================================

create table app.phone_number_members (
  phone_number_id uuid not null references app.phone_numbers (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- Denormalised on purpose: every RLS policy here is about the workspace, and carrying it means none of
  -- them has to join back through app.phone_numbers to find out which one.
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (phone_number_id, user_id)
);
create index phone_number_members_user_idx on app.phone_number_members (workspace_id, user_id);
create trigger phone_number_members_immutable before update on app.phone_number_members
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'phone_number_id', 'user_id');

comment on table app.phone_number_members is
  'Who a number rings. Empty for a number means everybody with the inbox, which is how every business '
  'worked before this existed and how one that never touches this keeps working.';

alter table app.phone_number_members enable row level security;

create policy phone_number_members_select on app.phone_number_members for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy phone_number_members_insert on app.phone_number_members for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy phone_number_members_delete on app.phone_number_members for delete to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy phone_number_members_service_all on app.phone_number_members for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.phone_number_members from public;
-- No update: a membership is added or taken away, never edited. The immutable trigger says the same thing
-- twice on purpose, for anyone who grants update later without thinking about it.
grant select, insert, delete on app.phone_number_members to authenticated;
grant select, insert, update, delete on app.phone_number_members to service_actor;

-- ---------- who a call rings ----------
-- `create or replace` keeps the revoke/grant from 0011, so the security-definer posture is unchanged: still
-- revoked from public, still executable only by the roles named there.
create or replace function private.phone_route(p_to_e164 text)
returns table (phone_number_id uuid, workspace_id uuid, organization_id uuid, account_id uuid, e164 text,
  routing jsonb, timezone text, workspace_name text, client_identities text[])
language sql stable security definer set search_path = '' as $$
  select pn.id, pn.workspace_id, w.organization_id, pn.account_id, pn.e164, pn.routing, w.timezone, w.name,
    coalesce(
      -- The people on this number, when anybody is. `inbox.use` is checked here as well as on the wide arm:
      -- being on a number is about which calls reach you, not about whether you may answer any.
      nullif((
        select array_agg('u' || replace(m.user_id::text, '-', '') order by m.user_id)
        from app.phone_number_members m
        where m.phone_number_id = pn.id
          and private.user_has_permission(m.user_id, pn.workspace_id, 'inbox.use')
      ), '{}'),
      -- Nobody on it: everybody with the inbox, which is exactly what this returned before 0078.
      (
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
      ),
      '{}')
  from app.phone_numbers pn
  join app.workspaces w on w.id = pn.workspace_id
  where pn.e164 = p_to_e164 and pn.status = 'active'
$$;

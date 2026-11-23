-- The functions row security calls keep their plan (speed audit, Nov 2026).
--
-- Every policy asks a helper "which businesses is this person in?" or "may they do this?". Each helper was
-- `language sql`, and one that runs as its owner or pins its search_path can't be inlined, so Postgres parsed and
-- planned its body again in every statement that read a protected table: about 0.6 ms of a 0.75 ms read. Written in
-- plpgsql, a helper's plan is kept for the life of the database connection.
--
-- Measured on a local copy (one business with 12,680 Social Outreach profiles), a person reading one row:
--   addon_outreach.computers   0.73 ms -> 0.17 ms
--   app.people                 0.82 ms -> 0.15 ms
--   app.addon_installations    0.76 ms -> 0.16 ms
-- and whole API queries, in database time:
--   outreach.counts 3.5 -> 1.0 ms, outreach.live 14.7 -> 6.9 ms, outreach.waiting 16.9 -> 10.3 ms,
--   outreach.today 237 -> 151 ms.
--
-- Nothing a helper answers changes. Each body below is the one it had (its newest definition in the migrations before
-- this one), re-created with the same arguments, result, volatility, rights and search_path:
--   - a helper that gives rows says `return query` and its select;
--   - a helper that gives one value from an expression says `return` and the expression;
--   - a helper that gives one value from a select says `return (select …)`. Six of them could, by their text alone,
--     find more than one row, where a `language sql` function gives the first: they say `limit 1`, which is the same
--     answer (`return (select …)` would raise on a second row);
--   - the three that give named columns (`returns table`) say `#variable_conflict use_column`, so a name in their body
--     is the column's, as it was.
-- `create or replace` keeps each function's owner and who may run it.
--
-- The rule from here on, held by packages/db/test/policy-helpers.test.ts: a function a policy reaches, straight or
-- through another helper, is written in plpgsql.

create or replace function portal.document_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select s.document_id
  from app.document_signers s join portal.session() p
    on p.person_id = s.person_id and p.workspace_id = s.workspace_id
  join app.documents d on d.id = s.document_id
  where d.status <> 'voided';
end
$$;

create or replace function portal.person()
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select person_id from portal.session()
    limit 1);
end
$$;

create or replace function portal.records()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select private.portal_records_for(s.workspace_id, s.person_id) from portal.session() s;
end
$$;

create or replace function portal.session()
returns table(person_id uuid, workspace_id uuid) language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  select s.person_id, s.workspace_id
  from app.portal_sessions s join app.portal_access a on a.id = s.access_id
  where current_setting('role', true) = 'portal_actor'
    and s.id = nullif(current_setting('app.portal.session_id', true), '')::uuid
    and s.ended_at is null and a.revoked_at is null
    and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
  union all
  -- The teammate, for one run: never alongside a device's session, and only while the run is answering.
  select r.person_id, r.workspace_id
  from app.ai_teammate_runs r
  where current_setting('role', true) = 'portal_actor'
    and nullif(current_setting('app.portal.session_id', true), '') is null
    and r.id = nullif(current_setting('app.portal.teammate_run', true), '')::uuid
    and r.status = 'running' and r.person_id is not null
    and r.started_at > now() - interval '30 minutes';
end
$$;

create or replace function portal.workspace()
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select workspace_id from portal.session()
    limit 1);
end
$$;

create or replace function private.accessible_organization_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select om.organization_id from app.organization_memberships om where om.user_id = auth.uid()
  union
  select w.organization_id from app.workspaces w
  join app.workspace_memberships wm on wm.workspace_id = w.id
  where wm.user_id = auth.uid()
  union
  select w.organization_id from app.workspaces w where w.id = private.founder_acting_workspace();
end
$$;

create or replace function private.accessible_workspace_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
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
  where v.staff_user_id = auth.uid() and v.ended_at is null
    and (v.expires_at > now() or (v.expires_at is null and s.founder))
    and w.deletion_requested_at is null;
end
$$;

create or replace function private.active_view_as(p_user uuid, p_ws uuid)
returns table(session_id uuid, organization_id uuid) language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = p_user and v.workspace_id = p_ws
    and v.ended_at is null and (v.expires_at > now() or (v.expires_at is null and s.founder));
end
$$;

create or replace function private.addon_alert_visible(p_alert uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.addon_alerts a
    where a.id = p_alert
      and a.workspace_id in (select private.accessible_workspace_ids())
      and private.addon_in_use(a.workspace_id, a.addon_id, false)
      and private.has_permission(a.workspace_id, a.permission)
      and (cardinality(a.audience_user_ids) = 0 or (select auth.uid()) = any (a.audience_user_ids))
      -- About a private record (step 4): only for the people who see it.
      and (a.custom_record_id is null or private.custom_record_visible(a.custom_record_id)));
end
$$;

create or replace function private.addon_phone_permission(p_addon text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select a.permission from app.addon_phone_addons a where a.addon_id = p_addon
    limit 1);
end
$$;

create or replace function private.addon_writable(p_ws uuid, p_addon text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon and i.state in ('enabled', 'installing')
      and not exists (select 1 from platform.addon_overrides o where o.addon_id = p_addon and o.status = 'unavailable'));
end
$$;

create or replace function private.custom_record_visible(p_record uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.custom_records r
    where r.id = p_record
      and r.workspace_id in (select private.accessible_workspace_ids())
      and not (r.type_id in (select private.hidden_record_kinds()))
      and (not r.kept_to_team
           or r.owner_user_id = auth.uid()
           or r.team_user_ids @> array[auth.uid()]
           or r.type_id in (select private.private_kinds_seen_whole())
           or private.support_sees_record(r.workspace_id, r.id))
      and (not r.kept_to_team or not private.read_through_a_view() or private.viewer_sees_record(r.id)));
end
$$;

create or replace function private.direct_workspace_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select wm.workspace_id from app.workspace_memberships wm
  join app.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid() and w.deletion_requested_at is null;
end
$$;

create or replace function private.document_record_visible(p_person uuid, p_company uuid, p_lead uuid, p_record uuid)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  return (p_person is null or p_person in (select p.id from app.people p where p.bin_item_id is null))
    and (p_company is null or p_company in (select c.id from app.companies c where c.bin_item_id is null))
    and (p_lead is null or p_lead in (select l.id from app.leads l where l.bin_item_id is null))
    and (p_record is null or (private.custom_record_visible(p_record)
      and p_record in (select r.id from app.custom_records r where r.bin_item_id is null)));
end
$$;

create or replace function private.effective_workspace_role(p_ws uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return (
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
    limit 1);
end
$$;

create or replace function private.founder_acting_workspace()
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return private.founder_acting_workspace_of(auth.uid());
end
$$;

create or replace function private.founder_acting_workspace_of(p_user uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select v.workspace_id
    from platform.view_as_sessions v
    join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active' and s.founder
    join app.workspaces w on w.id = v.workspace_id
    where v.staff_user_id = p_user and v.acts and v.ended_at is null
      and (v.expires_at is null or v.expires_at > now())
      and w.deletion_requested_at is null
    limit 1);
end
$$;

-- With 'facebook', as 20261027035300 (the guided Facebook & Instagram setup) leaves it. That migration reached the
-- hosted database before this one, and re-creating the function without it would hide that setup's saved answers.
create or replace function private.guided_setup_permission(p_setup text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  return case p_setup
    when 'phone' then 'channels.manage'
    when 'email' then 'channels.manage'
    when 'calendar' then 'calendars.manage'
    when 'payments' then 'money.manage'
    when 'chat' then 'channels.manage'
    when 'facebook' then 'channels.manage'
  end;
end
$$;

create or replace function private.has_org_permission(p_org uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.role_permissions rp
    where rp.role = 'org_' || private.org_role(p_org) and rp.permission = p_perm
  );
end
$$;

create or replace function private.has_permission(p_ws uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.user_has_permission(auth.uid(), p_ws, p_perm)
    or coalesce(
      p_ws = private.founder_acting_workspace()
        and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm),
      false);
end
$$;

create or replace function private.hidden_record_kinds()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select t.id from app.custom_record_types t
  where t.addon_id is not null
    and t.workspace_id in (select private.accessible_workspace_ids())
    and not (t.addon_id = any (private.running_addons(t.workspace_id)));
end
$$;

create or replace function private.i_am_founder()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from platform.staff s
    where s.user_id = auth.uid() and s.founder and s.status = 'active');
end
$$;

create or replace function private.inbox_narrowed(p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.inbox_per_person(p_ws) and not private.has_permission(p_ws, 'channels.manage');
end
$$;

create or replace function private.inbox_per_person(p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce(
    (select (w.settings -> 'inbox' ->> 'perPerson')::boolean from app.workspaces w where w.id = p_ws),
    false);
end
$$;

create or replace function private.is_staff()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.staff_role() is not null;
end
$$;

create or replace function private.may_ask_about(p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return p_ws is not null and (
    (current_setting('role', true) = 'service_actor' and p_ws = private.system_scope_workspace())
    or exists (select 1 from private.accessible_workspace_ids() a(id) where a.id = p_ws));
end
$$;

create or replace function private.may_edit_hours(p_ws uuid, p_owner_kind app.schedule_owner_kind, p_owner_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.has_permission(p_ws, 'calendars.manage')
    or (p_owner_kind = 'user' and p_owner_id = auth.uid() and private.has_permission(p_ws, 'appointments.write'));
end
$$;

create or replace function private.may_edit_schedule(p_schedule uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select private.may_edit_hours(s.workspace_id, s.owner_kind, s.owner_id) from app.schedules s where s.id = p_schedule
  ), false);
end
$$;

create or replace function private.may_view_as(p_ws uuid, p_person uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce(
    p_person is distinct from auth.uid()
    and private.works_in(p_person, p_ws)
    and exists (select 1 from app.workspaces w where w.id = p_ws and w.deletion_requested_at is null)
    and (
      exists (select 1 from private.my_view_as(p_ws))
      or (
        private.has_permission(p_ws, 'members.view_as')
        and private.role_rank(private.user_workspace_role(p_person, p_ws))
            < private.role_rank(private.my_workspace_role(p_ws))
        and coalesce((select wa.permissions from app.workspace_access wa
                      where wa.user_id = p_person and wa.workspace_id = p_ws), '{}'::text[])
            <@ private.my_permissions(p_ws)
        -- Holding the same permissions isn't seeing the same threads and bills: someone who sees only their own
        -- (0083's narrowed inbox, 0050's members' money) would see the teammate's through the view.
        and (not private.inbox_narrowed(p_ws)
             or not exists (select 1 from app.workspace_access wa
                            where wa.user_id = p_person and wa.workspace_id = p_ws and 'inbox.use' = any (wa.permissions)))
        and (private.has_permission(p_ws, 'money.manage')
             or not exists (select 1 from app.workspace_access wa
                            where wa.user_id = p_person and wa.workspace_id = p_ws and 'money.read' = any (wa.permissions)))
      )
    ), false);
end
$$;

create or replace function private.member_organization_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select om.organization_id from app.organization_memberships om where om.user_id = auth.uid();
end
$$;

create or replace function private.migration_connection_is_my_business(p_connection uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.migration_connections c
    where c.id = p_connection and c.workspace_id is not null
      and private.has_permission(c.workspace_id, 'migrations.manage'));
end
$$;

create or replace function private.migration_reaches_my_workspace(p_migration uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    -- A sub-account of this migration that landed in a business of mine.
    select 1 from app.migration_scopes s
    where s.migration_id = p_migration and s.workspace_id is not null
      and private.has_permission(s.workspace_id, 'migrations.manage'))
  or exists (
    -- Or: no sub-account of mine yet, because nothing has been discovered — but my own business connected
    -- the source this migration runs on, so looking at it is the next thing it is meant to do.
    select 1 from app.migrations m
    join app.migration_connections c on c.id = m.connection_id
    where m.id = p_migration and c.workspace_id is not null
      and private.has_permission(c.workspace_id, 'migrations.manage'));
end
$$;

create or replace function private.migration_scope_is_mine(p_scope uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.migration_scopes s
    join app.migrations m on m.id = s.migration_id
    join app.migration_connections c on c.id = m.connection_id
    where s.id = p_scope
      and (
        (s.workspace_id is not null and private.has_permission(s.workspace_id, 'migrations.manage'))
        or (s.workspace_id is null and c.workspace_id is not null
            and private.has_permission(c.workspace_id, 'migrations.manage'))));
end
$$;

create or replace function private.money_biller(p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.has_permission(p_ws, 'money.bill') and not private.has_permission(p_ws, 'money.manage');
end
$$;

create or replace function private.money_estimate_visible(p_ws uuid, p_estimate uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.estimates e
    where e.id = p_estimate and e.workspace_id = p_ws
      and private.money_member_sees(e.workspace_id, e.lead_id, null, e.person_id));
end
$$;

create or replace function private.money_invoice_visible(p_ws uuid, p_invoice uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.invoices i
    where i.id = p_invoice and i.workspace_id = p_ws
      and private.money_member_sees(i.workspace_id, i.lead_id, i.attendee_id, i.person_id));
end
$$;

create or replace function private.money_member_sees(p_ws uuid, p_lead uuid, p_attendee uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.money_member_sees(p_ws, p_lead, p_attendee, null);
end
$$;

create or replace function private.money_member_sees(p_ws uuid, p_lead uuid, p_attendee uuid, p_person uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
      select 1 from app.leads l
      where l.id = p_lead and l.workspace_id = p_ws and l.assignee_user_id = auth.uid())
    or exists (
      select 1 from app.appointment_staff s
      where s.appointment_id = (select a.appointment_id from app.appointment_attendees a where a.id = p_attendee)
        and s.user_id = auth.uid() and s.active and s.workspace_id = p_ws)
    or exists (
      select 1 from app.people p
      where p.id = p_person and p.workspace_id = p_ws
        and (p.owner_user_id = auth.uid() or p.team_user_ids @> array[auth.uid()]));
end
$$;

create or replace function private.my_permissions(p_ws uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce(array(
    select wa.p from app.workspace_access a
    join app.workspaces w on w.id = a.workspace_id
    cross join lateral unnest(a.permissions) as wa(p)
    where a.user_id = auth.uid() and a.workspace_id = p_ws and w.deletion_requested_at is null
    union
    select rp.permission from app.role_permissions rp
    where rp.role = 'owner' and p_ws = private.founder_acting_workspace()
    order by 1), '{}'::text[]);
end
$$;

create or replace function private.my_team_scopes()
returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select coalesce(array_agg(distinct k.team_scope), '{}') from app.sync_keys k
    where k.user_id = (select auth.uid()) and k.kind = 'all');
end
$$;

create or replace function private.my_view_as(p_ws uuid)
returns table(session_id uuid, organization_id uuid) language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = auth.uid() and v.workspace_id = p_ws
    and v.ended_at is null and (v.expires_at > now() or (v.expires_at is null and s.founder));
end
$$;

create or replace function private.my_workspace_role(p_ws uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return case when p_ws = private.founder_acting_workspace() then 'owner'
              else private.effective_workspace_role(p_ws) end;
end
$$;

create or replace function private.org_role(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select om.role::text from app.organization_memberships om
    where om.organization_id = p_org and om.user_id = auth.uid()
    limit 1);
end
$$;

create or replace function private.organizations_with_permission(p_perm text)
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select om.organization_id from app.organization_memberships om
  where om.user_id = auth.uid()
    and exists (select 1 from app.role_permissions rp
                where rp.role = 'org_' || om.role::text and rp.permission = p_perm);
end
$$;

create or replace function private.path_workspace(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end;
end
$$;

create or replace function private.portal_records_for(p_ws uuid, p_person uuid)
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select r.id
  from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible and t.archived_at is null
  join app.custom_records r on r.id = coalesce(rel.a_custom_record_id, rel.b_custom_record_id)
  join app.custom_record_types k on k.id = r.type_id
  where rel.workspace_id = p_ws and p_person is not null
    and p_ws = coalesce(private.system_scope_workspace(), portal.workspace())
    and p_person in (rel.a_person_id, rel.b_person_id)
    and r.workspace_id = p_ws and r.purged_at is null
    and k.addon_id = any (private.running_addons(p_ws));
end
$$;

create or replace function private.private_kinds_seen_whole()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select t.id from app.custom_record_types t
  where t.workspace_id = any (array(select private.accessible_workspace_ids()))
    and t.kept_to_team
    and private.has_permission(t.workspace_id, t.see_all_permission);
end
$$;

create or replace function private.read_through_a_view()
returns boolean language plpgsql stable set search_path = '' as $$
begin
  return coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'hfos_viewer', '') <> '';
end
$$;

create or replace function private.reading_bin()
returns boolean language plpgsql stable set search_path = '' as $$
begin
  return coalesce(current_setting('app.read_bin', true), '') = 'on';
end
$$;

create or replace function private.role_rank(p_role text)
returns integer language plpgsql immutable parallel safe set search_path = '' as $$
begin
  return case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end;
end
$$;

create or replace function private.running_addons(p_ws uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select coalesce(array_agg(i.addon_id order by i.addon_id), '{}'::text[])
    from app.addon_installations i
    where i.workspace_id = p_ws and i.state = 'enabled'
      and not exists (
        select 1 from platform.addon_overrides o where o.addon_id = i.addon_id and o.status = 'unavailable'));
end
$$;

create or replace function private.sets_up_ai_in_organization(p_org uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from private.accessible_workspace_ids() a (id)
    join app.workspaces w on w.id = a.id
    where w.organization_id = p_org and private.has_permission(w.id, 'ai_team.manage')
  );
end
$$;

create or replace function private.staff_can(p_perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.role_permissions rp
    where rp.role = 'staff_' || private.staff_role() and rp.permission = p_perm
  );
end
$$;

create or replace function private.staff_role()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select s.role::text from platform.staff s
    where s.user_id = auth.uid() and s.status = 'active'
    limit 1);
end
$$;

create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.bin_item_id is null
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
      -- Nothing a message or a call in the bin carried.
      and not exists (
        select 1 from app.messages m
        where m.bin_item_id is not null and m.workspace_id = private.path_workspace(p_name)
          and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
            or (split_part(p_name, '/', 2) = 'messages'
              and m.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
      and not exists (
        select 1 from app.calls c
        where c.bin_item_id is not null and c.workspace_id = private.path_workspace(p_name)
          and (c.recording_object_path = p_name
            or (split_part(p_name, '/', 2) = 'calls'
              and c.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end;
end
$$;

create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'document' or private.has_permission(f.workspace_id, 'documents.manage'))
        and (f.record_type <> 'form' or private.has_permission(f.workspace_id, 'forms.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    when 'brand-uploads' then exists (
      select 1 from app.workspaces w
      where w.id = private.path_workspace(p_name)
        and w.settings -> 'look' -> 'upload' ->> 'path' = p_name
        and w.settings -> 'look' -> 'upload' ->> 'by' = (select auth.uid())::text
        and coalesce(w.settings -> 'look' -> 'upload' ->> 'sent', 'false') = 'false'
        and private.has_permission(w.id, 'workspace.update'))
    else false
  end;
end
$$;

create or replace function private.support_seen_records()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select r.id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  join app.record_support_grants g
    on g.workspace_id = v.workspace_id and g.status = 'active' and g.expires_at > now()
  join app.custom_records r on r.workspace_id = v.workspace_id and r.kept_to_team
  where v.staff_user_id = auth.uid() and v.ended_at is null
    and (v.expires_at > now() or (v.expires_at is null and s.founder))
    and private.user_sees_record(g.granted_by, r.id);
end
$$;

create or replace function private.support_sees_record(p_ws uuid, p_record uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from private.active_view_as(auth.uid(), p_ws))
    and exists (
      select 1 from app.record_support_grants g
      where g.workspace_id = p_ws and g.status = 'active' and g.expires_at > now()
        and private.user_sees_record(g.granted_by, p_record));
end
$$;

create or replace function private.system_scope_founder_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select s.user_id
  from platform.staff s
  where s.founder and s.status = 'active'
    and exists (
      select 1 from platform.view_as_sessions v
      where v.staff_user_id = s.user_id and v.acts
        and v.workspace_id = private.system_scope_workspace());
end
$$;

create or replace function private.system_scope_organization()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('app.system_scope.organization_id', true), '')::uuid;
end
$$;

create or replace function private.system_scope_user_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select wm.user_id from app.workspace_memberships wm
  where wm.workspace_id = private.system_scope_workspace()
  union
  select om.user_id from app.organization_memberships om
  where om.organization_id = private.system_scope_organization();
end
$$;

create or replace function private.system_scope_workspace()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('app.system_scope.workspace_id', true), '')::uuid;
end
$$;

create or replace function private.takes_part_in_ideas()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return auth.uid() is not null and (
    exists (select 1 from app.workspace_memberships m where m.user_id = auth.uid())
    or exists (select 1 from app.organization_memberships m where m.user_id = auth.uid())
    or private.is_staff());
end
$$;

create or replace function private.the_viewer()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  return (
    select case when c.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then c.v::uuid end
    from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'hfos_viewer' as v) c);
end
$$;

create or replace function private.topic_workspace()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  return case
    when realtime.topic() ~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then substr(realtime.topic(), 11)::uuid
  end;
end
$$;

create or replace function private.unseen_private_records()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select r.id from app.custom_records r
  where r.workspace_id = any (array(select private.accessible_workspace_ids()))
    and r.kept_to_team
    and r.owner_user_id is distinct from auth.uid()
    and not (r.team_user_ids @> array[auth.uid()])
    and not (r.type_id in (select private.private_kinds_seen_whole()))
    and not (r.id in (select private.support_seen_records()))
  union all
  select u.id from private.unseen_through_the_view() u(id);
end
$$;

create or replace function private.unseen_sealed_appointments()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select a.id from app.appointments a
  where a.sealed and a.custom_record_id in (select private.unseen_private_records());
end
$$;

create or replace function private.unseen_sealed_conversations()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select c.id from app.conversations c
  where c.sealed and c.workspace_id in (select private.accessible_workspace_ids())
    and c.custom_record_id in (select private.unseen_private_records());
end
$$;

create or replace function private.unseen_through_the_view()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select r.id from app.custom_records r
  where (select private.read_through_a_view())
    and r.workspace_id = any (array(select private.accessible_workspace_ids()))
    and r.kept_to_team
    and not private.viewer_sees_record(r.id);
end
$$;

create or replace function private.user_has_permission(p_user uuid, p_ws uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.workspace_access wa
    join app.workspaces w on w.id = wa.workspace_id
    where wa.user_id = p_user and wa.workspace_id = p_ws and p_perm = any (wa.permissions)
      and w.deletion_requested_at is null);
end
$$;

create or replace function private.user_sees_record(p_user uuid, p_record uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    where r.id = p_record and private.works_in(p_user, r.workspace_id)
      and (not r.kept_to_team
           or r.owner_user_id = p_user
           or r.team_user_ids @> array[p_user]
           or private.user_has_permission(p_user, r.workspace_id, t.see_all_permission)));
end
$$;

create or replace function private.user_workspace_role(p_user uuid, p_ws uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select r from (
      select wm.role::text as r from app.workspace_memberships wm
      join app.workspaces w on w.id = wm.workspace_id
      where wm.workspace_id = p_ws and wm.user_id = p_user and w.deletion_requested_at is null
      union all
      select om.role::text from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id
      where w.id = p_ws and om.user_id = p_user and w.deletion_requested_at is null
    ) roles
    order by private.role_rank(r) desc
    limit 1);
end
$$;

create or replace function private.viewer_has_permission(p_ws uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select coalesce(
      private.user_has_permission(v.id, p_ws, p_perm)
      or exists (
        select 1 from platform.view_as_sessions s
        join platform.staff st on st.user_id = s.staff_user_id and st.status = 'active' and st.founder
        join app.workspaces w on w.id = s.workspace_id and w.deletion_requested_at is null
        where s.staff_user_id = v.id and s.workspace_id = p_ws and s.acts and s.ended_at is null
          and (s.expires_at is null or s.expires_at > now())
          and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm)),
      false)
    from (select private.the_viewer() as id) v);
end
$$;

create or replace function private.viewer_sees_record(p_record uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select not r.kept_to_team
      or private.user_sees_record(v.id, r.id)
      or private.viewer_has_permission(r.workspace_id, t.see_all_permission)
      or (exists (select 1 from private.active_view_as(v.id, r.workspace_id))
          and exists (select 1 from app.record_support_grants g
                      where g.workspace_id = r.workspace_id and g.status = 'active' and g.expires_at > now()
                        and private.user_sees_record(g.granted_by, r.id)))
    from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    cross join (select private.the_viewer() as id) v
    where r.id = p_record), false);
end
$$;

create or replace function private.visible_user_ids()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select auth.uid()
  union
  select wm.user_id from app.workspace_memberships wm
  where wm.workspace_id in (select private.accessible_workspace_ids())
  union
  select om.user_id from app.organization_memberships om
  where om.organization_id in (select private.member_organization_ids());
end
$$;

create or replace function private.works_in(p_user uuid, p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from app.workspace_access wa where wa.user_id = p_user and wa.workspace_id = p_ws);
end
$$;

create or replace function private.workspace_organization(p_ws uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return (
    select w.organization_id from app.workspaces w where w.id = p_ws
    limit 1);
end
$$;

create or replace function private.workspaces_with_permission(p_perm text)
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select wa.workspace_id from app.workspace_access wa
  join app.workspaces w on w.id = wa.workspace_id
  where wa.user_id = auth.uid() and p_perm = any (wa.permissions)
    and w.deletion_requested_at is null
  union
  select f.id from (select private.founder_acting_workspace() as id) f
  where f.id is not null
    and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm);
end
$$;

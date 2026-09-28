-- =============================================================================
-- What a role carries, worked out once, and what changing an add-on touches.
--
--        **One answer for what a role carries.** Handing someone a role checks
--        that it carries nothing the person handing it out may not do here
--        (0106's rule, 20261012060200). That used core's TypeScript copy of the
--        permission rules, which knows nothing of add-ons: a role could carry
--        an add-on's permission its giver had been kept from, unchecked (audit
--        P-2). private.permissions_for() is now the one place the rules live —
--        a role's defaults, the business's setting for the role and for the
--        person, what each permission stands on, and only the permissions of
--        add-ons that run here — and both a person's own list
--        (private.user_permissions) and what a role would carry
--        (private.role_would_grant) read it.
--
--        **What changing an add-on touches.** Before an add-on is turned off,
--        uninstalled or its data deleted, the person is shown what it holds:
--        its records, the relationships on them, work still queued, things it
--        holds at providers, rows in its own tables and what it has counted
--        (private.addon_impact_counts), beside what the catalogue says depends
--        on it.
-- =============================================================================

-- Everything someone with this role may do in this business: 0106's rule, with only running add-ons' permissions.
-- p_user is the person, for their own settings; null for someone not yet in the business (an invitation).
create or replace function private.permissions_for(p_ws uuid, p_role text, p_user uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  with live as (select private.running_addons(p_ws) as ids),
  candidates as (
    select rp.permission from app.role_permissions rp, live
    where rp.role = p_role and (rp.addon_id is null or rp.addon_id = any (live.ids))
    union
    select c.permission from app.customizable_permissions c, live
    where c.addon_id is null or c.addon_id = any (live.ids)
  ),
  base as (
    select k.permission,
      case
        when p_role is null then false
        when p_role = 'owner' then exists (
          select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = k.permission)
        else coalesce(
          (select m.allowed from app.member_permission_overrides m
           where p_user is not null and m.workspace_id = p_ws and m.user_id = p_user and m.permission = k.permission),
          (select o.allowed from app.role_permission_overrides o
           where o.workspace_id = p_ws and o.role::text = p_role and o.permission = k.permission),
          exists (select 1 from app.role_permissions rp where rp.role = p_role and rp.permission = k.permission))
      end as allowed
    from candidates k
  )
  select coalesce(array_agg(b.permission order by b.permission), '{}'::text[])
  from base b
  where b.allowed
    and not exists (
      select 1 from app.customizable_permissions c
      cross join lateral unnest(c.requires) as q(p)
      where c.permission = b.permission
        and not exists (select 1 from base b2 where b2.permission = q.p and b2.allowed))
$$;

create or replace function private.user_permissions(p_user uuid, p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select private.permissions_for(p_ws, private.user_workspace_role(p_user, p_ws), p_user)
$$;

-- What a role would carry for someone (an invitation, a role change), for whoever may hand roles out here.
create or replace function private.role_would_grant(p_ws uuid, p_role app.member_role, p_user uuid default null)
returns text[] language sql stable security definer set search_path = '' as $$
  select case
    when private.has_permission(p_ws, 'members.invite') or private.has_permission(p_ws, 'members.change_role')
      then private.permissions_for(p_ws, p_role::text,
        case when private.has_permission(p_ws, 'members.change_role') then p_user end)
    else '{}'::text[]
  end
$$;

-- What an add-on holds in one business, for someone deciding whether to turn it off, uninstall it or delete its
-- data. Counts only, and only for people who may change add-ons here.
create or replace function private.addon_impact_counts(p_ws uuid, p_addon text)
returns table (records bigint, relationships bigint, pending_jobs bigint, held_resources bigint,
  owned_rows bigint, usage_events bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_permission(p_ws, 'addons.manage') then
    raise exception 'You can''t change add-ons here' using errcode = '42501', detail = 'addon_needs_manage';
  end if;
  return query select
    (select count(*) from app.custom_records r join app.custom_record_types t on t.id = r.type_id
     where r.workspace_id = p_ws and t.addon_id = p_addon and r.purged_at is null),
    (select count(*) from app.relationships r join app.relationship_types t on t.id = r.type_id
     where r.workspace_id = p_ws and t.addon_id = p_addon),
    (select count(*) from app.scheduled_jobs j
     where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending'),
    (select count(*) from app.addon_resources x
     where x.workspace_id = p_ws and x.addon_id = p_addon and x.status <> 'released'),
    private.addon_owned_rows(p_ws, p_addon),
    (select count(*) from app.addon_usage_events u where u.workspace_id = p_ws and u.addon_id = p_addon);
end $$;

revoke all on function private.permissions_for(uuid, text, uuid),
  private.role_would_grant(uuid, app.member_role, uuid), private.addon_impact_counts(uuid, text) from public;
grant execute on function private.role_would_grant(uuid, app.member_role, uuid),
  private.addon_impact_counts(uuid, text) to authenticated, service_actor;

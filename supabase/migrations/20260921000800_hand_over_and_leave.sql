-- =============================================================================
-- 0061 · Handing an organization over, and leaving with no business.
--          - private.add_organization_owner: an owner of an organization makes
--            someone else an owner of it. An organization's memberships only
--            ever came from creating it, so a business's founder (or an
--            agency's owner) was always its only owner, and the last-owner rule
--            kept them from deleting their account. Only someone who already
--            owns part of it can be made an owner: an admin of the
--            organization, or a direct owner of one of its businesses. So
--            handing an agency over never gives a stranger every business in
--            it. organization.add_owner calls it, and so does account.delete
--            for an organization that holds a single business, which passes to
--            that business's other owners when its last owner leaves.
--          - private.request_account_deletion: someone who belongs to no
--            business deletes their account. The request can't be recorded in
--            a business for the worker to read (as account.deletion_requested
--            is), so this queues the worker's account-deletion job directly:
--            only for the person asking, and only while they belong to no
--            business, so it can never skip the per-business steps.
--          - private.cancel_bridge_call: the call sheet's Cancel. People never
--            change a call (the worker records them); this is the one change
--            they may make: ending their own call through their cell before the
--            customer picks up (call.cancel_connect), in one statement, with the
--            timeline entry they wrote for it when the customer's phone had
--            already rung. The worker hangs up the carrier's call.
-- =============================================================================

create or replace function private.add_organization_owner(p_org uuid, p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_role app.org_role;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not private.has_org_permission(p_org, 'org.members.manage') then
    raise exception 'Only an owner of the organization can make someone an owner'
      using errcode = '42501', detail = 'organization_owner_required';
  end if;
  if p_user = v_uid then
    raise exception 'You are an owner already' using errcode = '23514', detail = 'own_role';
  end if;
  if not exists (select 1 from app.users u where u.id = p_user and u.deleted_at is null) then
    raise exception 'No such person' using errcode = 'P0002', detail = 'user_not_found';
  end if;
  select m.role into v_role from app.organization_memberships m
  where m.organization_id = p_org and m.user_id = p_user
  for update;
  if v_role = 'owner' then
    return 'owner';
  end if;
  -- Someone who already owns part of it: an admin of the organization, or an owner of one of its businesses.
  if v_role is null and not exists (
    select 1 from app.workspace_memberships wm
    join app.workspaces w on w.id = wm.workspace_id
    where w.organization_id = p_org and wm.user_id = p_user and wm.role = 'owner'
  ) then
    raise exception 'Only an owner of one of the organization''s businesses can be made its owner'
      using errcode = '23514', detail = 'not_a_business_owner';
  end if;
  if v_role is null then
    insert into app.organization_memberships (organization_id, user_id, role) values (p_org, p_user, 'owner');
  else
    update app.organization_memberships m set role = 'owner'
    where m.organization_id = p_org and m.user_id = p_user;
  end if;
  return coalesce(v_role::text, 'none');
end $$;
comment on function private.add_organization_owner(uuid, uuid) is
  'An owner of an organization makes someone who already owns one of its businesses (or an admin of it) an owner of it too. Returns the role they had: none, admin or owner.';

create or replace function private.request_account_deletion()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_queued integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not exists (select 1 from app.users u where u.id = v_uid) then
    raise exception 'User profile missing' using errcode = 'P0002', detail = 'profile_missing';
  end if;
  -- Someone in a business asks through each of their businesses (account.deletion_requested), so the worker takes
  -- them off each one's calendars and mailboxes first.
  if exists (select 1 from private.accessible_workspace_ids()) then
    raise exception 'This account belongs to a business' using errcode = '23514', detail = 'has_business';
  end if;
  -- The worker's job (apps/worker/src/account/delete.ts): the same kind and key its event handler uses.
  insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload)
  values ('account.delete', 'account-delete:' || v_uid::text, now(), jsonb_build_object('userId', v_uid))
  on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
  get diagnostics v_queued = row_count;
  return v_queued > 0;
end $$;
comment on function private.request_account_deletion() is
  'Someone in no business deletes their account: queues the worker''s account.delete job for them. Refused while they belong to a business.';

create or replace function private.cancel_bridge_call(p_call uuid, p_activity uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  -- The timeline entry is the person's own record of this call, in its business.
  if p_activity is not null and not exists (
    select 1 from app.activities a join app.calls c on c.workspace_id = a.workspace_id
    where a.id = p_activity and c.id = p_call and a.kind = 'call' and a.author_user_id = v_uid
  ) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  update app.calls c set status = 'canceled', ended_at = now(), activity_id = coalesce(p_activity, c.activity_id)
  where c.id = p_call and c.placed_by = v_uid and c.answered_via = 'bridge'
    and c.status in ('initiated', 'ringing', 'in_progress') and c.ended_at is null and c.answered_at is null
    and private.has_permission(c.workspace_id, 'inbox.use');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
comment on function private.cancel_bridge_call(uuid, uuid) is
  'Ends the signed-in person''s own call through their cell before the customer answers (call.cancel_connect). False when it is no longer theirs to cancel.';

-- ---------- function privileges ----------
revoke all on function
  private.add_organization_owner(uuid, uuid), private.request_account_deletion(), private.cancel_bridge_call(uuid, uuid)
  from public;
grant execute on function
  private.add_organization_owner(uuid, uuid), private.request_account_deletion(), private.cancel_bridge_call(uuid, uuid)
  to authenticated;

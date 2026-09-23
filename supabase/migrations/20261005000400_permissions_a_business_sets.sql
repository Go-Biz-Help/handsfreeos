-- =============================================================================
-- 0103 · What each role may do, and what each person may do, set by the
--        business's owners — and members who bill.
--
--        The three roles and what they may do have been fixed since 0002:
--        app.role_permissions, mirrored in packages/core/src/permissions.ts.
--        They stay, as the defaults. On top of them an owner now turns
--        permissions on or off for the Admin and Member roles of their own
--        business, and for any one person in it:
--
--          app.role_permission_overrides     one business, one role, one
--                                            permission: on or off
--          app.member_permission_overrides   one business, one person, one
--                                            permission: on or off
--
--        **The person's own setting wins, then the role's, then the default.**
--        Owners are never narrowed: they hold every owner permission whatever
--        is stored, so a business can never lock itself out. Only the
--        permissions in app.customizable_permissions can be set at all — the
--        ones that make no sense to take away (opening the business, seeing
--        its customers and its team) or to hand out (deleting the business,
--        setting permissions) stay the role's.
--
--        **Some permissions stand on others.** Sending invoices is no use to
--        someone who may not see money; managing channels, to someone who may
--        not use the inbox. `requires` lists what each needs (already closed
--        over, so one level of checking is enough), and a permission whose
--        requirements are off is off, whatever its own setting says.
--
--        **One stored answer, read by everything.** app.workspace_access (0056)
--        already holds each person's role in each business for the phone's
--        sync; it now holds their permissions too, recomputed by triggers
--        whenever a role, a membership or a setting changes, and
--        private.has_permission() — every RLS policy in the product — reads
--        it. So the web, the API, the database, the worker and the phone all
--        give the same answer, and the parity helper below says when the
--        stored copy and the rules disagree (it never should). The flags the
--        sync config reads come off the same row: manages_money (the money
--        stream, which read `role <> 'member'`) and sees_whole_inbox (0083).
--
--        **Members who bill.** A new permission, money.bill: write, send and
--        void estimates and invoices, take a payment by hand, and start and
--        run plans. Owners and admins have it; members don't until an owner
--        says so. Someone who bills but doesn't manage money bills the
--        customers they can already see money for (0050's rule, with 0101's
--        customer arm): the ones they're on, the leads they work, the visits
--        they're staffed on. The documents, their lines, their payments and
--        the plans gain policies saying exactly that. Refunds, the catalogue,
--        the money settings and the payment accounts stay money.manage.
-- =============================================================================

-- ---------- the new permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'money.bill'), ('admin', 'money.bill'),
  ('owner', 'permissions.manage');

-- ---------- what can be set ----------
create table app.customizable_permissions (
  permission text primary key check (permission ~ '^[a-z_]+(\.[a-z_]+)+$'),
  -- Everything it stands on, all the way down.
  requires text[] not null default '{}'
);
comment on table app.customizable_permissions is
  'The permissions an owner may turn on or off for a role or a person (0103), and what each needs to mean anything. Mirrored in packages/core/src/permissions.ts.';

insert into app.customizable_permissions (permission, requires) values
  ('records.write', '{records.read}'),
  ('records.archive', '{records.read,records.write}'),
  ('records.assign', '{records.read,records.write}'),
  ('records.import', '{records.read,records.write}'),
  ('tags.manage', '{records.read,records.write}'),
  ('pipelines.manage', '{records.read,records.write}'),
  ('fields.manage', '{records.read,records.write}'),
  ('files.delete', '{records.read,records.write}'),
  ('inbox.use', '{}'),
  ('channels.manage', '{inbox.use}'),
  ('appointments.write', '{}'),
  ('calendars.manage', '{appointments.write}'),
  ('money.read', '{}'),
  ('money.bill', '{money.read}'),
  ('money.manage', '{money.bill,money.read}'),
  ('workflows.manage', '{}'),
  ('forms.manage', '{}'),
  ('reviews.manage', '{}'),
  ('templates.manage', '{}'),
  ('assistant.use', '{}'),
  ('knowledge.manage', '{}'),
  ('ai_team.manage', '{}'),
  ('workspace.update', '{}'),
  ('audit.read', '{}'),
  ('migrations.manage', '{}'),
  ('members.invite', '{invitations.read}'),
  ('invitations.read', '{}'),
  ('invitations.revoke', '{invitations.read}'),
  ('members.change_role', '{}'),
  ('members.remove', '{}');

-- ---------- the settings ----------
create table app.role_permission_overrides (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Owners are never narrowed.
  role app.member_role not null check (role <> 'owner'),
  permission text not null references app.customizable_permissions (permission) on delete cascade,
  allowed boolean not null,
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, role, permission)
);
comment on table app.role_permission_overrides is
  'A business''s own answer for one role and one permission (0103), in place of app.role_permissions'' default.';

create table app.member_permission_overrides (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  permission text not null references app.customizable_permissions (permission) on delete cascade,
  allowed boolean not null,
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id, permission)
);
create index member_permission_overrides_user_idx on app.member_permission_overrides (user_id);
comment on table app.member_permission_overrides is
  'A business''s own answer for one person and one permission (0103), in place of their role''s. Never read for an owner.';

-- A person set here belongs to the business when they are set. Somebody who later leaves keeps their row, which
-- reads nothing (they have no role here), until the business or they are gone.
create or replace function private.guard_member_permission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.workspace_has_user(new.workspace_id, new.user_id) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger member_permission_overrides_guard before insert on app.member_permission_overrides
  for each row execute function private.guard_member_permission();

-- ---------- the rules ----------
-- The role one person has in one business: the higher of their own and their agency's, and none while the
-- business is being deleted — private.effective_workspace_role() for anybody, not only whoever is asking.
create or replace function private.user_workspace_role(p_user uuid, p_ws uuid)
returns text language sql stable security definer set search_path = '' as $$
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
  limit 1
$$;

-- Everything one person may do in one business, worked out from the sources: the role's defaults, the business's
-- setting for the role, the person's own setting, and what each permission stands on. The stored copy in
-- app.workspace_access is this, kept by the triggers below; this is what they and the parity helper compute.
create or replace function private.user_permissions(p_user uuid, p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  with r as (select private.user_workspace_role(p_user, p_ws) as role),
  candidates as (
    select rp.permission from app.role_permissions rp, r where rp.role = r.role
    union
    select c.permission from app.customizable_permissions c
  ),
  base as (
    select k.permission,
      case
        when r.role is null then false
        when r.role = 'owner' then exists (
          select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = k.permission)
        else coalesce(
          (select m.allowed from app.member_permission_overrides m
           where m.workspace_id = p_ws and m.user_id = p_user and m.permission = k.permission),
          (select o.allowed from app.role_permission_overrides o
           where o.workspace_id = p_ws and o.role::text = r.role and o.permission = k.permission),
          exists (select 1 from app.role_permissions rp where rp.role = r.role and rp.permission = k.permission))
      end as allowed
    from candidates k cross join r
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

-- ---------- the stored answer ----------
alter table app.workspace_access
  add column permissions text[] not null default '{}',
  add column manages_money boolean not null default false;
comment on column app.workspace_access.permissions is
  'Everything this person may do in this business (0103): private.user_permissions(), kept by triggers. What private.has_permission() and the phone read.';
comment on column app.workspace_access.manages_money is
  'Whether this person manages money here (money.manage, 0103): what the business_v1 `managed` sync parameter reads.';

-- One person in one business, recomputed: their role and, now, their permissions.
create or replace function private.refresh_workspace_access(p_user uuid, p_ws uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_permissions text[];
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
    v_permissions := private.user_permissions(p_user, p_ws);
    insert into app.workspace_access as a (user_id, workspace_id, role, permissions)
    values (p_user, p_ws, v_role::app.member_role, v_permissions)
    on conflict (user_id, workspace_id) do update
      set role = excluded.role, permissions = excluded.permissions
      where a.role is distinct from excluded.role or a.permissions is distinct from excluded.permissions;
  end if;
end $$;

-- The flags the sync config reads, off the stored permissions, whoever writes the row.
create or replace function private.inbox_access_flag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sees_whole_inbox := not private.inbox_per_person(new.workspace_id)
    or 'channels.manage' = any (new.permissions);
  new.manages_money := 'money.manage' = any (new.permissions);
  return new;
end $$;

create or replace function private.inbox_repaint_access(p_ws uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_touched integer;
begin
  update app.workspace_access wa
  set sees_whole_inbox = (not private.inbox_per_person(p_ws) or 'channels.manage' = any (wa.permissions))
  where wa.workspace_id = p_ws
    and wa.sees_whole_inbox is distinct from
        (not private.inbox_per_person(p_ws) or 'channels.manage' = any (wa.permissions));
  get diagnostics v_touched = row_count;
  return v_touched;
end $$;

-- Whoever may do something here, by the stored answer. The one question every RLS policy asks, through
-- private.has_permission(). A business being deleted grants nobody anything.
create or replace function private.user_has_permission(p_user uuid, p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.workspace_access wa
    join app.workspaces w on w.id = wa.workspace_id
    where wa.user_id = p_user and wa.workspace_id = p_ws and p_perm = any (wa.permissions)
      and w.deletion_requested_at is null)
$$;

create or replace function private.has_permission(p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_has_permission(auth.uid(), p_ws, p_perm)
$$;

-- The asker's own permissions here, for the command kernel and the screens.
create or replace function private.my_permissions(p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce((
    select wa.permissions from app.workspace_access wa
    join app.workspaces w on w.id = wa.workspace_id
    where wa.user_id = auth.uid() and wa.workspace_id = p_ws and w.deletion_requested_at is null), '{}'::text[])
$$;

-- Everyone in a business and what they may do, for its own people (members.read): the team page, and the
-- people an account can be kept to. Nobody outside it gets anything.
create or replace function private.workspace_member_permissions(p_ws uuid)
returns table (user_id uuid, role text, permissions text[])
language sql stable security definer set search_path = '' as $$
  select wa.user_id, wa.role::text, wa.permissions
  from app.workspace_access wa
  where wa.workspace_id = p_ws and private.has_permission(p_ws, 'members.read')
$$;

-- ---------- keeping the stored answer in step ----------
-- A role's setting changed: everyone with that role here.
create or replace function private.role_permission_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  perform private.refresh_workspace_access(wa.user_id, wa.workspace_id)
  from app.workspace_access wa
  where wa.workspace_id = v_ws
    and wa.role in (coalesce(new.role, old.role), coalesce(old.role, new.role));
  return null;
end $$;
create trigger role_permission_overrides_access after insert or update or delete on app.role_permission_overrides
  for each row execute function private.role_permission_changed();

-- One person's setting changed: them.
create or replace function private.member_permission_changed()
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
create trigger member_permission_overrides_access after insert or update or delete on app.member_permission_overrides
  for each row execute function private.member_permission_changed();

-- The defaults themselves changed (a later migration adding a permission): everyone, everywhere.
create or replace function private.permission_defaults_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.refresh_workspace_access(wa.user_id, wa.workspace_id) from app.workspace_access wa;
  return null;
end $$;
create trigger role_permissions_access after insert or update or delete on app.role_permissions
  for each statement execute function private.permission_defaults_changed();
create trigger customizable_permissions_access after insert or update or delete on app.customizable_permissions
  for each statement execute function private.permission_defaults_changed();

-- What a person's permissions reach: the money and the threads they may see as a member. Their role moving
-- already repainted these; now their permissions moving does too.
drop trigger workspace_access_money_viewers_changed on app.workspace_access;
create trigger workspace_access_money_viewers_changed after update on app.workspace_access for each row
  when (old.role is distinct from new.role or old.permissions is distinct from new.permissions)
  execute function private.money_viewers_access_changed();
drop trigger workspace_access_inbox_viewers_changed on app.workspace_access;
create trigger workspace_access_inbox_viewers_changed after update on app.workspace_access for each row
  when (old.role is distinct from new.role or old.permissions is distinct from new.permissions)
  execute function private.inbox_viewers_access_changed();

-- ---------- the rules that read a role, now read the permissions ----------
-- A member for money is someone who reads it and doesn't manage it: by what they may do, not by their role.
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
  where 'money.read' = any (wa.permissions) and not 'money.manage' = any (wa.permissions)
$$;

-- Everyone who works the inbox here and doesn't manage channels.
create or replace function private.inbox_eligible_members(p_ws uuid)
returns table (user_id uuid) language sql stable security definer set search_path = '' as $$
  select wa.user_id from app.workspace_access wa
  where wa.workspace_id = p_ws
    and 'inbox.use' = any (wa.permissions)
    and not 'channels.manage' = any (wa.permissions)
$$;

-- Who a call rings: the people on the number who may use the inbox, or else everyone who may.
create or replace function private.phone_route(p_to_e164 text)
returns table (phone_number_id uuid, workspace_id uuid, organization_id uuid, account_id uuid, e164 text,
  routing jsonb, timezone text, workspace_name text, client_identities text[])
language sql stable security definer set search_path = '' as $$
  select pn.id, pn.workspace_id, w.organization_id, pn.account_id, pn.e164, pn.routing, w.timezone, w.name,
    coalesce(
      nullif((
        select array_agg('u' || replace(m.user_id::text, '-', '') order by m.user_id)
        from app.phone_number_members m
        where m.phone_number_id = pn.id
          and private.user_has_permission(m.user_id, pn.workspace_id, 'inbox.use')
      ), '{}'),
      (
        select array_agg('u' || replace(wa.user_id::text, '-', '') order by wa.user_id)
        from app.workspace_access wa
        where wa.workspace_id = pn.workspace_id and 'inbox.use' = any (wa.permissions)
      ),
      '{}')
  from app.phone_numbers pn
  join app.workspaces w on w.id = pn.workspace_id
  where pn.e164 = p_to_e164 and pn.status = 'active'
$$;

-- ---------- the parity helper, with the permissions ----------
-- Every person and business where app.workspace_access disagrees with the rules: its role against
-- private.effective_workspace_role(), its permissions against private.user_permissions(), and manages_money
-- against private.has_permission(…, 'money.manage'), each evaluated as that person. Empty means in step.
create or replace function private.sync_access_mismatches(p_workspace uuid default null)
returns table (user_id uuid, workspace_id uuid, stored_role text, effective_role text, stored_manages_money boolean,
  manages_money boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person record;
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select u.id from app.users u
    where p_workspace is null
      or u.id in (
        select wm.user_id from app.workspace_memberships wm where wm.workspace_id = p_workspace
        union
        select om.user_id from app.organization_memberships om
        join app.workspaces w on w.organization_id = om.organization_id where w.id = p_workspace
        union
        select a.user_id from app.workspace_access a where a.workspace_id = p_workspace)
    order by u.id
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    return query
      with reach as (
        select wm.workspace_id as ws from app.workspace_memberships wm where wm.user_id = v_person.id
        union
        select w.id from app.workspaces w
        join app.organization_memberships om on om.organization_id = w.organization_id
        where om.user_id = v_person.id
        union
        select a.workspace_id from app.workspace_access a where a.user_id = v_person.id
      ),
      judged as (
        select r.ws, a.role::text as stored, private.effective_workspace_role(r.ws) as effective,
          a.manages_money as stored_manages,
          private.has_permission(r.ws, 'money.manage') as manages,
          a.permissions as stored_permissions,
          case when private.effective_workspace_role(r.ws) is null then null
               else private.user_permissions(v_person.id, r.ws) end as permissions,
          (select w.deletion_requested_at is not null from app.workspaces w where w.id = r.ws) as deleting
        from reach r
        left join app.workspace_access a on a.user_id = v_person.id and a.workspace_id = r.ws
        where p_workspace is null or r.ws = p_workspace
      )
      select v_person.id, j.ws, j.stored, j.effective, j.stored_manages, j.manages
      from judged j
      -- A business being deleted answers nothing either way, whatever its stored rows still say.
      where not coalesce(j.deleting, false)
        and (j.stored is distinct from j.effective
          or coalesce(j.stored_manages, false) is distinct from coalesce(j.manages, false)
          or coalesce(j.stored_permissions, '{}') is distinct from coalesce(j.permissions, '{}'));
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- ---------- everyone, now ----------
update app.workspace_access wa
set permissions = private.user_permissions(wa.user_id, wa.workspace_id)
where wa.permissions is distinct from private.user_permissions(wa.user_id, wa.workspace_id);

-- ======================================================================
-- Money: people who bill without managing money
-- ======================================================================
-- Someone who may bill and may not manage money: they bill the customers they can see money for.
create or replace function private.money_biller(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission(p_ws, 'money.bill') and not private.has_permission(p_ws, 'money.manage')
$$;

create policy estimates_bill_insert on app.estimates for insert to authenticated
  with check (private.money_biller(workspace_id) and created_by = (select auth.uid())
    and status = 'draft' and sent_at is null and number is null and accepted_at is null and declined_at is null
    and voided_at is null and first_viewed_at is null and last_viewed_at is null
    and private.money_member_sees(workspace_id, lead_id, null, person_id));
create policy estimates_bill_update on app.estimates for update to authenticated
  using (private.money_biller(workspace_id) and private.money_member_sees(workspace_id, lead_id, null, person_id))
  with check (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, null, person_id));

create policy estimate_lines_bill_insert on app.estimate_lines for insert to authenticated
  with check (private.money_biller(workspace_id) and private.money_estimate_visible(workspace_id, estimate_id));
create policy estimate_lines_bill_update on app.estimate_lines for update to authenticated
  using (private.money_biller(workspace_id) and private.money_estimate_visible(workspace_id, estimate_id))
  with check (private.money_biller(workspace_id) and private.money_estimate_visible(workspace_id, estimate_id));
create policy estimate_lines_bill_delete on app.estimate_lines for delete to authenticated
  using (private.money_biller(workspace_id) and private.money_estimate_visible(workspace_id, estimate_id));

create policy invoices_bill_insert on app.invoices for insert to authenticated
  with check (private.money_biller(workspace_id) and created_by = (select auth.uid())
    and status = 'draft' and sent_at is null and number is null and paid_at is null and voided_at is null
    and first_viewed_at is null and last_viewed_at is null and amount_paid_cents = 0 and amount_refunded_cents = 0
    and private.money_member_sees(workspace_id, lead_id, attendee_id, person_id));
create policy invoices_bill_update on app.invoices for update to authenticated
  using (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, attendee_id, person_id))
  with check (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, attendee_id, person_id));

create policy invoice_lines_bill_insert on app.invoice_lines for insert to authenticated
  with check (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id));
create policy invoice_lines_bill_update on app.invoice_lines for update to authenticated
  using (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id))
  with check (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id));
create policy invoice_lines_bill_delete on app.invoice_lines for delete to authenticated
  using (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id));

-- Cash, a cheque or something taken off the system on a job they bill, in their own name.
create policy payments_bill_insert on app.payments for insert to authenticated
  with check (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id)
    and method in ('cash', 'check', 'other')
    and status = 'succeeded' and provider is null and connection_id is null and provider_payment_id is null
    and provider_status is null and fee_cents is null and net_cents is null
    and card_brand is null and card_last4 is null
    and recorded_by = (select auth.uid()));

-- A document's number is taken as it goes out, by whoever sends it.
create policy document_counters_bill_select on app.document_counters for select to authenticated
  using (private.money_biller(workspace_id));
create policy document_counters_bill_insert on app.document_counters for insert to authenticated
  with check (private.money_biller(workspace_id));
create policy document_counters_bill_update on app.document_counters for update to authenticated
  using (private.money_biller(workspace_id))
  with check (private.money_biller(workspace_id));

-- Plans, for the customers they bill: seen, started and run.
create policy subscriptions_bill_select on app.subscriptions for select to authenticated
  using (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, null, person_id));
create policy subscriptions_bill_insert on app.subscriptions for insert to authenticated
  with check (private.money_biller(workspace_id) and created_by = (select auth.uid())
    and status = 'draft' and external_subscription_id is null and failed_cycles = 0
    and paused_at is null and cancelled_at is null
    and private.money_member_sees(workspace_id, lead_id, null, person_id));
create policy subscriptions_bill_update on app.subscriptions for update to authenticated
  using (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, null, person_id))
  with check (private.money_biller(workspace_id)
    and private.money_member_sees(workspace_id, lead_id, null, person_id));

-- The accounts they may pick from: the columns people see, never a token (those aren't granted to anyone).
create policy payment_connections_bill_select on app.payment_connections for select to authenticated
  using (private.money_biller(workspace_id));

-- ---------- RLS on the settings ----------
alter table app.customizable_permissions enable row level security;
alter table app.role_permission_overrides enable row level security;
alter table app.member_permission_overrides enable row level security;

create policy customizable_permissions_read on app.customizable_permissions for select to authenticated
  using (true);
create policy customizable_permissions_service_read on app.customizable_permissions for select to service_actor
  using (true);

-- Owners set them, and see them all. Everyone may see their own.
create policy role_permission_overrides_select on app.role_permission_overrides for select to authenticated
  using (private.has_permission(workspace_id, 'permissions.manage'));
create policy role_permission_overrides_write on app.role_permission_overrides for all to authenticated
  using (private.has_permission(workspace_id, 'permissions.manage'))
  with check (private.has_permission(workspace_id, 'permissions.manage') and updated_by = (select auth.uid()));
create policy role_permission_overrides_service_all on app.role_permission_overrides for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy member_permission_overrides_select on app.member_permission_overrides for select to authenticated
  using (private.has_permission(workspace_id, 'permissions.manage') or user_id = (select auth.uid()));
create policy member_permission_overrides_write on app.member_permission_overrides for all to authenticated
  using (private.has_permission(workspace_id, 'permissions.manage'))
  with check (private.has_permission(workspace_id, 'permissions.manage') and updated_by = (select auth.uid()));
create policy member_permission_overrides_service_all on app.member_permission_overrides for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select on app.customizable_permissions to authenticated, service_actor;
grant select, insert, update, delete on app.role_permission_overrides, app.member_permission_overrides
  to authenticated, service_actor;

revoke all on function
  private.guard_member_permission(), private.user_workspace_role(uuid, uuid), private.user_permissions(uuid, uuid),
  private.my_permissions(uuid), private.workspace_member_permissions(uuid), private.role_permission_changed(),
  private.member_permission_changed(), private.permission_defaults_changed(), private.money_biller(uuid)
  from public;
grant execute on function
  private.user_workspace_role(uuid, uuid), private.user_permissions(uuid, uuid), private.my_permissions(uuid),
  private.workspace_member_permissions(uuid), private.money_biller(uuid)
  to authenticated, service_actor;
grant execute on function private.guard_member_permission(), private.role_permission_changed(),
  private.member_permission_changed(), private.permission_defaults_changed()
  to authenticated, service_actor;

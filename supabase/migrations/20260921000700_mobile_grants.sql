-- =============================================================================
-- 0060 · Milestone 10's grants, foreign-key indexes and parity helpers.
--        People read their own business access, register and turn off their
--        own devices, and add and remove their own cells; the worker reads the
--        access of the business it is scoped to and the devices and cells of
--        its people, and records what Expo and the verification calls say.
--        command_receipts keeps its grants in 0054 and appointments'
--        field_times grant is in 0055, where the kernel needed them first.
--        Push devices and cells join the powersync publication and the sync
--        role's grants here, with their tables (0057 has the rest).
--        Every foreign key 0054-0059 added gets an index that leads with its
--        column where none does (0020's rule; nullable keys get partial ones).
--        And the two parity helpers packages/db/test/sync-access.test.ts calls,
--        which judge the stored sync rules against RLS's own functions and
--        policies, evaluated as each person.
-- =============================================================================

-- ---------- grants: people ----------
grant select on app.workspace_access to authenticated;
grant select, insert on app.push_devices to authenticated;
grant update (platform, app_version, device_name, last_seen_at, disabled_at, disabled_reason)
  on app.push_devices to authenticated;
grant select, insert, delete on app.user_phones to authenticated;

-- ---------- grants: the worker ----------
grant select on app.workspace_access to service_actor;
grant select, update on app.push_devices, app.user_phones to service_actor;
revoke all on app.workspace_access, app.push_devices, app.user_phones from anon;

-- ---------- what phones sync ----------
grant select on app.push_devices, app.user_phones to hfos_sync;
alter publication powersync add table app.push_devices, app.user_phones;

-- ---------- foreign-key indexes ----------
-- command_receipts.user_id, workspace_access.user_id, push_devices.user_id and user_phones.user_id lead a unique key
-- or the primary key already; workspace_access.workspace_id has its index in 0056.
create index command_receipts_workspace_id_idx on app.command_receipts (workspace_id) where workspace_id is not null;
create index people_possible_duplicate_of_idx on app.people (possible_duplicate_of)
  where possible_duplicate_of is not null;
create index companies_possible_duplicate_of_idx on app.companies (possible_duplicate_of)
  where possible_duplicate_of is not null;

-- ---------- parity helpers ----------
-- Every person and business where app.workspace_access disagrees with RLS: its role against
-- private.effective_workspace_role(), and "manages money" (the managed money stream's role <> 'member') against
-- private.has_permission(…, 'money.manage'), both evaluated as that person (their claims set for the call). Only
-- the businesses a person could reach are looked at: anywhere else both sides say nothing. p_workspace narrows it
-- to one business. Empty means in step.
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
          case when a.role is null then null else a.role <> 'member' end as stored_manages,
          private.has_permission(r.ws, 'money.manage') as manages
        from reach r
        left join app.workspace_access a on a.user_id = v_person.id and a.workspace_id = r.ws
        where p_workspace is null or r.ws = p_workspace
      )
      select v_person.id, j.ws, j.stored, j.effective, j.stored_manages, j.manages
      from judged j
      where j.stored is distinct from j.effective
        or coalesce(j.stored_manages, false) is distinct from coalesce(j.manages, false);
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- Every document row and person where member_viewer_ids disagrees with the members' SELECT policy on that table
-- (0050), read from pg_policies and evaluated as that person: estimates, invoices, their lines, payments and
-- refunds. Each of those policies starts "reads money and doesn't manage it" (checked here), so a row can only
-- disagree in a business where that holds for the person, or where a list names them. Those are the only rows
-- judged, found through the workspace_id indexes. In a business where it holds, the rest of the policy is evaluated
-- row by row (its first two checks, already answered for that business, would only repeat); anywhere else a listed
-- row is judged on the whole policy. The people judged are everyone a business's memberships or access rows reach,
-- and everyone any list names; p_workspace narrows it to one business's people and documents. Empty means in step.
create or replace function private.sync_viewer_mismatches(p_workspace uuid default null)
returns table (table_name text, row_id uuid, user_id uuid, listed boolean, visible boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  c_prefix constant text := '(private.has_permission(workspace_id, ''money.read''::text) AND '
    || '(NOT private.has_permission(workspace_id, ''money.manage''::text)) AND ';
  v_person record;
  v_policy record;
  v_reads uuid[];
  v_listed uuid[];
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  if (select count(*) from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('estimates', 'invoices', 'estimate_lines', 'invoice_lines', 'payments', 'refunds')
        and starts_with(p.qual, c_prefix) and right(p.qual, 1) = ')') <> 6 then
    raise exception 'Expected each money table''s members'' SELECT policy to start with money.read and not money.manage';
  end if;
  select coalesce(array_agg(distinct l.id), '{}') into v_listed from (
    select unnest(x.member_viewer_ids) as id from app.estimates x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.invoices x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.estimate_lines x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.invoice_lines x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.payments x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.refunds x where p_workspace is null or x.workspace_id = p_workspace
  ) l;
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select x.id from (
      select wm.user_id as id from app.workspace_memberships wm where p_workspace is null or wm.workspace_id = p_workspace
      union
      select om.user_id from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id where p_workspace is null or w.id = p_workspace
      union
      select a.user_id from app.workspace_access a where p_workspace is null or a.workspace_id = p_workspace
      union
      select unnest(v_listed)
    ) x
    order by x.id
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    select coalesce(array_agg(r.ws), '{}') into v_reads from (
      select wm.workspace_id as ws from app.workspace_memberships wm where wm.user_id = v_person.id
      union
      select w.id from app.workspaces w
      join app.organization_memberships om on om.organization_id = w.organization_id where om.user_id = v_person.id
      union
      select a.workspace_id from app.workspace_access a where a.user_id = v_person.id
    ) r
    where (p_workspace is null or r.ws = p_workspace)
      and private.has_permission(r.ws, 'money.read') and not private.has_permission(r.ws, 'money.manage');
    continue when cardinality(v_reads) = 0 and not v_person.id = any(v_listed);
    for v_policy in
      select p.tablename::text as tbl, p.qual, '(' || substr(p.qual, length(c_prefix) + 1) as rest
      from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('estimates', 'invoices', 'estimate_lines', 'invoice_lines', 'payments', 'refunds')
    loop
      if cardinality(v_reads) > 0 then
        return query execute format(
          'select %L::text, x.id, $3, x.member_viewer_ids @> array[$3], coalesce(%s, false)
           from app.%I x
           where x.workspace_id = any($2) and ($1 is null or x.workspace_id = $1)
             and (x.member_viewer_ids @> array[$3]) is distinct from coalesce(%s, false)',
          v_policy.tbl, v_policy.rest, v_policy.tbl, v_policy.rest)
        using p_workspace, v_reads, v_person.id;
      end if;
      if v_person.id = any(v_listed) then
        return query execute format(
          'select %L::text, x.id, $3, true, coalesce(%s, false)
           from app.%I x
           where x.member_viewer_ids @> array[$3] and not x.workspace_id = any($2)
             and ($1 is null or x.workspace_id = $1) and not coalesce(%s, false)',
          v_policy.tbl, v_policy.qual, v_policy.tbl, v_policy.qual)
        using p_workspace, v_reads, v_person.id;
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- The tests call these as the database's owner; nobody else may.
revoke all on function private.sync_access_mismatches(uuid), private.sync_viewer_mismatches(uuid) from public;

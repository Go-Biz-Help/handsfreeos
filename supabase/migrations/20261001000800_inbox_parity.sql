-- =============================================================================
-- 0084 · Is the narrowed inbox in step? (M17)
--
--        The twin of private.sync_viewer_mismatches() (0057), for the four
--        tables 0083 narrows. Three things have to agree or a business is
--        quietly leaking threads or quietly losing them, and only one of them
--        can be checked by reading code:
--
--          the policies        app.conversations, messages, calls and
--                              attention_items, each with a wide arm and a
--                              member arm
--          the stored lists    member_viewer_ids on those same four
--          the phone           apps/sync/sync-config.yaml, which reads
--                              member_viewer_ids and workspace_access.
--                              sees_whole_inbox and nothing else
--
--        This function judges the first two against each other by *reading the
--        member policy out of pg_policies and running it*, as that person, row
--        by row — so it cannot drift from the policy the way a second copy of
--        the rule written here would. The third follows from the second,
--        because the sync queries are the membership test and nothing more.
--
--        Empty means in step. Anything else names the row, the person, what the
--        list says and what the policy says.
-- =============================================================================

create or replace function private.sync_inbox_mismatches(p_workspace uuid default null)
returns table (table_name text, row_id uuid, user_id uuid, listed boolean, visible boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person record;
  v_policy record;
  v_narrowed uuid[];
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  -- Every member policy has to exist, or this would pass by checking nothing.
  if (select count(*) from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items')) <> 4 then
    raise exception 'Expected a members'' SELECT policy on each of the four inbox tables';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select x.id from (
      select wa.user_id as id from app.workspace_access wa
      where p_workspace is null or wa.workspace_id = p_workspace
      union
      select wm.user_id from app.workspace_memberships wm
      where p_workspace is null or wm.workspace_id = p_workspace
    ) x
    order by x.id
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    -- Only the businesses where this person is actually narrowed: anywhere else the wide arm is the whole
    -- answer and member_viewer_ids is never read by anything.
    select coalesce(array_agg(wa.workspace_id), '{}') into v_narrowed
    from app.workspace_access wa
    where wa.user_id = v_person.id
      and (p_workspace is null or wa.workspace_id = p_workspace)
      and private.inbox_narrowed(wa.workspace_id);
    continue when cardinality(v_narrowed) = 0;
    for v_policy in
      select p.tablename::text as tbl, p.qual
      from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items')
    loop
      return query execute format(
        'select %L::text, x.id, $2, x.member_viewer_ids @> array[$2], coalesce(%s, false)
         from app.%I x
         where x.workspace_id = any($1)
           and (x.member_viewer_ids @> array[$2]) is distinct from coalesce(%s, false)',
        v_policy.tbl, v_policy.qual, v_policy.tbl, v_policy.qual)
      using v_narrowed, v_person.id;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- Whether what the phone would get and what RLS allows can differ at all: the sync parameter says a person
-- sees the whole inbox exactly when they are not narrowed. One row per disagreement; empty means in step.
create or replace function private.sync_inbox_access_mismatches(p_workspace uuid default null)
returns table (user_id uuid, workspace_id uuid, stored_sees_all boolean, sees_all boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person record;
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select distinct wa.user_id as id from app.workspace_access wa
    where p_workspace is null or wa.workspace_id = p_workspace
    order by 1
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    return query
      select v_person.id, wa.workspace_id, wa.sees_whole_inbox,
        not private.inbox_narrowed(wa.workspace_id)
      from app.workspace_access wa
      where wa.user_id = v_person.id
        and (p_workspace is null or wa.workspace_id = p_workspace)
        and wa.sees_whole_inbox is distinct from not private.inbox_narrowed(wa.workspace_id);
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- The tests call these as the database's owner; nobody else may.
revoke all on function
  private.sync_inbox_mismatches(uuid), private.sync_inbox_access_mismatches(uuid) from public;

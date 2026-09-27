-- =============================================================================
-- Is the narrowed inbox in step? Drafts too (SEC-M2).
--
--        20261012020100 made the AI teammate's drafts the fifth table that
--        follows its thread: a stored member_viewer_ids, a wide and a member
--        SELECT policy, and both sync arms. 0084's parity check still read
--        only the first four, so a draft whose list and policy disagreed would
--        pass it. This is 0084's function with the fifth table named; nothing
--        else about how it judges changes.
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
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items', 'ai_teammate_drafts')) <> 5 then
    raise exception 'Expected a members'' SELECT policy on each of the five inbox tables';
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
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items', 'ai_teammate_drafts')
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

revoke all on function private.sync_inbox_mismatches(uuid) from public;

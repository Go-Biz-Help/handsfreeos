-- =============================================================================
-- Records kept to their people: an add-on's rows checked once per question.
--
--        Real Estate step 13, fixing step 4 (20261013002400). An add-on table
--        that follows a private record (a deal's duties, dates, documents)
--        asked private.custom_record_visible(record) for every row it read,
--        and that function asks several more questions each time. A deal list
--        reading every open duty of every deal ran it thousands of times and
--        could hit the statement timeout.
--
--        Now a policy asks once per query for the private records this person
--        can't see (private.unseen_private_records(), usually few: none at all
--        for owners and anyone who sees every deal), and support's once for
--        the records a grant shows them (private.support_seen_records()).
--        What anyone sees doesn't change: the private-records and add-on
--        tests hold both to the same answers as before.
-- =============================================================================

-- The private records HandsFreeOS support may read while their look at the business is open: those the person who
-- let them in sees (20261013002400's support_sees_record, for every record at once).
create or replace function private.support_seen_records()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  join app.record_support_grants g
    on g.workspace_id = v.workspace_id and g.status = 'active' and g.expires_at > now()
  join app.custom_records r on r.workspace_id = v.workspace_id and r.kept_to_team
  where v.staff_user_id = auth.uid() and v.ended_at is null
    and (v.expires_at > now() or (v.expires_at is null and s.founder))
    and private.user_sees_record(g.granted_by, r.id)
$$;

-- The private records in the businesses the caller can open that they may not see: not theirs, not on their team,
-- not of a kind they see whole, and not shown to them by a support grant.
create or replace function private.unseen_private_records()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id from app.custom_records r
  where r.kept_to_team
    and r.workspace_id in (select private.accessible_workspace_ids())
    and r.owner_user_id is distinct from auth.uid()
    and not (r.team_user_ids @> array[auth.uid()])
    and not (r.type_id in (select private.private_kinds_seen_whole()))
    and not (r.id in (select private.support_seen_records()))
$$;

grant execute on function private.unseen_private_records() to authenticated, service_actor;
grant execute on function private.support_seen_records() to authenticated, service_actor;

-- New add-on tables get the once-per-query form.
create or replace function private.addon_table_policies(
  p_table regclass, p_read text, p_write text, p_delete text default null, p_record_column name default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_addon text;
  v_read text;
  v_write text;
  v_follow text := 'true';
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_schema !~ '^addon_[a-z]{2,16}$' then
    raise exception '% is not in an add-on''s schema', p_table using errcode = '23514';
  end if;
  v_addon := substr(v_schema, 7);
  if p_read not like v_addon || '.%' or p_write not like v_addon || '.%'
     or (p_delete is not null and p_delete not like v_addon || '.%') then
    raise exception 'An add-on''s table is guarded by the add-on''s own permissions' using errcode = '23514';
  end if;
  if not exists (
      select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'workspace_id'
        and a.attnotnull and not a.attisdropped) then
    raise exception '% needs workspace_id uuid not null', p_table using errcode = '23514';
  end if;
  -- A row about a record (a deal) is seen and changed only by people who see that record.
  if p_record_column is not null then
    if not exists (
        select 1 from pg_attribute a where a.attrelid = p_table and a.attname = p_record_column
          and not a.attisdropped and a.atttypid = 'uuid'::regtype) then
      raise exception '% has no uuid column %', p_table, p_record_column using errcode = '23514';
    end if;
    v_follow := format('(%I is null or not (%I in (select private.unseen_private_records())))',
      p_record_column, p_record_column);
  end if;
  v_read := format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_read, v_follow);
  v_write := format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_write, v_follow);
  execute format('alter table %s enable row level security', p_table);
  execute format('create policy %I on %s for select to authenticated using (%s)', v_name || '_select', p_table, v_read);
  -- Support, let in to a record, reads what hangs off it too (never writes).
  if p_record_column is not null then
    execute format('create policy %I on %s for select to authenticated using (%I in (select private.support_seen_records()))',
      v_name || '_support_select', p_table, p_record_column);
  end if;
  execute format('create policy %I on %s for insert to authenticated with check (%s)', v_name || '_insert', p_table, v_write);
  execute format('create policy %I on %s for update to authenticated using (%s) with check (%s)',
    v_name || '_update', p_table, v_write, v_write);
  if p_delete is not null then
    execute format('create policy %I on %s for delete to authenticated using (%s)', v_name || '_delete', p_table,
      format('workspace_id in (select private.workspaces_with_permission(%L)) and %s', p_delete, v_follow));
  end if;
  execute format(
    'create policy %I on %s for all to service_actor using (workspace_id = private.system_scope_workspace()) '
    'with check (workspace_id = private.system_scope_workspace() and private.addon_writable(workspace_id, %L))',
    v_name || '_service_all', p_table, v_addon);
  if exists (select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'updated_at' and not a.attisdropped) then
    execute format('create trigger %I before update on %s for each row execute function private.set_updated_at()',
      v_name || '_updated_at', p_table);
  end if;
  execute format(
    'create trigger %I before update on %s for each row execute function private.forbid_tenant_column_change(%L)',
    v_name || '_immutable', p_table, 'workspace_id');
  execute format('grant select, insert, update%s on %s to authenticated',
    case when p_delete is not null then ', delete' else '' end, p_table);
  execute format('grant select, insert, update, delete on %s to service_actor', p_table);
  execute format('revoke all on %s from anon', p_table);
end $$;
revoke execute on function private.addon_table_policies(regclass, text, text, text, name) from public;

-- The add-on tables already made: the same policies, asked once per query.
do $$
declare
  p record;
  v_using text;
  v_check text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check from pg_policies
    where schemaname ~ '^addon_[a-z]{2,16}$'
      and (coalesce(qual, '') ~ 'custom_record_visible\(|support_sees_record\('
           or coalesce(with_check, '') ~ 'custom_record_visible\(')
  loop
    v_using := regexp_replace(
      regexp_replace(p.qual, 'private\.custom_record_visible\((\w+)\)',
        '(NOT (\1 IN (SELECT private.unseen_private_records())))', 'g'),
      '\(\((\w+) IS NOT NULL\) AND private\.support_sees_record\(workspace_id, \w+\)\)',
      '(\1 IN (SELECT private.support_seen_records()))', 'g');
    v_check := regexp_replace(p.with_check, 'private\.custom_record_visible\((\w+)\)',
      '(NOT (\1 IN (SELECT private.unseen_private_records())))', 'g');
    if v_using ~ 'custom_record_visible\(|support_sees_record\('
       or coalesce(v_check, '') ~ 'custom_record_visible\(' then
      raise exception 'Couldn''t restate policy % on %.%', p.policyname, p.schemaname, p.tablename;
    end if;
    execute format('alter policy %I on %I.%I%s%s', p.policyname, p.schemaname, p.tablename,
      case when v_using is not null then format(' using (%s)', v_using) else '' end,
      case when v_check is not null then format(' with check (%s)', v_check) else '' end);
  end loop;
end $$;

-- =============================================================================
-- Add-ons write on timelines and use the AI (Real Estate, step 6).
--
--        **A timeline line of an add-on's own** (`addon_line`): what someone
--        did in it, in its words ("confirmed the inspection deadline"),
--        written by its commands (addonTimelineLine). When the add-on's data is
--        deleted, each keeps who and when and loses what it said, as its
--        events and audit lines do (the owner's decision, 2026-09-28):
--        private.purge_addon_batch redacts them, private.addon_verify checks,
--        and the system-line guard lets exactly that change through.
--
--        **AI use by an add-on** (a status email drafted from a deal's facts)
--        is counted like any other: app.ai_usage source `addon`, with the
--        add-on it was for.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'addon';
alter table app.ai_usage
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  add constraint ai_usage_addon_check check ((source::text = 'addon') = (addon_id is not null));
comment on column app.ai_usage.addon_id is
  'The add-on the AI was used for (source addon): a deal''s status email, say (Real Estate step 6).';

-- ---------- a system line changes only as a purge redacts an add-on's own ----------
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
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'person_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'person_id'])
       and coalesce(private.merging_person(old.person_id::text, new.person_id::text), false) then
      return new;
    end if;
    -- An add-on's own line, losing its words while that add-on's data is deleted.
    if tg_op = 'UPDATE' and old.subtype = 'addon_line'
       and (to_jsonb(new) - array['body', 'meta', 'updated_at']) = (to_jsonb(old) - array['body', 'meta', 'updated_at'])
       and new.meta -> 'addon' = old.meta -> 'addon' and new.body is null
       and coalesce(private.purging_addon(old.workspace_id, old.meta -> 'addon' ->> 'id'), false) then
      return new;
    end if;
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- ---------- checking and deleting an add-on's data (20261013002500's, with its timeline lines) ----------
create or replace function private.addon_verify(p_ws uuid, p_addon text)
returns table (check_name text, ok boolean, found bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text;
  v_n bigint;
begin
  perform private.assert_worker_scope(p_ws);
  select i.state into v_state from app.addon_installations i where i.workspace_id = p_ws and i.addon_id = p_addon;
  if v_state is null then
    return;
  end if;
  if v_state = 'enabled' then
    select count(*) into v_n from app.custom_record_types t
    where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is not null;
    return query select 'record_kinds_shown'::text, v_n = 0, v_n;
    return;
  end if;
  -- Off, arriving, leaving or gone: it runs nowhere here.
  select count(*) into v_n from app.workspace_access wa
  where wa.workspace_id = p_ws
    and wa.permissions && array(select private.addon_permissions(p_addon));
  return query select 'no_permissions_held'::text, v_n = 0, v_n;
  select count(*) into v_n from app.scheduled_jobs j
  where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending';
  return query select 'no_jobs_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.webhook_deliveries d
  where d.workspace_id = p_ws and d.addon_id = p_addon and d.status = 'pending';
  return query select 'no_deliveries_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is null;
  return query select 'record_kinds_hidden'::text, v_n = 0, v_n;
  select count(*) into v_n from app.relationship_types r
  where r.workspace_id = p_ws and r.addon_id = p_addon and r.archived_at is null;
  return query select 'relationship_types_hidden'::text, v_n = 0, v_n;
  select count(*) into v_n from app.addon_alerts a
  where a.workspace_id = p_ws and a.addon_id = p_addon and a.cleared_at is null;
  select v_n + count(*) into v_n from app.attention_items i
  where i.workspace_id = p_ws and i.kind = 'addon_alert' and i.state <> 'resolved'
    and i.subject_id in (select a.id from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon);
  return query select 'no_alerts_showing'::text, v_n = 0, v_n;
  if v_state in ('uninstalled', 'purging', 'purged') then
    select count(*) into v_n from app.addon_resources r
    where r.workspace_id = p_ws and r.addon_id = p_addon and r.status <> 'released';
    return query select 'no_resources_held'::text, v_n = 0, v_n;
  end if;
  if v_state = 'purged' then
    v_n := private.addon_owned_rows(p_ws, p_addon);
    return query select 'no_rows_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon and r.purged_at is null;
    return query select 'records_tombstoned'::text, v_n = 0, v_n;
    select count(*) into v_n from app.relationships r
    join app.relationship_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon;
    return query select 'no_relationships_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon;
    return query select 'no_alerts_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon and (i.settings <> '{}'::jsonb or i.flags <> '{}'::jsonb);
    select v_n + count(*) into v_n from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
    return query select 'no_settings_left'::text, v_n = 0, v_n;
    select count(*) into v_n from (
      select 1 from app.role_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))
      union all
      select 1 from app.member_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))) x;
    return query select 'no_permission_choices_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.events e
    where e.workspace_id = p_ws and e.addon_id = p_addon and not (e.payload ? '_redacted');
    select v_n + count(*) into v_n from app.audit_logs a
    where a.workspace_id = p_ws and a.addon_id = p_addon and (a.before is not null or a.after is not null);
    select v_n + count(*) into v_n from app.activities x
    where x.workspace_id = p_ws and x.subtype = 'addon_line' and x.meta -> 'addon' ->> 'id' = p_addon
      and not (x.meta ? '_redacted');
    return query select 'history_details_removed'::text, v_n = 0, v_n;
  end if;
end $$;

create or replace function private.purge_addon_batch(p_ws uuid, p_addon text, p_limit integer default 5000)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_table regclass;
  v_n integer;
  v_kinds uuid[];
  v_types uuid[];
  v_permissions text[];
begin
  perform private.assert_worker_scope(p_ws);
  perform 1 from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'purging'
  for update;
  if not found then
    raise exception 'That add-on''s data isn''t being deleted here' using errcode = '55000', detail = 'addon_not_purging';
  end if;
  insert into private.addon_purges (workspace_id, addon_id) values (p_ws, p_addon) on conflict do nothing;

  -- 1. Its own tables, a batch at a time. Its foreign keys between its own tables cascade (the catalogue test),
  --    so the order doesn't matter.
  for v_table in
    select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'addon_' || p_addon and c.relkind = 'r'
    order by c.relname
  loop
    execute format('delete from %s where ctid in (select ctid from %s where workspace_id = $1 limit $2)',
      v_table, v_table) using p_ws, p_limit;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
      return true;
    end if;
  end loop;

  -- 1b. Its alerts, and their Home cards (Real Estate step 5).
  delete from app.attention_items i
  where i.workspace_id = p_ws and i.kind = 'addon_alert'
    and i.subject_id in (select a.id from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon);
  delete from app.addon_alerts a
  where a.id in (select x.id from app.addon_alerts x where x.workspace_id = p_ws and x.addon_id = p_addon
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 2. The relationships it managed, then the types themselves.
  select coalesce(array_agg(t.id), '{}') into v_types from app.relationship_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  delete from app.relationships r
  where r.id in (select x.id from app.relationships x where x.workspace_id = p_ws and x.type_id = any (v_types)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  delete from app.relationship_types t where t.id = any (v_types);

  -- 3. Its records reduced to their names: what pointed at one still reads, and nothing else about it is kept.
  select coalesce(array_agg(t.id), '{}') into v_kinds from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  update app.custom_records r set purged_at = now(), archived_at = coalesce(r.archived_at, now()),
    notes = null, custom = '{}'::jsonb, field_times = '{}'::jsonb
  where r.id in (select x.id from app.custom_records x
                 where x.workspace_id = p_ws and x.type_id = any (v_kinds) and x.purged_at is null
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 4. History keeps its lines and loses the add-on's details (the owner's decision, 2026-09-28).
  update app.events e set payload = jsonb_build_object('_addon', e.payload -> '_addon', '_redacted', true)
  where e.id in (select x.id from app.events x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and not (x.payload ? '_redacted')
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  update app.audit_logs a set before = null, after = null
  where a.id in (select x.id from app.audit_logs x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and (x.before is not null or x.after is not null)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  -- Its own lines on timelines keep who and when, and lose what they said (step 6).
  update app.activities a set body = null,
    meta = (a.meta - 'words' - 'tone') || '{"_redacted": true}'::jsonb
  where a.id in (select x.id from app.activities x
                 where x.workspace_id = p_ws and x.subtype = 'addon_line' and x.meta -> 'addon' ->> 'id' = p_addon
                   and not (x.meta ? '_redacted')
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 5. Its settings, and the business's own choices about its permissions.
  select coalesce(array_agg(p), '{}') into v_permissions from private.addon_permissions(p_addon) p;
  delete from app.role_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.member_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
  update app.addon_installations i set settings = '{}'::jsonb, flags = '{}'::jsonb, state = 'purged',
    last_error = null
  where i.workspace_id = p_ws and i.addon_id = p_addon;
  delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
  return false;
end $$;

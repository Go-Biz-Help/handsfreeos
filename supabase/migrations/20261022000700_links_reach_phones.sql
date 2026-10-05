-- =============================================================================
-- Links reach phones (Real Estate round six, step 12; core).
--
--        A deal on the phone needs its links: who the client is, which home,
--        the lender and the title company. Those are relationships, which no
--        phone has had (docs/relationships.md, "Not yet"), so a deal read
--        with no signal would show neither its client nor its address.
--
--        records_v1 now sends the relationships that touch an add-on's
--        record, and the add-on's kinds of relationship, sealed the way the
--        records they touch are (20261022000100):
--
--          - a link to one record takes that record's seals;
--          - a link between two records goes to who may see both: open when
--            both are, the private one's people when one is, the people on
--            both when both are (and whoever sees every one of the kind,
--            when it's the same kind);
--          - a link to a record of a kind phones don't keep, or between two
--            add-ons' records, reaches no phone.
--
--        A link's ends never change (relationships_immutable), so only its
--        records' seals move it: their follower trigger now touches links
--        too. Row security already asks both ends; the stream test holds the
--        phone's copy to it.
-- =============================================================================

alter table app.relationships
  add column seal_scope text,
  add column seal_open boolean not null default false,
  add column seal_viewer_ids uuid[] not null default '{}',
  add column seal_all text,
  add column sync_window boolean not null default true;
comment on column app.relationships.seal_scope is
  'For a link touching a record phones keep: ''<business>:<permission>'' a sync key must match (Real Estate round six). Kept by a trigger.';
comment on column app.relationships.seal_viewer_ids is
  'A link touching a private record: the people who may see every end it touches. Kept by a trigger.';

alter table app.relationship_types add column seal_scope text;
comment on column app.relationship_types.seal_scope is
  'An add-on''s kind of link, or one to a kind phones keep: ''<business>:<permission>'' a sync key must match. Kept by a trigger.';

-- The seals a link between these ends takes (either may be null: a person or a company at that end).
create or replace function private.relationship_seal(p_a uuid, p_b uuid)
returns table (seal_scope text, seal_open boolean, seal_viewer_ids uuid[], seal_all text, sync_window boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a record;
  v_b record;
begin
  select r.seal_scope, r.seal_open, r.seal_viewer_ids, r.seal_all, r.sync_window into v_a
  from app.custom_records r where r.id = p_a;
  select r.seal_scope, r.seal_open, r.seal_viewer_ids, r.seal_all, r.sync_window into v_b
  from app.custom_records r where r.id = p_b;
  -- One record: its own.
  if p_b is null or p_a is null then
    if p_a is null then v_a := v_b; end if;
    if v_a.seal_scope is null then
      return query select null::text, false, '{}'::uuid[], null::text, true;
    else
      return query select v_a.seal_scope, v_a.seal_open, v_a.seal_viewer_ids, v_a.seal_all, v_a.sync_window;
    end if;
    return;
  end if;
  if v_a.seal_scope is null or v_b.seal_scope is distinct from v_a.seal_scope then
    return query select null::text, false, '{}'::uuid[], null::text, true;
    return;
  end if;
  return query select
    v_a.seal_scope,
    v_a.seal_open and v_b.seal_open,
    case when v_a.seal_open and v_b.seal_open then '{}'::uuid[]
         when v_a.seal_open then v_b.seal_viewer_ids
         when v_b.seal_open then v_a.seal_viewer_ids
         else coalesce((select array_agg(u order by u) from unnest(v_a.seal_viewer_ids) u
                        where u = any (v_b.seal_viewer_ids)), '{}') end,
    case when v_a.seal_open and v_b.seal_open then null
         when v_a.seal_open then v_b.seal_all
         when v_b.seal_open then v_a.seal_all
         when v_a.seal_all = v_b.seal_all then v_a.seal_all end,
    v_a.sync_window and v_b.sync_window;
end $$;

create or replace function private.keep_relationship_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select s.seal_scope, s.seal_open, s.seal_viewer_ids, s.seal_all, s.sync_window
  into new.seal_scope, new.seal_open, new.seal_viewer_ids, new.seal_all, new.sync_window
  from private.relationship_seal(new.a_custom_record_id, new.b_custom_record_id) s;
  return new;
end $$;

create trigger relationships_seal
  before insert or update of seal_scope, seal_open, seal_viewer_ids, seal_all, sync_window on app.relationships
  for each row execute function private.keep_relationship_seal();

-- A kind of link: its add-on's key, or the key of a kind phones keep at either end.
create or replace function private.relationship_type_seal(
  p_ws uuid, p_addon text, p_a_kind uuid, p_b_kind uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_ws::text || ':' || private.addon_phone_permission(p_addon),
    (select t.seal_scope from app.custom_record_types t where t.id = p_a_kind),
    (select t.seal_scope from app.custom_record_types t where t.id = p_b_kind))
$$;

create or replace function private.keep_relationship_type_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.seal_scope := private.relationship_type_seal(new.workspace_id, new.addon_id, new.a_record_type_id,
    new.b_record_type_id);
  return new;
end $$;

create trigger relationship_types_seal before insert or update of addon_id, seal_scope on app.relationship_types
  for each row execute function private.keep_relationship_type_seal();

-- 20261022000100's, with links: a record's seals or window moving, its links follow.
create or replace function private.record_seal_followers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.tasks x set seal_scope = new.seal_scope where x.custom_record_id = new.id and x.sealed;
  update app.activities x set seal_scope = new.seal_scope where x.custom_record_id = new.id and x.sealed;
  update app.files x set seal_scope = new.seal_scope
  where x.record_type = 'custom_record' and x.record_id = new.id and x.sealed;
  update app.appointments x set seal_scope = new.seal_scope where x.custom_record_id = new.id and x.sealed;
  update app.conversations x set seal_scope = new.seal_scope where x.custom_record_id = new.id and x.sealed;
  update app.attention_items x set seal_scope = new.seal_scope where x.custom_record_id = new.id;
  update app.relationships x set seal_scope = x.seal_scope
  where x.a_custom_record_id = new.id or x.b_custom_record_id = new.id;
  perform private.addon_phone_reseal(new.id);
  return null;
end $$;

-- 20261022000100's, with links: naming an add-on phones keep seals its kinds of link and its links too.
create or replace function private.addon_phone_addon(p_addon text, p_permission text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into app.addon_phone_addons (addon_id, permission) values (p_addon, p_permission)
  on conflict (addon_id) do update set permission = excluded.permission;
  -- Its kinds and records take their seals, and its people their keys.
  update app.custom_record_types t set seal_scope = t.seal_scope where t.addon_id = p_addon;
  update app.custom_records r set seal_scope = r.seal_scope
  where r.type_id in (select t.id from app.custom_record_types t where t.addon_id = p_addon);
  update app.relationship_types t set seal_scope = t.seal_scope
  where t.addon_id = p_addon
     or t.a_record_type_id in (select k.id from app.custom_record_types k where k.addon_id = p_addon)
     or t.b_record_type_id in (select k.id from app.custom_record_types k where k.addon_id = p_addon);
  update app.attention_items x set seal_scope = x.seal_scope
  where x.kind = 'addon_alert' and x.subject_id in (select a.id from app.addon_alerts a where a.addon_id = p_addon);
  perform private.sync_keys_refresh_workspace(i.workspace_id)
  from app.addon_installations i where i.addon_id = p_addon;
end $$;
revoke all on function private.addon_phone_addon(text, text) from public;

-- What's there now.
update app.relationship_types t set seal_scope = t.seal_scope;
update app.relationships x set seal_scope = x.seal_scope
where x.a_custom_record_id is not null or x.b_custom_record_id is not null;

-- The seal checks, with links: 20261022000100's, renamed, and these beside it.
alter function private.sync_seal_mismatches(uuid) rename to sync_record_seal_mismatches;

create or replace function private.sync_seal_mismatches(p_ws uuid default null)
returns table (table_name text, id uuid, problem text) language sql stable security definer set search_path = '' as $$
  select * from private.sync_record_seal_mismatches(p_ws)
  union all
  select 'relationships', x.id, 'link' from app.relationships x
  cross join lateral private.relationship_seal(x.a_custom_record_id, x.b_custom_record_id) s
  where (p_ws is null or x.workspace_id = p_ws)
    and (x.seal_scope is distinct from s.seal_scope or x.seal_open is distinct from s.seal_open
         or x.seal_viewer_ids is distinct from s.seal_viewer_ids or x.seal_all is distinct from s.seal_all
         or x.sync_window is distinct from s.sync_window)
  union all
  select 'relationship_types', t.id, 'kind of link' from app.relationship_types t
  where (p_ws is null or t.workspace_id = p_ws)
    and t.seal_scope is distinct from private.relationship_type_seal(t.workspace_id, t.addon_id, t.a_record_type_id,
      t.b_record_type_id)
$$;

grant execute on function private.sync_seal_mismatches(uuid) to service_actor;

-- PowerSync reads both; their seal columns decide who gets what and never leave for a phone.
grant select on app.relationships, app.relationship_types to hfos_sync;
alter publication powersync add table app.relationships, app.relationship_types;

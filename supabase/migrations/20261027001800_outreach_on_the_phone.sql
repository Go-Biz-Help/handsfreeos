-- =============================================================================
-- Social Outreach (outreach) on the phone (docs/outreach.md, decision 44;
-- owner answers 14, 17b, 18a, 19b and 20b, 10 Oct 2026).
--
--        The whole add-on is on the phone, under More, and Waiting for you's
--        messages work with no signal: each person's messages waiting for
--        their OK are kept on their phone, theirs alone, and OK, change, skip
--        and Approve all wait there until it's back online.
--
--        Core (extends 20261022000100 and 20261022000800). Until now an
--        add-on's row on a phone either followed a record (a deal's people)
--        or was open to everyone holding the add-on's key. A person's own
--        rows are a third kind: app.addon_phone_tables names the column
--        saying whose each row is (`owner_column`), and which rows a phone
--        keeps at all (`keep_column` in `keep_values`: `state` 'waiting').
--        Each such row is sealed to that person (seal_open false, only them
--        in seal_viewer_ids), which records_v1's narrow arm already sends
--        and nothing else does, so the sync config doesn't change and no
--        phone copies everything again. A row that leaves the kept states, or
--        names nobody, leaves the phone. private.addon_phone_own_table()
--        registers the owner and what's kept before anything is copied, so
--        no row is ever written open, even for a moment. Row security on
--        app.addon_phone_rows says the same: a person's own row reads only
--        to them. Rows of tables without an owner are written exactly as
--        before.
--
--        Social Outreach: `sends` keeps who each message is to (the profile's
--        name and link), by triggers, so a phone shows it with no profiles;
--        open messages follow a rename. Then its waiting messages go to their
--        person's phone.
--
-- Only adds: no function or column is dropped. addon_phone_upsert and
-- addon_phone_table_mismatches are replaced with the same arguments, and the
-- row-security policy is altered in place. The phone-row helpers, which work
-- on every business's rows, are taken from everyone but their owner.
-- =============================================================================

-- ---------- core: an add-on's rows kept to one person ----------
alter table app.addon_phone_tables
  -- The column naming the person each row is for ('user_id'); null: the rows follow a record or are the business's.
  add column owner_column name,
  -- A phone keeps a row only while this column's value is one of keep_values ('state' in {'waiting'}); null: every row.
  add column keep_column name,
  add column keep_values text[],
  add constraint addon_phone_tables_keep_pair
    check ((keep_column is null) = (keep_values is null) and (keep_values is null or cardinality(keep_values) > 0)),
  add constraint addon_phone_tables_owner_or_record
    check (owner_column is null or (record_column is null and reach = 'team'));
comment on column app.addon_phone_tables.owner_column is
  'A person''s own rows (Social Outreach''s messages waiting, 20261027001800): each goes to that person''s phone alone.';
comment on column app.addon_phone_tables.keep_column is
  'Phones keep only rows whose keep_column is one of keep_values (20261027001800); the rest leave them.';

-- The seals of a person's own row: their add-on's key, never open, only them. Nobody named, no seal.
create function private.addon_phone_own_seal(p_ws uuid, p_addon text, p_owner uuid)
returns table (seal_scope text, seal_open boolean, seal_viewer_ids uuid[], seal_all text, sync_window boolean)
language sql stable security definer set search_path = '' as $$
  select p_ws::text || ':' || private.addon_phone_permission(p_addon), false, array[p_owner], null::text, true
  where p_owner is not null
$$;

-- Whether a phone keeps a row of a table at all: in the kept states, and naming its person when it has an owner.
create function private.addon_phone_kept(t app.addon_phone_tables, j jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (t.keep_column is null or (j ->> t.keep_column::text) = any (t.keep_values))
     and (t.owner_column is null or (j ->> t.owner_column::text) is not null)
$$;

-- 20261022000100's, with a person's own rows: those a phone no longer keeps leave it, and each kept one takes its
-- person's seal. A table without an owner or kept states writes exactly the rows it did.
create or replace function private.addon_phone_upsert(
  p_addon text, p_source text, p_record text, p_reach text, p_rows jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t app.addon_phone_tables;
begin
  select * into t from app.addon_phone_tables x where x.addon_id = p_addon and x.source = p_source;
  if not found then
    return;
  end if;
  if t.keep_column is not null or t.owner_column is not null then
    delete from app.addon_phone_rows p
    where p.id in (select p_source || ':' || (x.j ->> t.key_column::text)
                   from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x(j)
                   where not private.addon_phone_kept(t, x.j));
  end if;
  insert into app.addon_phone_rows as p (id, workspace_id, addon_id, source, record_id, data, reach,
    seal_scope, seal_open, seal_viewer_ids, seal_all, sync_window, updated_at)
  select p_source || ':' || (x.j ->> t.key_column::text), (x.j ->> 'workspace_id')::uuid, p_addon, p_source, r.rec,
         dd.d, p_reach, s.seal_scope, coalesce(s.seal_open, false), coalesce(s.seal_viewer_ids, '{}'), s.seal_all,
         coalesce(s.sync_window, true), now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x(j)
  cross join lateral (
    select case when p_record is null then null else (x.j ->> p_record)::uuid end as rec,
           case when t.owner_column is null then null else (x.j ->> t.owner_column::text)::uuid end as own
  ) r
  cross join lateral (
    select coalesce(jsonb_object_agg(c, x.j -> c), '{}'::jsonb) as d from unnest(t.columns) c
  ) dd
  left join lateral (
    select * from private.addon_phone_seal((x.j ->> 'workspace_id')::uuid, p_addon, r.rec, p_reach)
    where t.owner_column is null
    union all
    select * from private.addon_phone_own_seal((x.j ->> 'workspace_id')::uuid, p_addon, r.own)
    where t.owner_column is not null
  ) s on true
  where private.addon_phone_kept(t, x.j)
  on conflict (id) do update set
    data = excluded.data, record_id = excluded.record_id, seal_scope = excluded.seal_scope,
    seal_open = excluded.seal_open, seal_viewer_ids = excluded.seal_viewer_ids, seal_all = excluded.seal_all,
    sync_window = excluded.sync_window, updated_at = excluded.updated_at
  where p.data is distinct from excluded.data or p.record_id is distinct from excluded.record_id
     or p.seal_scope is distinct from excluded.seal_scope or p.seal_open is distinct from excluded.seal_open
     or p.seal_viewer_ids is distinct from excluded.seal_viewer_ids or p.seal_all is distinct from excluded.seal_all
     or p.sync_window is distinct from excluded.sync_window;
end $$;

-- Names one of an add-on's tables whose rows are each a person's own: the column naming them, and which rows a phone
-- keeps. Its person and kept states are written down first, then private.addon_phone_table() checks it, installs the
-- copying triggers and copies what's there, so the first copy is already sealed to each person. Calling
-- addon_phone_table() on it again later keeps its person and kept states.
create function private.addon_phone_own_table(
  p_table regclass, p_owner_column name, p_columns text[], p_keep_column name default null,
  p_keep_values text[] default null, p_key_column name default 'id')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_addon text;
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_schema !~ '^addon_[a-z]{2,16}$' then
    raise exception '% is not in an add-on''s schema', p_table using errcode = '23514';
  end if;
  v_addon := substr(v_schema, 7);
  if private.addon_phone_permission(v_addon) is null then
    raise exception 'Name the add-on first with private.addon_phone_addon()' using errcode = '23514';
  end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = p_table and a.attname = p_owner_column
                 and a.attnum > 0 and not a.attisdropped and a.atttypid = 'uuid'::regtype) then
    raise exception '% has no uuid column % to name whose each row is', p_table, p_owner_column
      using errcode = '23514';
  end if;
  if not (p_owner_column::text = any (p_columns)) then
    raise exception 'A phone keeps the column naming whose each row is (%)', p_owner_column using errcode = '23514';
  end if;
  if (p_keep_column is null) <> (p_keep_values is null) or coalesce(cardinality(p_keep_values), 1) = 0 then
    raise exception 'Name the column and the values a phone keeps rows by, or neither' using errcode = '23514';
  end if;
  if p_keep_column is not null and not (p_keep_column::text = any (p_columns)) then
    raise exception 'A phone keeps the column it keeps rows by (%)', p_keep_column using errcode = '23514';
  end if;
  insert into app.addon_phone_tables (addon_id, source, key_column, record_column, columns, reach, owner_column,
    keep_column, keep_values)
  values (v_addon, v_name, p_key_column, null, p_columns, 'team', p_owner_column, p_keep_column, p_keep_values)
  on conflict (addon_id, source) do update
    set key_column = excluded.key_column, record_column = null, columns = excluded.columns, reach = 'team',
        owner_column = excluded.owner_column, keep_column = excluded.keep_column, keep_values = excluded.keep_values;
  perform private.addon_phone_table(p_table, null, p_columns, 'team', p_key_column);
end $$;
revoke all on function private.addon_phone_own_table(regclass, name, text[], name, text[], name) from public;

-- 20261022000800's table check, with a person's own rows: only the kept rows are wanted, each with its person's
-- seal, and a row that left the kept states is left over.
create or replace function private.addon_phone_table_mismatches(p_ws uuid default null)
returns table (id text, problem text) language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
begin
  for v in select * from app.addon_phone_tables loop
    return query execute format($q$
      with want as (
        select %1$L || ':' || (s.j ->> %8$L) as id, (s.j ->> 'workspace_id')::uuid as ws, r.rec, r.own,
               (select coalesce(jsonb_object_agg(c, s.j -> c), '{}'::jsonb) from unnest(%2$L::text[]) c) as data
        from (select to_jsonb(x) as j from %3$I.%4$I x where %9$L::uuid is null or x.workspace_id = %9$L::uuid) s
        cross join lateral (
          select case when %5$L = '' then null else (s.j ->> %5$L)::uuid end as rec,
                 case when %10$L = '' then null else (s.j ->> %10$L)::uuid end as own
        ) r
        where (%11$L = '' or (s.j ->> %11$L) = any (%12$L::text[]))
          and (%10$L = '' or (s.j ->> %10$L) is not null)
      )
      select w.id, 'missing or stale' from want w
      left join lateral (
        select * from private.addon_phone_seal(w.ws, %6$L, w.rec, %7$L) where %10$L = ''
        union all
        select * from private.addon_phone_own_seal(w.ws, %6$L, w.own) where %10$L <> ''
      ) s on true
      where not exists (
        select 1 from app.addon_phone_rows p
        where p.id = w.id and p.data = w.data and p.record_id is not distinct from w.rec
          and p.seal_scope is not distinct from s.seal_scope and p.seal_open = coalesce(s.seal_open, false)
          and p.seal_viewer_ids = coalesce(s.seal_viewer_ids, '{}') and p.seal_all is not distinct from s.seal_all
          and p.sync_window = coalesce(s.sync_window, true))
      union all
      select p.id, 'left over' from app.addon_phone_rows p
      where p.addon_id = %6$L and p.source = %1$L and (%9$L::uuid is null or p.workspace_id = %9$L::uuid)
        and not exists (select 1 from want w where w.id = p.id)
    $q$, v.source, v.columns, 'addon_' || v.addon_id, v.source, coalesce(v.record_column::text, ''), v.addon_id, v.reach,
      v.key_column, p_ws, coalesce(v.owner_column::text, ''), coalesce(v.keep_column::text, ''),
      coalesce(v.keep_values, '{}'::text[]));
  end loop;
  return query select p.id, 'not a table phones keep' from app.addon_phone_rows p
    where (p_ws is null or p.workspace_id = p_ws)
      and not exists (select 1 from app.addon_phone_tables t where t.addon_id = p.addon_id and t.source = p.source);
end $$;

-- Only their owner runs these: the copying triggers and the checks above call them as it. Each one writes or reads
-- any business's phone rows, so nobody signed in may call them, including the ones 20261022000100 and 000800 left
-- to everyone (the mismatch check stays with the worker's tests through service_actor).
revoke all on function private.addon_phone_upsert(text, text, text, text, jsonb) from public;
revoke all on function private.addon_phone_own_seal(uuid, text, uuid) from public;
revoke all on function private.addon_phone_kept(app.addon_phone_tables, jsonb) from public;
revoke all on function private.addon_phone_seal(uuid, text, uuid, text) from public;
revoke all on function private.addon_phone_reseal(uuid) from public;
revoke all on function private.addon_phone_settings_row(uuid, text) from public;
revoke all on function private.addon_phone_table_mismatches(uuid) from public;
revoke all on function private.addon_phone_mismatches(uuid) from public;
grant execute on function private.addon_phone_mismatches(uuid) to service_actor;

-- Row security: a person's own row reads only to them. The business's rows are open and a record's keep their rule,
-- so nothing anyone could read before changes.
alter policy addon_phone_rows_select on app.addon_phone_rows
  using (workspace_id in (select private.accessible_workspace_ids())
         and private.addon_in_use(workspace_id, addon_id, false)
         and private.has_permission(workspace_id, private.addon_phone_permission(addon_id))
         and (record_id is null or not (record_id in (select private.unseen_private_records())))
         and (seal_open or record_id is not null or (select auth.uid()) = any (seal_viewer_ids)));

-- ---------- Social Outreach: who each message is to, kept on it ----------
alter table addon_outreach.sends
  add column name text,
  add column profile_url text;
comment on column addon_outreach.sends.name is
  'Who it''s to, as their profile says, and (profile_url) its link: kept by triggers so phones show it (20261027001800).';

create function addon_outreach.send_to()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select p.name, p.url into new.name, new.profile_url
  from addon_outreach.profiles p where p.workspace_id = new.workspace_id and p.id = new.profile_id;
  return new;
end $$;
revoke all on function addon_outreach.send_to() from public;
create trigger sends_to before insert or update of profile_id on addon_outreach.sends
  for each row execute function addon_outreach.send_to();

-- A profile renamed, or its link changed: the open messages to them follow, and so do the phones' rows.
create function addon_outreach.profile_sends()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update addon_outreach.sends s set name = new.name, profile_url = new.url
  where s.workspace_id = new.workspace_id and s.profile_id = new.id and s.state in ('waiting', 'approved')
    and (s.name is distinct from new.name or s.profile_url is distinct from new.url);
  return null;
end $$;
revoke all on function addon_outreach.profile_sends() from public;
create trigger profiles_sends after update of name, url on addon_outreach.profiles
  for each row when (old.name is distinct from new.name or old.url is distinct from new.url)
  execute function addon_outreach.profile_sends();

-- The open ones only: phones never keep the rest, and the web reads names from profiles. Filling them in isn't a
-- change anyone made, so updated_at keeps its value here. A rename later does move it (and re-sends the row to the
-- phone), which is what a phone needs to show the new name.
alter table addon_outreach.sends disable trigger sends_updated_at;
update addon_outreach.sends s set name = p.name, profile_url = p.url
from addon_outreach.profiles p
where p.workspace_id = s.workspace_id and p.id = s.profile_id and s.state in ('waiting', 'approved');
alter table addon_outreach.sends enable trigger sends_updated_at;

-- ---------- what phones keep of Social Outreach ----------
-- Each person's messages waiting for their OK, theirs alone (its manifest's `offline` says the same).
select private.addon_phone_addon('outreach', 'outreach.use');
select private.addon_phone_own_table('addon_outreach.sends', 'user_id',
  array['user_id', 'profile_id', 'kind', 'thread_key', 'text', 'state', 'handed_over', 'needs_you', 'name',
        'profile_url', 'created_at', 'updated_at'],
  'state', array['waiting']);

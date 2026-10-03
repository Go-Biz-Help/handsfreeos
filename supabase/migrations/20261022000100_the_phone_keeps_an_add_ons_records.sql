-- =============================================================================
-- The phone keeps an add-on's records (Real Estate round six, steps 2 and 3;
-- core).
--
--        Chris decided (2026-10-03) that deals work on the phone with no
--        signal: an agent's own deals in full, and for anyone who sees every
--        deal, every other deal's summary, duties and dates. Until now no
--        phone held a custom record, an add-on's row, or anything sealed to a
--        private record (20261013002400 took those off phones).
--
--        A sync stream can't ask row security, so who may keep what is
--        written down where a stream can read it, kept by triggers, and held
--        to the policies by mismatch functions the tests call:
--
--        **Keys** (app.sync_keys). One row per person, business and key, for
--        the add-ons a phone keeps: `use` for the add-on's own read permission
--        (the one its manifest's `offline` names), `all` for a private kind's
--        See-every permission. Kept from app.workspace_access.permissions, which drops an
--        add-on's permissions while it's off; so turning an add-on off takes
--        its keys away and every phone drops its rows, with nothing deleted.
--
--        **Seals** on each row a phone may get about a record:
--          seal_scope       '<business>:<permission>' a key must match;
--          seal_open        anyone holding that key may have it (a shared
--                           record, or a Home card for everyone);
--          seal_viewer_ids  otherwise, exactly who: a private record's main
--                           person and team (a thread narrowed further by the
--                           inbox's own rule, a Home card by its audience);
--          seal_all         on a private record and an add-on's `all` rows:
--                           '<business>:<See-every permission>'.
--        Who holds See every deal is never written on rows, so giving or
--        taking it changes one key, not every deal. A deal's team changing
--        rewrites that deal's rows only.
--
--        **An add-on's own rows** reach a phone through one core table,
--        app.addon_phone_rows: the add-on names the tables and columns a phone
--        keeps (its manifest's `offline`), private.addon_phone_table() checks
--        them and installs triggers that copy just those columns, as JSON,
--        with the seals of the record each row follows. Core's sync config
--        never names an add-on's table, and what a phone keeps can change
--        later by migration, never by a sync-config change.
--
--        Nothing here sends anything yet: the stream that reads all this,
--        records_v1, comes with the one batched sync change (step 6).
-- =============================================================================

-- ---------- which add-ons a phone keeps, and what of each ----------
create table app.addon_phone_addons (
  addon_id text primary key check (addon_id ~ '^[a-z]{2,16}$'),
  -- What a person needs before their phone keeps any of it: the add-on's own read permission.
  permission text not null check (permission like addon_id || '.%'),
  created_at timestamptz not null default now()
);
comment on table app.addon_phone_addons is
  'The add-ons phones keep offline and the permission each asks first (Real Estate round six). Written by migrations through private.addon_phone_addon().';

create table app.addon_phone_tables (
  addon_id text not null references app.addon_phone_addons (addon_id) on delete cascade,
  -- The table's name in its add-on's schema, as the phone knows it ('duties').
  source text not null check (source ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- The column naming the row on the phone ('id', or the deal for a table with one row per deal).
  key_column name not null default 'id',
  -- The column naming the record each row follows (a deal); null for the business's own rows (its vendors).
  record_column name,
  columns text[] not null check (cardinality(columns) between 1 and 80),
  -- 'team': only the people on the record. 'all': also whoever sees every record of its kind.
  reach text not null check (reach in ('team', 'all')),
  created_at timestamptz not null default now(),
  primary key (addon_id, source)
);
comment on table app.addon_phone_tables is
  'Each add-on table a phone keeps: its columns, the record it follows and who beyond the record''s people gets it (Real Estate round six). The add-on''s manifest `offline` says the same; a test holds them equal.';

alter table app.addon_phone_addons enable row level security;
alter table app.addon_phone_tables enable row level security;
-- Read by the worker and the tests; written only by migrations.
create policy addon_phone_addons_read on app.addon_phone_addons for select to authenticated, service_actor using (true);
create policy addon_phone_tables_read on app.addon_phone_tables for select to authenticated, service_actor using (true);
grant select on app.addon_phone_addons, app.addon_phone_tables to authenticated, service_actor;
revoke all on app.addon_phone_addons, app.addon_phone_tables from anon;

-- The permission a phone asks first for an add-on, or null when phones keep none of it.
create or replace function private.addon_phone_permission(p_addon text)
returns text language sql stable security definer set search_path = '' as $$
  select a.permission from app.addon_phone_addons a where a.addon_id = p_addon
$$;

-- ---------- keys ----------
create table app.sync_keys (
  user_id uuid not null references app.users (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null check (kind in ('use', 'all')),
  -- '<business>:<permission>', the value a row's seal_scope or seal_all must equal.
  key text not null,
  primary key (user_id, workspace_id, kind, key)
);
create index sync_keys_workspace_idx on app.sync_keys (workspace_id);
comment on table app.sync_keys is
  'What a person''s phone may keep of the add-ons phones keep offline, as keys a sync stream can compare (Real Estate round six). Kept from workspace_access.permissions by triggers; private.sync_key_mismatches() holds it equal.';
alter table app.sync_keys enable row level security;
-- PowerSync reads it past RLS; a person may read their own (the sync tests run each lookup as them).
create policy sync_keys_own on app.sync_keys for select to authenticated using (user_id = (select auth.uid()));
grant select on app.sync_keys to authenticated;
revoke all on app.sync_keys from anon;

-- What a person's keys should be in one business, from their stored permissions.
create or replace function private.sync_keys_wanted(p_user uuid, p_ws uuid)
returns table (kind text, key text) language sql stable security definer set search_path = '' as $$
  select 'use', p_ws::text || ':' || a.permission
  from app.workspace_access wa, app.addon_phone_addons a
  where wa.user_id = p_user and wa.workspace_id = p_ws and a.permission = any (wa.permissions)
  union
  select 'all', p_ws::text || ':' || t.see_all_permission
  from app.workspace_access wa
  join app.custom_record_types t on t.workspace_id = wa.workspace_id
  where wa.user_id = p_user and wa.workspace_id = p_ws
    and t.kept_to_team and t.see_all_permission = any (wa.permissions)
    and t.addon_id in (select a.addon_id from app.addon_phone_addons a)
$$;

-- Writes one person's keys in one business; only what changed.
create or replace function private.sync_keys_refresh(p_user uuid, p_ws uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from app.sync_keys k
  where k.user_id = p_user and k.workspace_id = p_ws
    and (k.kind, k.key) not in (select w.kind, w.key from private.sync_keys_wanted(p_user, p_ws) w);
  insert into app.sync_keys (user_id, workspace_id, kind, key)
  select p_user, p_ws, w.kind, w.key from private.sync_keys_wanted(p_user, p_ws) w
  on conflict do nothing;
end $$;

-- Everyone's keys in one business (or every business): when a phone starts keeping an add-on, or a private kind
-- is made.
create or replace function private.sync_keys_refresh_workspace(p_ws uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.sync_keys_refresh(wa.user_id, wa.workspace_id)
  from app.workspace_access wa
  where p_ws is null or wa.workspace_id = p_ws;
  -- Someone who no longer opens the business keeps nothing of it (their access row is gone).
  delete from app.sync_keys k
  where (p_ws is null or k.workspace_id = p_ws)
    and not exists (select 1 from app.workspace_access wa where wa.user_id = k.user_id and wa.workspace_id = k.workspace_id);
end $$;

create or replace function private.sync_keys_follow_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  if tg_op = 'DELETE' then
    delete from app.sync_keys k where k.user_id = old.user_id and k.workspace_id = old.workspace_id;
  else
    perform private.sync_keys_refresh(new.user_id, new.workspace_id);
  end if;
  -- Open Home cards under one of an add-on's other permissions list who holds it: they follow.
  update app.attention_items i set seal_scope = i.seal_scope
  where i.workspace_id = v_ws and i.kind = 'addon_alert' and i.state <> 'resolved'
    and i.subject_id in (select a.id from app.addon_alerts a
                         join app.addon_phone_addons pa on pa.addon_id = a.addon_id
                         where a.workspace_id = v_ws and a.permission <> pa.permission and a.cleared_at is null);
  return null;
end $$;

create trigger workspace_access_sync_keys
  after insert or delete or update of permissions on app.workspace_access
  for each row execute function private.sync_keys_follow_access();

-- A private kind made after its add-on's people already hold its See-every permission (the worker seeds kinds on
-- install): their `all` key appears with it.
create or replace function private.sync_keys_follow_kind()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kept_to_team then
    perform private.sync_keys_refresh_workspace(new.workspace_id);
  end if;
  return null;
end $$;

create trigger custom_record_types_sync_keys after insert on app.custom_record_types
  for each row when (new.kept_to_team) execute function private.sync_keys_follow_kind();

-- The keys the stored permissions say, and the ones written, that differ. Empty when they agree (the tests).
create or replace function private.sync_key_mismatches(p_ws uuid default null)
returns table (user_id uuid, workspace_id uuid, kind text, key text, problem text)
language sql stable security definer set search_path = '' as $$
  with wanted as (
    select wa.user_id, wa.workspace_id, w.kind, w.key
    from app.workspace_access wa, private.sync_keys_wanted(wa.user_id, wa.workspace_id) w
    where p_ws is null or wa.workspace_id = p_ws
  )
  select w.user_id, w.workspace_id, w.kind, w.key, 'missing' from wanted w
  where not exists (select 1 from app.sync_keys k where (k.user_id, k.workspace_id, k.kind, k.key)
                    = (w.user_id, w.workspace_id, w.kind, w.key))
  union all
  select k.user_id, k.workspace_id, k.kind, k.key, 'extra' from app.sync_keys k
  where (p_ws is null or k.workspace_id = p_ws)
    and not exists (select 1 from wanted w where (k.user_id, k.workspace_id, k.kind, k.key)
                    = (w.user_id, w.workspace_id, w.kind, w.key))
$$;

-- ---------- seals on records and their kinds ----------
alter table app.custom_record_types add column seal_scope text;
comment on column app.custom_record_types.seal_scope is
  'For a kind phones keep: ''<business>:<permission>'' a sync key must match (Real Estate round six). Kept by a trigger.';

alter table app.custom_records
  add column seal_scope text,
  add column seal_open boolean not null default false,
  add column seal_viewer_ids uuid[] not null default '{}',
  add column seal_all text,
  -- Whether a phone keeps this record now (an add-on narrows it, e.g. deals ended long ago): its rows follow.
  add column sync_window boolean not null default true;
comment on column app.custom_records.seal_scope is
  'For a record of a kind phones keep: ''<business>:<permission>'' a sync key must match. Kept by a trigger (Real Estate round six).';
comment on column app.custom_records.seal_open is
  'Anyone holding the seal_scope key may keep it on their phone (a shared record). Kept by a trigger.';
comment on column app.custom_records.seal_viewer_ids is
  'A private record''s main person and team: who keeps it on their phone besides See-every holders. Kept by a trigger.';
comment on column app.custom_records.seal_all is
  'A private record''s ''<business>:<See-every permission>'': the key whoever sees every record of its kind holds.';
comment on column app.custom_records.sync_window is
  'Whether phones keep it now; the add-on narrows it (private.record_phone_window). Its add-on rows follow.';

create or replace function private.keep_kind_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_perm text := private.addon_phone_permission(new.addon_id);
begin
  new.seal_scope := case when v_perm is not null then new.workspace_id::text || ':' || v_perm end;
  return new;
end $$;

create trigger custom_record_types_seal before insert or update of addon_id, seal_scope on app.custom_record_types
  for each row execute function private.keep_kind_seal();

-- A record's seals, from its kind and who is on it. Runs after custom_records_team has tidied the team.
create or replace function private.keep_record_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind record;
  v_perm text;
begin
  select t.addon_id, t.see_all_permission into v_kind from app.custom_record_types t where t.id = new.type_id;
  v_perm := private.addon_phone_permission(v_kind.addon_id);
  if v_perm is null then
    new.seal_scope := null;
    new.seal_open := false;
    new.seal_viewer_ids := '{}';
    new.seal_all := null;
  elsif new.kept_to_team then
    new.seal_scope := new.workspace_id::text || ':' || v_perm;
    new.seal_open := false;
    new.seal_viewer_ids := coalesce(
      (select array_agg(distinct u order by u) from unnest(array_append(new.team_user_ids, new.owner_user_id)) u
       where u is not null),
      '{}');
    new.seal_all := new.workspace_id::text || ':' || v_kind.see_all_permission;
  else
    new.seal_scope := new.workspace_id::text || ':' || v_perm;
    new.seal_open := true;
    new.seal_viewer_ids := '{}';
    new.seal_all := null;
  end if;
  return new;
end $$;

-- Named to sort after custom_records_team, so it reads the team that trigger tidied.
create trigger custom_records_team_seal
  before insert or update of type_id, owner_user_id, team_user_ids, kept_to_team, seal_scope, seal_open,
    seal_viewer_ids, seal_all on app.custom_records
  for each row execute function private.keep_record_seal();

-- ---------- seals on what hangs off a record ----------
alter table app.tasks add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.activities add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.files add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.appointments add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.appointment_attendees add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.conversations add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
alter table app.messages add column seal_scope text, add column seal_viewer_ids uuid[] not null default '{}';
-- A system line keeps what it says; who may see it on a phone follows its record (20261013002700's guard, with the
-- two columns above beside sync_window).
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace(old.workspace_id) then
    return old;
  end if;
  if old.kind = 'system' then
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids']) then
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

alter table app.attention_items
  add column seal_scope text,
  add column seal_open boolean not null default false,
  add column seal_viewer_ids uuid[] not null default '{}';

comment on column app.tasks.seal_scope is
  'Sealed to a private record phones keep: its record''s seal_scope (Real Estate round six). Kept by a trigger.';
comment on column app.tasks.seal_viewer_ids is
  'Sealed: the people on its record, who keep it on their phones. Kept by a trigger.';
comment on column app.conversations.seal_viewer_ids is
  'Sealed: the people on its record who may also read it by the inbox''s own rule. Kept by a trigger.';
comment on column app.attention_items.seal_open is
  'An add-on''s Home card for everyone holding its permission (no audience, no private record). Kept by a trigger.';

-- A sealed row's seals from its record (when phones keep that record's kind), or none.
create or replace function private.record_seal(p_record uuid)
returns table (seal_scope text, seal_viewer_ids uuid[]) language sql stable security definer set search_path = '' as $$
  select r.seal_scope, r.seal_viewer_ids from app.custom_records r
  where r.id = p_record and r.kept_to_team and r.seal_scope is not null
$$;

-- The same as 20261013002400's, with the seals.
create or replace function private.keep_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_record uuid;
  v_seal record;
begin
  if tg_table_name = 'files' then
    v_record := case when new.record_type = 'custom_record' then new.record_id end;
  else
    v_record := new.custom_record_id;
  end if;
  new.sealed := v_record is not null and private.record_is_private(v_record);
  select s.seal_scope, s.seal_viewer_ids into v_seal from private.record_seal(v_record) s where new.sealed;
  new.seal_scope := v_seal.seal_scope;
  new.seal_viewer_ids := coalesce(v_seal.seal_viewer_ids, '{}');
  return new;
end $$;

-- The triggers that call it also fire when the seals are written, so a record's change reaches them by touching
-- `sealed`.
drop trigger activities_sealed on app.activities;
create trigger activities_sealed before insert or update of custom_record_id, sealed, seal_scope, seal_viewer_ids
  on app.activities for each row execute function private.keep_sealed();
drop trigger tasks_sealed on app.tasks;
create trigger tasks_sealed before insert or update of custom_record_id, sealed, seal_scope, seal_viewer_ids
  on app.tasks for each row execute function private.keep_sealed();
drop trigger files_sealed on app.files;
create trigger files_sealed before insert or update of record_id, record_type, sealed, seal_scope, seal_viewer_ids
  on app.files for each row execute function private.keep_sealed();
drop trigger appointments_sealed on app.appointments;
create trigger appointments_sealed before insert or update of custom_record_id, sealed, seal_scope, seal_viewer_ids
  on app.appointments for each row execute function private.keep_sealed();
drop trigger conversations_sealed on app.conversations;
create trigger conversations_sealed before insert or update of custom_record_id, sealed, seal_scope, seal_viewer_ids,
  member_viewer_ids on app.conversations for each row execute function private.keep_sealed();

-- A thread is read by the people on its record who may also read it by the inbox's rule: everyone, until the
-- business narrows its inbox (0083), then only those on its member_viewer_ids. Sorts after conversations_sealed.
create or replace function private.keep_conversation_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.sealed and private.inbox_narrowed(new.workspace_id) then
    new.seal_viewer_ids := coalesce(
      (select array_agg(u) from unnest(new.seal_viewer_ids) u where u = any (new.member_viewer_ids)), '{}');
  end if;
  return new;
end $$;

create trigger conversations_sealed_inbox
  before insert or update of custom_record_id, sealed, seal_scope, seal_viewer_ids, member_viewer_ids
  on app.conversations for each row execute function private.keep_conversation_seal();

-- A message, an attendee: their thread's, their appointment's.
create or replace function private.keep_message_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select c.seal_scope, coalesce(c.seal_viewer_ids, '{}') into new.seal_scope, new.seal_viewer_ids
  from app.conversations c where c.id = new.conversation_id;
  new.seal_viewer_ids := coalesce(new.seal_viewer_ids, '{}');
  return new;
end $$;

create trigger messages_seal before insert or update of conversation_id, seal_scope, seal_viewer_ids
  on app.messages for each row execute function private.keep_message_seal();

create or replace function private.keep_attendee_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select a.seal_scope, coalesce(a.seal_viewer_ids, '{}') into new.seal_scope, new.seal_viewer_ids
  from app.appointments a where a.id = new.appointment_id;
  new.seal_viewer_ids := coalesce(new.seal_viewer_ids, '{}');
  return new;
end $$;

create trigger appointment_attendees_seal before insert or update of appointment_id, seal_scope, seal_viewer_ids
  on app.appointment_attendees for each row execute function private.keep_attendee_seal();

-- A thread's or an appointment's seals moving: their messages and attendees follow.
create or replace function private.seal_followers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'conversations' then
    update app.messages m set seal_scope = new.seal_scope, seal_viewer_ids = new.seal_viewer_ids
    where m.conversation_id = new.id
      and (m.seal_scope is distinct from new.seal_scope or m.seal_viewer_ids is distinct from new.seal_viewer_ids);
  else
    update app.appointment_attendees t set seal_scope = new.seal_scope, seal_viewer_ids = new.seal_viewer_ids
    where t.appointment_id = new.id
      and (t.seal_scope is distinct from new.seal_scope or t.seal_viewer_ids is distinct from new.seal_viewer_ids);
  end if;
  return null;
end $$;

-- On any update: a seal also moves when a BEFORE trigger recomputes it (a thread narrowed by the inbox's setting), which
-- an `update of` list wouldn't see.
create trigger conversations_seal_followers after update on app.conversations
  for each row when (new.seal_scope is distinct from old.seal_scope or new.seal_viewer_ids is distinct from old.seal_viewer_ids)
  execute function private.seal_followers();
create trigger appointments_seal_followers after update on app.appointments
  for each row when (new.seal_scope is distinct from old.seal_scope or new.seal_viewer_ids is distinct from old.seal_viewer_ids)
  execute function private.seal_followers();

-- Who holds a permission in a business, from the stored permissions.
create or replace function private.permission_holders(p_ws uuid, p_permission text)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(wa.user_id order by wa.user_id), '{}')
  from app.workspace_access wa where wa.workspace_id = p_ws and p_permission = any (wa.permissions)
$$;

-- Home cards: a sealed card follows its record; an add-on's card follows its alert's permission and audience too.
-- The key is the add-on's own read permission; a card under another of its permissions lists who holds that one.
create or replace function private.keep_attention_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_alert record;
  v_perm text;
  v_viewers uuid[];
begin
  new.seal_scope := null;
  new.seal_open := false;
  new.seal_viewer_ids := '{}';
  if new.kind = 'addon_alert' then
    select a.addon_id, a.permission, a.audience_user_ids into v_alert from app.addon_alerts a where a.id = new.subject_id;
    v_perm := private.addon_phone_permission(v_alert.addon_id);
    if v_alert.addon_id is null or v_perm is null then
      return new;
    end if;
    new.seal_scope := new.workspace_id::text || ':' || v_perm;
    if v_alert.permission <> v_perm then
      -- Under another permission: exactly its holders, narrowed by the audience and the record.
      v_viewers := private.permission_holders(new.workspace_id, v_alert.permission);
      if cardinality(v_alert.audience_user_ids) > 0 then
        v_viewers := coalesce((select array_agg(u) from unnest(v_viewers) u where u = any (v_alert.audience_user_ids)), '{}');
      end if;
      if new.sealed then
        v_viewers := coalesce((select array_agg(u) from unnest(v_viewers) u
                               where u = any (coalesce((select s.seal_viewer_ids from private.record_seal(new.custom_record_id) s), '{}'))), '{}');
      end if;
      new.seal_viewer_ids := v_viewers;
    elsif new.sealed then
      select s.seal_viewer_ids into v_viewers from private.record_seal(new.custom_record_id) s;
      v_viewers := coalesce(v_viewers, '{}');
      if cardinality(v_alert.audience_user_ids) > 0 then
        v_viewers := coalesce((select array_agg(u) from unnest(v_viewers) u where u = any (v_alert.audience_user_ids)), '{}');
      end if;
      new.seal_viewer_ids := v_viewers;
    elsif cardinality(v_alert.audience_user_ids) > 0 then
      new.seal_viewer_ids := v_alert.audience_user_ids;
    else
      new.seal_open := true;
    end if;
  elsif new.sealed then
    select s.seal_scope, s.seal_viewer_ids into new.seal_scope, new.seal_viewer_ids
    from private.record_seal(new.custom_record_id) s;
    new.seal_viewer_ids := coalesce(new.seal_viewer_ids, '{}');
  end if;
  -- A card is an inbox row too: once the business narrows its inbox (0083), only its member_viewer_ids keep it.
  if new.seal_scope is not null and private.inbox_narrowed(new.workspace_id) then
    if new.seal_open then
      new.seal_open := false;
      new.seal_viewer_ids := new.member_viewer_ids;
    else
      new.seal_viewer_ids := coalesce(
        (select array_agg(u) from unnest(new.seal_viewer_ids) u where u = any (new.member_viewer_ids)), '{}');
    end if;
  end if;
  return new;
end $$;

-- Sorts after attention_items_sealed (custom_record_id and sealed) and attention_items_member_viewers.
create trigger attention_items_sealed_seal
  before insert or update of kind, subject_type, subject_id, custom_record_id, sealed, seal_scope, seal_open,
    seal_viewer_ids, member_viewer_ids on app.attention_items
  for each row execute function private.keep_attention_seal();

-- An alert raised again for other people, or under another permission: its card follows.
create or replace function private.addon_alert_reseal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.attention_items i set seal_scope = i.seal_scope
  where i.kind = 'addon_alert' and i.subject_id = new.id;
  return null;
end $$;

create trigger addon_alerts_reseal after update of permission, audience_user_ids, custom_record_id on app.addon_alerts
  for each row when (new.permission is distinct from old.permission
                     or new.audience_user_ids is distinct from old.audience_user_ids
                     or new.custom_record_id is distinct from old.custom_record_id)
  execute function private.addon_alert_reseal();

-- A record's people changing: everything sealed to it follows, in one statement per table.
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
  perform private.addon_phone_reseal(new.id);
  return null;
end $$;

-- ---------- an add-on's own rows ----------
create table app.addon_phone_rows (
  -- '<source>:<the row's key>', unique across the add-on's tables.
  id text primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  source text not null,
  record_id uuid,
  data jsonb not null,
  reach text not null check (reach in ('team', 'all')),
  seal_scope text,
  seal_open boolean not null default false,
  seal_viewer_ids uuid[] not null default '{}',
  seal_all text,
  sync_window boolean not null default true,
  updated_at timestamptz not null default now()
);
create index addon_phone_rows_record_idx on app.addon_phone_rows (record_id) where record_id is not null;
create index addon_phone_rows_workspace_idx on app.addon_phone_rows (workspace_id, addon_id);
comment on table app.addon_phone_rows is
  'What phones keep of an add-on''s own tables: each row''s declared columns as JSON, with the seals of the record it follows (Real Estate round six). Kept by triggers private.addon_phone_table() installs; only PowerSync reads it.';
alter table app.addon_phone_rows enable row level security;
-- What a person could read of the rows themselves: the add-on on, its read permission held, and the record they
-- follow seen. The phone gets no more than this (packages/db/test/sync-streams.test.ts holds each arm to it).
create policy addon_phone_rows_select on app.addon_phone_rows for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and private.addon_in_use(workspace_id, addon_id, false)
         and private.has_permission(workspace_id, private.addon_phone_permission(addon_id))
         and (record_id is null or not (record_id in (select private.unseen_private_records()))));
grant select on app.addon_phone_rows to authenticated;
revoke all on app.addon_phone_rows from anon;

-- The seals one add-on row gets: its record's, or (for the business's own rows) open to the add-on's key.
create or replace function private.addon_phone_seal(p_ws uuid, p_addon text, p_record uuid, p_reach text)
returns table (seal_scope text, seal_open boolean, seal_viewer_ids uuid[], seal_all text, sync_window boolean)
language sql stable security definer set search_path = '' as $$
  select r.seal_scope, r.seal_open, r.seal_viewer_ids,
         case when p_reach = 'all' then r.seal_all end, r.sync_window
  from app.custom_records r where p_record is not null and r.id = p_record
  union all
  select p_ws::text || ':' || private.addon_phone_permission(p_addon), true, '{}'::uuid[], null::text, true
  where p_record is null
$$;

-- Writes rows of one of an add-on's tables (as a JSON array) into app.addon_phone_rows, with the seals of the
-- records they follow; only what changed. The copying triggers and the first copy both call it.
create or replace function private.addon_phone_upsert(
  p_addon text, p_source text, p_record text, p_reach text, p_rows jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into app.addon_phone_rows as p (id, workspace_id, addon_id, source, record_id, data, reach,
    seal_scope, seal_open, seal_viewer_ids, seal_all, sync_window, updated_at)
  select p_source || ':' || (x.j ->> t.key_column), (x.j ->> 'workspace_id')::uuid, p_addon, p_source, r.rec, dd.d, p_reach,
         s.seal_scope, coalesce(s.seal_open, false), coalesce(s.seal_viewer_ids, '{}'), s.seal_all,
         coalesce(s.sync_window, true), now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x(j)
  join app.addon_phone_tables t on t.addon_id = p_addon and t.source = p_source
  cross join lateral (select case when p_record is null then null else (x.j ->> p_record)::uuid end as rec) r
  cross join lateral (
    select coalesce(jsonb_object_agg(c, x.j -> c), '{}'::jsonb) as d from unnest(t.columns) c
  ) dd
  left join lateral private.addon_phone_seal((x.j ->> 'workspace_id')::uuid, p_addon, r.rec, p_reach) s on true
  on conflict (id) do update set
    data = excluded.data, record_id = excluded.record_id, seal_scope = excluded.seal_scope,
    seal_open = excluded.seal_open, seal_viewer_ids = excluded.seal_viewer_ids, seal_all = excluded.seal_all,
    sync_window = excluded.sync_window, updated_at = excluded.updated_at
  where p.data is distinct from excluded.data or p.record_id is distinct from excluded.record_id
     or p.seal_scope is distinct from excluded.seal_scope or p.seal_open is distinct from excluded.seal_open
     or p.seal_viewer_ids is distinct from excluded.seal_viewer_ids or p.seal_all is distinct from excluded.seal_all
     or p.sync_window is distinct from excluded.sync_window
$$;

-- The copying trigger, once per statement. Arguments: the add-on, the source, the record column ('' for none), the
-- reach and the key column.
create or replace function private.addon_phone_copy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from app.addon_phone_rows p
    where p.id in (select tg_argv[1] || ':' || (to_jsonb(o) ->> tg_argv[4]) from old_rows o);
  else
    perform private.addon_phone_upsert(tg_argv[0], tg_argv[1], nullif(tg_argv[2], ''), tg_argv[3],
      (select jsonb_agg(to_jsonb(n)) from new_rows n));
  end if;
  return null;
end $$;

-- A record's seals or window changing: its add-on rows follow.
create or replace function private.addon_phone_reseal(p_record uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app.addon_phone_rows p
  set seal_scope = r.seal_scope, seal_open = r.seal_open, seal_viewer_ids = r.seal_viewer_ids,
      seal_all = case when p.reach = 'all' then r.seal_all end, sync_window = r.sync_window, updated_at = now()
  from app.custom_records r
  where r.id = p_record and p.record_id = r.id
    and (p.seal_scope is distinct from r.seal_scope or p.seal_open is distinct from r.seal_open
         or p.seal_viewer_ids is distinct from r.seal_viewer_ids
         or p.seal_all is distinct from (case when p.reach = 'all' then r.seal_all end)
         or p.sync_window is distinct from r.sync_window);
end $$;

-- On any update, as with threads: the seal columns are usually moved by the BEFORE trigger above, not the statement.
create trigger custom_records_seal_followers
  after update on app.custom_records
  for each row when (new.seal_scope is distinct from old.seal_scope or new.seal_open is distinct from old.seal_open
                     or new.seal_viewer_ids is distinct from old.seal_viewer_ids or new.seal_all is distinct from old.seal_all
                     or new.sync_window is distinct from old.sync_window)
  execute function private.record_seal_followers();

-- Whether phones keep a record now. An add-on calls it as the system (a deal ended 90 days ago leaves phones).
create or replace function private.record_phone_window(p_ws uuid, p_record uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_worker_scope(p_ws);
  update app.custom_records r set sync_window = p_on
  where r.id = p_record and r.workspace_id = p_ws and r.sync_window is distinct from p_on;
end $$;
revoke all on function private.record_phone_window(uuid, uuid, boolean) from public;
grant execute on function private.record_phone_window(uuid, uuid, boolean) to service_actor;

-- Names an add-on whose rows phones keep, and the permission a person needs first. Migrations call it.
create or replace function private.addon_phone_addon(p_addon text, p_permission text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into app.addon_phone_addons (addon_id, permission) values (p_addon, p_permission)
  on conflict (addon_id) do update set permission = excluded.permission;
  -- Its kinds and records take their seals, and its people their keys.
  update app.custom_record_types t set seal_scope = t.seal_scope where t.addon_id = p_addon;
  update app.custom_records r set seal_scope = r.seal_scope
  where r.type_id in (select t.id from app.custom_record_types t where t.addon_id = p_addon);
  update app.attention_items x set seal_scope = x.seal_scope
  where x.kind = 'addon_alert' and x.subject_id in (select a.id from app.addon_alerts a where a.addon_id = p_addon);
  perform private.sync_keys_refresh_workspace(i.workspace_id)
  from app.addon_installations i where i.addon_id = p_addon;
end $$;
revoke all on function private.addon_phone_addon(text, text) from public;

-- Names one of an add-on's tables phones keep: checks it, installs the copying triggers and copies what's there.
create or replace function private.addon_phone_table(
  p_table regclass, p_record_column name, p_columns text[], p_reach text default 'team', p_key_column name default 'id')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_addon text;
  v_column text;
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
  if p_reach not in ('team', 'all') then
    raise exception 'reach is team or all' using errcode = '23514';
  end if;
  -- Its key names the row on the phone; workspace_id says whose it is.
  foreach v_column in array array[p_key_column::text, 'workspace_id'] || p_columns
                            || case when p_record_column is null then '{}'::text[] else array[p_record_column::text] end
  loop
    if not exists (select 1 from pg_attribute a where a.attrelid = p_table and a.attname = v_column
                   and a.attnum > 0 and not a.attisdropped) then
      raise exception '% has no column %', p_table, v_column using errcode = '23514';
    end if;
  end loop;
  -- Nothing secret ever reaches a phone (packages/db/test/sync-secrets.test.ts says the same of core's tables).
  if exists (select 1 from unnest(p_columns) c
             where c ~ '(_enc$|secret|password|pkce|oauth_state|token_hash|_hmac$|(^|_)key_id$|^token$|client_state)') then
    raise exception 'A phone never keeps a secret column of %', p_table using errcode = '23514';
  end if;
  insert into app.addon_phone_tables (addon_id, source, key_column, record_column, columns, reach)
  values (v_addon, v_name, p_key_column, p_record_column, p_columns, p_reach)
  on conflict (addon_id, source) do update
    set key_column = excluded.key_column, record_column = excluded.record_column, columns = excluded.columns,
        reach = excluded.reach;

  execute format('drop trigger if exists %I on %s', v_name || '_phone_ins', p_table);
  execute format('drop trigger if exists %I on %s', v_name || '_phone_upd', p_table);
  execute format('drop trigger if exists %I on %s', v_name || '_phone_del', p_table);
  execute format('create trigger %I after insert on %s referencing new table as new_rows for each statement '
                 'execute function private.addon_phone_copy(%L, %L, %L, %L, %L)',
                 v_name || '_phone_ins', p_table, v_addon, v_name, coalesce(p_record_column::text, ''), p_reach,
                 p_key_column);
  execute format('create trigger %I after update on %s referencing old table as old_rows new table as new_rows '
                 'for each statement execute function private.addon_phone_copy(%L, %L, %L, %L, %L)',
                 v_name || '_phone_upd', p_table, v_addon, v_name, coalesce(p_record_column::text, ''), p_reach,
                 p_key_column);
  execute format('create trigger %I after delete on %s referencing old table as old_rows for each statement '
                 'execute function private.addon_phone_copy(%L, %L, %L, %L, %L)',
                 v_name || '_phone_del', p_table, v_addon, v_name, coalesce(p_record_column::text, ''), p_reach,
                 p_key_column);

  -- What's already there (written straight across: the table's own update triggers don't run), and nothing left
  -- over from columns no longer kept.
  delete from app.addon_phone_rows p where p.addon_id = v_addon and p.source = v_name;
  execute format('select private.addon_phone_upsert(%L, %L, %L, %L, (select jsonb_agg(to_jsonb(n)) from %s n))',
    v_addon, v_name, p_record_column::text, p_reach, p_table);
end $$;
revoke all on function private.addon_phone_table(regclass, name, text[], text, name) from public;

-- The add-on rows that differ from what their tables and records say. Empty when they agree (the tests).
create or replace function private.addon_phone_mismatches(p_ws uuid default null)
returns table (id text, problem text) language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
begin
  for v in select * from app.addon_phone_tables loop
    return query execute format($q$
      with want as (
        select %1$L || ':' || (j ->> %8$L) as id, (j ->> 'workspace_id')::uuid as ws, rec,
               (select coalesce(jsonb_object_agg(c, j -> c), '{}'::jsonb) from unnest(%2$L::text[]) c) as data
        from (select to_jsonb(x) as j from %3$I.%4$I x where %9$L::uuid is null or x.workspace_id = %9$L::uuid) s
        cross join lateral (select case when %5$L = '' then null else (s.j ->> %5$L)::uuid end as rec) r
      )
      select w.id, 'missing or stale' from want w
      left join lateral private.addon_phone_seal(w.ws, %6$L, w.rec, %7$L) s on true
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
      v.key_column, p_ws);
  end loop;
  return query select p.id, 'not a table phones keep' from app.addon_phone_rows p
    where (p_ws is null or p.workspace_id = p_ws)
      and not exists (select 1 from app.addon_phone_tables t where t.addon_id = p.addon_id and t.source = p.source);
end $$;

-- The seals on core's rows that differ from what their records say. Empty when they agree (the tests).
create or replace function private.sync_seal_mismatches(p_ws uuid default null)
returns table (table_name text, id uuid, problem text) language sql stable security definer set search_path = '' as $$
  select 'custom_records', r.id, 'record'
  from app.custom_records r
  left join app.custom_record_types t on t.id = r.type_id
  left join app.addon_phone_addons a on a.addon_id = t.addon_id
  where (p_ws is null or r.workspace_id = p_ws) and (r.seal_scope is distinct from (case when a.permission is not null then r.workspace_id::text || ':' || a.permission end)
     or r.seal_open is distinct from (a.permission is not null and not r.kept_to_team)
     or r.seal_all is distinct from (case when a.permission is not null and r.kept_to_team
                                          then r.workspace_id::text || ':' || t.see_all_permission end)
     or r.seal_viewer_ids is distinct from (
       case when a.permission is not null and r.kept_to_team then coalesce(
         (select array_agg(distinct u order by u) from unnest(array_append(r.team_user_ids, r.owner_user_id)) u
          where u is not null), '{}') else '{}'::uuid[] end))
  union all
  select 'tasks', x.id, 'sealed row' from app.tasks x
  left join lateral private.record_seal(x.custom_record_id) s on x.sealed
  where (p_ws is null or x.workspace_id = p_ws) and (x.seal_scope is distinct from s.seal_scope
     or x.seal_viewer_ids is distinct from coalesce(s.seal_viewer_ids, '{}'))
  union all
  select 'activities', x.id, 'sealed row' from app.activities x
  left join lateral private.record_seal(x.custom_record_id) s on x.sealed
  where (p_ws is null or x.workspace_id = p_ws) and (x.seal_scope is distinct from s.seal_scope
     or x.seal_viewer_ids is distinct from coalesce(s.seal_viewer_ids, '{}'))
  union all
  select 'files', x.id, 'sealed row' from app.files x
  left join lateral private.record_seal(x.record_id) s on x.sealed and x.record_type = 'custom_record'
  where (p_ws is null or x.workspace_id = p_ws) and (x.seal_scope is distinct from s.seal_scope
     or x.seal_viewer_ids is distinct from coalesce(s.seal_viewer_ids, '{}'))
  union all
  select 'appointments', x.id, 'sealed row' from app.appointments x
  left join lateral private.record_seal(x.custom_record_id) s on x.sealed
  where (p_ws is null or x.workspace_id = p_ws) and (x.seal_scope is distinct from s.seal_scope
     or x.seal_viewer_ids is distinct from coalesce(s.seal_viewer_ids, '{}'))
  union all
  select 'conversations', x.id, 'sealed thread' from app.conversations x
  left join lateral private.record_seal(x.custom_record_id) s on x.sealed
  where (p_ws is null or x.workspace_id = p_ws) and (x.seal_scope is distinct from s.seal_scope
     or x.seal_viewer_ids is distinct from (
       case when x.sealed and private.inbox_narrowed(x.workspace_id)
            then coalesce((select array_agg(u) from unnest(coalesce(s.seal_viewer_ids, '{}')) u
                           where u = any (x.member_viewer_ids)), '{}')
            else coalesce(s.seal_viewer_ids, '{}') end))
  union all
  select 'messages', m.id, 'thread''s seals' from app.messages m join app.conversations c on c.id = m.conversation_id
  where (p_ws is null or m.workspace_id = p_ws)
    and (m.seal_scope is distinct from c.seal_scope or m.seal_viewer_ids is distinct from c.seal_viewer_ids)
  union all
  select 'attention_items', x.id, 'card' from app.attention_items x
  left join app.addon_alerts al on x.kind = 'addon_alert' and al.id = x.subject_id
  left join app.addon_phone_addons pa on pa.addon_id = al.addon_id
  left join lateral private.record_seal(x.custom_record_id) s on x.sealed
  cross join lateral (
    select
      case when x.kind = 'addon_alert' then
             case when pa.addon_id is not null then x.workspace_id::text || ':' || pa.permission end
           else s.seal_scope end as scope,
      (x.kind = 'addon_alert' and pa.addon_id is not null and al.permission = pa.permission and not x.sealed
       and cardinality(al.audience_user_ids) = 0) as open,
      case when x.kind = 'addon_alert' then
             case when pa.addon_id is null then '{}'::uuid[]
                  when al.permission <> pa.permission then (
                    select coalesce(array_agg(u), '{}') from unnest(private.permission_holders(x.workspace_id, al.permission)) u
                    where (cardinality(al.audience_user_ids) = 0 or u = any (al.audience_user_ids))
                      and (not x.sealed or u = any (coalesce(s.seal_viewer_ids, '{}'))))
                  when x.sealed and cardinality(al.audience_user_ids) > 0
                    then coalesce((select array_agg(u) from unnest(coalesce(s.seal_viewer_ids, '{}')) u
                                   where u = any (al.audience_user_ids)), '{}')
                  when x.sealed then coalesce(s.seal_viewer_ids, '{}')
                  when cardinality(al.audience_user_ids) > 0 then al.audience_user_ids
                  else '{}'::uuid[] end
           else coalesce(s.seal_viewer_ids, '{}') end as viewers
  ) w0
  cross join lateral (
    select w0.scope,
      w0.open and not (w0.scope is not null and private.inbox_narrowed(x.workspace_id)) as open,
      case when w0.scope is not null and private.inbox_narrowed(x.workspace_id) then
             case when w0.open then x.member_viewer_ids
                  else coalesce((select array_agg(u) from unnest(w0.viewers) u where u = any (x.member_viewer_ids)), '{}') end
           else w0.viewers end as viewers
  ) w
  where (p_ws is null or x.workspace_id = p_ws)
    and (x.seal_scope is distinct from w.scope or x.seal_open is distinct from w.open
         or x.seal_viewer_ids is distinct from w.viewers)
  union all
  select 'appointment_attendees', t.id, 'appointment''s seals'
  from app.appointment_attendees t join app.appointments a on a.id = t.appointment_id
  where (p_ws is null or a.workspace_id = p_ws)
    and (t.seal_scope is distinct from a.seal_scope or t.seal_viewer_ids is distinct from a.seal_viewer_ids)
$$;

grant execute on function private.sync_key_mismatches(uuid), private.addon_phone_mismatches(uuid),
  private.sync_seal_mismatches(uuid) to service_actor;

-- PowerSync reads app.sync_keys, app.addon_phone_rows and the records once the sync change publishes them (step 6).

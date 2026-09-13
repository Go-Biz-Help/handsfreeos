-- =============================================================================
-- 0015 · Calendar catalogs. There are no calendar types: every calendar is the
--        same row, and its settings document (`config`, validated by core)
--        alone makes it behave as Personal, Round Robin, Service, Group, Event,
--        Resource, Collective, Dispatch or any mix, keeping its id and link
--        forever. Around it sit the workspace catalogs calendars reference
--        (services, resources, territories, availability schedules), the
--        public booking site, a snapshot of every save, retired slugs so old
--        links keep working, relational mirrors of the config (for foreign keys
--        and "which calendars is Marco on"), and round-robin fairness state.
--        calendars.manage (owners, admins) covers calendars, catalogs, the
--        booking site and anyone's hours; appointments.write (everyone) covers
--        booking and a person's own hours, time off and calendar connection.
--        Weekly hours are wall-clock windows [{day, start, end}]: day 0 =
--        Sunday … 6 = Saturday (JavaScript's getDay, Postgres's dow), "HH:MM"
--        times, an end of up to "24:00". private.expand_schedule turns them
--        into instants in the schedule's zone, or the workspace's when unset.
-- =============================================================================

create type app.schedule_owner_kind as enum ('user', 'resource', 'service', 'calendar');
create type app.schedule_exception_kind as enum ('unavailable', 'available');
create type app.resource_kind as enum ('room', 'equipment', 'vehicle', 'property', 'chair', 'other');
-- A draft or paused calendar may be saved with setting conflicts; an active one may not (core decides).
create type app.calendar_status as enum ('draft', 'active', 'paused', 'archived');

-- ---------- helpers ----------
-- Someone who works in the workspace: a direct member, or an owner or admin of its organization.
create or replace function private.workspace_has_user(p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.workspace_memberships wm where wm.workspace_id = p_ws and wm.user_id = p_user)
    or exists (
      select 1 from app.organization_memberships om join app.workspaces w on w.organization_id = om.organization_id
      where w.id = p_ws and om.user_id = p_user)
$$;

-- An IANA zone Postgres knows ("America/Chicago"). Abbreviations ("CST") and fixed offsets are refused:
-- they don't follow daylight saving the way the business's clocks do.
create or replace function private.is_timezone(p_zone text)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone)
$$;

-- Weekly hours: at most 70 windows, each {day 0-6, start "HH:MM", end "HH:MM" or "24:00"} ending after it
-- starts. A window never crosses midnight (22:00-02:00 is two windows), so each lands on one local date.
-- The times compare as text in the C collation, which orders zero-padded "HH:MM" correctly.
create or replace function private.valid_weekly_hours(p_weekly jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_weekly) <> 'array' then false
    when jsonb_array_length(p_weekly) > 70 then false
    else not exists (
      select 1 from jsonb_array_elements(p_weekly) w
      where jsonb_typeof(w) <> 'object'
        or coalesce(w ->> 'day', '') !~ '^[0-6]$'
        or coalesce(w ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or coalesce(w ->> 'end', '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
        or (w ->> 'start') collate "C" >= (w ->> 'end') collate "C")
  end
$$;

-- Site names the booking pages already use (/book/manage/…, /book/c/…) or that would read as HandsFreeOS.
create or replace function private.booking_slug_reserved(p_slug text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(p_slug) = any (array['manage', 'c', 'api', 'app', 'admin', 'www', 'book', 'help', 'support'])
$$;

-- Foreign keys below that point at catalog rows use the default NO ACTION rather than RESTRICT: both refuse
-- deleting a row something still uses, but NO ACTION checks at the end of the statement, so deleting a
-- whole workspace (which cascades to both sides at once) still works. Catalog rows are archived, not deleted.

-- ---------- resources: rooms, equipment, trucks … (the kind is only a label) ----------
create table app.resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind app.resource_kind not null default 'other',
  quantity integer not null default 1 check (quantity between 1 and 100),
  location text check (location is null or length(location) <= 300),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index resources_name_unique on app.resources (workspace_id, lower(name)) where archived_at is null;
create trigger resources_updated_at before update on app.resources for each row execute function private.set_updated_at();
create trigger resources_immutable before update on app.resources for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- services: what customers book, in one to six lengths ----------
create table app.services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  durations integer[] not null default '{60}'
    check (cardinality(durations) between 1 and 6 and array_position(durations, null) is null
      and 5 <= all (durations) and 720 >= all (durations)),
  default_duration integer not null default 60,
  buffer_before integer not null default 0 check (buffer_before between 0 and 240),
  buffer_after integer not null default 0 check (buffer_after between 0 and 240),
  color text not null default '#2d69d8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- Shown on the booking page only; charging arrives with payments (Milestone 9).
  price_cents integer check (price_cents is null or price_cents >= 0),
  location_kinds text[] not null default '{}'
    check (location_kinds <@ array['customer_address', 'business', 'virtual', 'phone']),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (default_duration = any (durations))
);
create unique index services_name_unique on app.services (workspace_id, lower(name)) where archived_at is null;
create trigger services_updated_at before update on app.services for each row execute function private.set_updated_at();
create trigger services_immutable before update on app.services for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- Who does a service (nobody listed: everyone) and what it needs.
create table app.service_staff (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  service_id uuid not null references app.services (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (service_id, user_id)
);
create index service_staff_user_idx on app.service_staff (user_id);
create trigger service_staff_immutable before update on app.service_staff for each row execute function private.forbid_tenant_column_change('workspace_id', 'service_id', 'user_id');

create table app.service_resources (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  service_id uuid not null references app.services (id) on delete cascade,
  resource_id uuid not null references app.resources (id),
  quantity integer not null default 1 check (quantity between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (service_id, resource_id)
);
create index service_resources_resource_idx on app.service_resources (resource_id);
create trigger service_resources_immutable before update on app.service_resources for each row execute function private.forbid_tenant_column_change('workspace_id', 'service_id', 'resource_id');

-- ---------- territories: ZIP lists that route visits to the people who cover them ----------
create table app.territories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  postal_codes text[] not null default '{}'
    check (cardinality(postal_codes) <= 5000 and array_position(postal_codes, null) is null
      and array_to_string(postal_codes, ',') ~ '^([0-9]{5}(,[0-9]{5})*)?$'),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index territories_name_unique on app.territories (workspace_id, lower(name));
-- "Which territories cover 78701?"
create index territories_postal_codes_idx on app.territories using gin (postal_codes);
create trigger territories_updated_at before update on app.territories for each row execute function private.set_updated_at();
create trigger territories_immutable before update on app.territories for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

create table app.territory_members (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  territory_id uuid not null references app.territories (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (territory_id, user_id)
);
create index territory_members_user_idx on app.territory_members (user_id);
create trigger territory_members_immutable before update on app.territory_members for each row execute function private.forbid_tenant_column_change('workspace_id', 'territory_id', 'user_id');

-- ---------- the public booking site: /book/<slug> lists the workspace's public calendars ----------
create table app.booking_sites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references app.workspaces (id) on delete cascade,
  -- One name across HandsFreeOS whatever the capitals (citext): /book/Lone-Star and /book/lone-star are one page.
  slug extensions.citext not null unique check (slug::text ~* '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  intro text check (intro is null or length(intro) <= 2000),
  enabled boolean not null default true,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger booking_sites_updated_at before update on app.booking_sites for each row execute function private.set_updated_at();
create trigger booking_sites_immutable before update on app.booking_sites for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- Reserved names are refused with a rule the API can explain (a CHECK would only name the constraint).
create or replace function private.guard_booking_site()
returns trigger language plpgsql set search_path = '' as $$
begin
  if private.booking_slug_reserved(new.slug::text) then
    raise exception 'That link name is reserved' using errcode = '23514', detail = 'booking_slug_reserved';
  end if;
  return new;
end $$;
create trigger booking_sites_guard before insert or update of slug on app.booking_sites for each row execute function private.guard_booking_site();

-- ---------- calendars: the permanent identity; how it behaves lives in `config` ----------
create table app.calendars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  color text not null default '#2d69d8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- /book/<site>/<slug>; unique per workspace, which has one site. Renaming retires the old slug (below).
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  status app.calendar_status not null default 'draft',
  public boolean not null default false,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 262144),
  config_version integer not null default 1 check (config_version >= 1),
  revision integer not null default 1 check (revision >= 1),
  -- Inferred from the config for lists and analytics ("Dispatch", "Round Robin"); never gates a setting.
  labels text[] not null default '{}' check (cardinality(labels) <= 12),
  owner_user_id uuid references app.users (id) on delete set null,
  -- null: the workspace's zone.
  timezone text,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index calendars_workspace_idx on app.calendars (workspace_id, status, lower(name));
create trigger calendars_updated_at before update on app.calendars for each row execute function private.set_updated_at();
create trigger calendars_immutable before update on app.calendars for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- Every save, as a snapshot History can restore (restoring saves it again as a new revision). Append-only
-- while the calendar exists; it goes with its calendar.
create table app.calendar_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  revision integer not null check (revision >= 1),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  config_version integer not null check (config_version >= 1),
  labels text[] not null default '{}',
  diff_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(diff_summary) = 'array'),
  changed_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (calendar_id, revision)
);
create trigger calendar_revisions_append_only before update on app.calendar_revisions for each row execute function private.forbid_change();

-- Slugs a calendar used before, so old links still find it. Written only by the trigger below; a current
-- slug always wins over a retired one.
create table app.calendar_slugs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  retired_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index calendar_slugs_calendar_idx on app.calendar_slugs (calendar_id);

create or replace function private.track_calendar_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.slug is distinct from new.slug then
    insert into app.calendar_slugs (workspace_id, calendar_id, slug) values (old.workspace_id, old.id, old.slug)
    on conflict (workspace_id, slug) do update set calendar_id = excluded.calendar_id, retired_at = now();
    -- The new slug is live again, whoever retired it.
    delete from app.calendar_slugs cs where cs.workspace_id = new.workspace_id and cs.slug = new.slug;
  end if;
  return null;
end $$;
create trigger calendars_slug_history after update of slug on app.calendars for each row execute function private.track_calendar_slug();

-- ---------- mirrors of the config, rewritten on every save ----------
-- They give the config's references real foreign keys (a service or resource a calendar uses can't be
-- deleted) and answer "which calendars is Marco on" without reading documents.
create table app.calendar_members (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  weight integer not null default 1 check (weight between 1 and 100),
  priority integer not null default 0 check (priority between 0 and 1000),
  required boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (calendar_id, user_id)
);
create index calendar_members_user_idx on app.calendar_members (workspace_id, user_id);
create trigger calendar_members_immutable before update on app.calendar_members for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'user_id');

create table app.calendar_services (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  service_id uuid not null references app.services (id),
  position integer not null default 0,
  overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(overrides) = 'object'),
  created_at timestamptz not null default now(),
  primary key (calendar_id, service_id)
);
create index calendar_services_service_idx on app.calendar_services (service_id);
create trigger calendar_services_immutable before update on app.calendar_services for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'service_id');

create table app.calendar_resources (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  resource_id uuid not null references app.resources (id),
  quantity integer not null default 1 check (quantity between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (calendar_id, resource_id)
);
create index calendar_resources_resource_idx on app.calendar_resources (resource_id);
create trigger calendar_resources_immutable before update on app.calendar_resources for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'resource_id');

-- ---------- round-robin fairness, updated under the calendar's booking lock ----------
create table app.calendar_assignment_state (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  assigned_count integer not null default 0 check (assigned_count >= 0),
  last_assigned_at timestamptz,
  -- Smooth weighted round robin's running credit (may go negative).
  wrr_credit integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (calendar_id, user_id)
);
create trigger calendar_assignment_state_updated_at before update on app.calendar_assignment_state for each row execute function private.set_updated_at();
create trigger calendar_assignment_state_immutable before update on app.calendar_assignment_state for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'user_id');

-- ---------- availability: weekly hours plus exceptions, for a person, resource, service or calendar ----------
-- One schedule per owner per workspace (a person in two businesses keeps separate hours in each).
create table app.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  owner_kind app.schedule_owner_kind not null,
  -- A user, resource, service or calendar, checked by trigger; the schedule goes when its owner does.
  owner_id uuid not null,
  -- null: the workspace's zone.
  timezone text,
  weekly jsonb not null default '[]'::jsonb check (private.valid_weekly_hours(weekly)),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, owner_kind, owner_id)
);
create trigger schedules_updated_at before update on app.schedules for each row execute function private.set_updated_at();
create trigger schedules_immutable before update on app.schedules for each row execute function private.forbid_tenant_column_change('workspace_id', 'owner_kind', 'owner_id', 'created_by');

-- Time off and closures (unavailable), or extra open time (available), as instants: an all-day day off is
-- converted from local dates in the schedule's zone when it is saved.
create table app.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  schedule_id uuid not null references app.schedules (id) on delete cascade,
  kind app.schedule_exception_kind not null default 'unavailable',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  note text check (note is null or length(note) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '400 days')
);
create index schedule_exceptions_range_idx on app.schedule_exceptions (schedule_id, starts_at, ends_at);
create trigger schedule_exceptions_updated_at before update on app.schedule_exceptions for each row execute function private.set_updated_at();
create trigger schedule_exceptions_immutable before update on app.schedule_exceptions for each row execute function private.forbid_tenant_column_change('workspace_id', 'schedule_id', 'created_by');

-- A schedule's owner_id is polymorphic, so no foreign key can take the schedule away with its owner.
create or replace function private.drop_owned_schedule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from app.schedules s where s.owner_kind = tg_argv[0]::app.schedule_owner_kind and s.owner_id = old.id;
  return null;
end $$;
create trigger resources_drop_schedule after delete on app.resources for each row execute function private.drop_owned_schedule('resource');
create trigger services_drop_schedule after delete on app.services for each row execute function private.drop_owned_schedule('service');
create trigger calendars_drop_schedule after delete on app.calendars for each row execute function private.drop_owned_schedule('calendar');
create trigger users_drop_schedules after delete on app.users for each row execute function private.drop_owned_schedule('user');

-- ---------- references stay inside the workspace, whoever writes ----------
-- Link rows' keys are immutable, so most tables are checked on insert only. People are checked against
-- the workspace's team (private.workspace_has_user); a person who later leaves keeps their history.
create or replace function private.check_calendar_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
  v_zone text;
begin
  if tg_table_name = 'schedules' then
    if tg_op = 'INSERT' then
      v_ok := case new.owner_kind
        when 'user' then private.workspace_has_user(new.workspace_id, new.owner_id)
        when 'resource' then exists (select 1 from app.resources r where r.id = new.owner_id and r.workspace_id = new.workspace_id)
        when 'service' then exists (select 1 from app.services s where s.id = new.owner_id and s.workspace_id = new.workspace_id)
        when 'calendar' then exists (select 1 from app.calendars c where c.id = new.owner_id and c.workspace_id = new.workspace_id)
      end;
    end if;
    v_zone := new.timezone;
  elsif tg_table_name = 'calendars' then
    v_ok := new.owner_user_id is null or private.workspace_has_user(new.workspace_id, new.owner_user_id);
    v_zone := new.timezone;
  elsif tg_table_name = 'schedule_exceptions' then
    v_ok := exists (select 1 from app.schedules s where s.id = new.schedule_id and s.workspace_id = new.workspace_id);
  elsif tg_table_name = 'service_staff' then
    v_ok := exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id)
      and private.workspace_has_user(new.workspace_id, new.user_id);
  elsif tg_table_name = 'service_resources' then
    v_ok := exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id)
      and exists (select 1 from app.resources r where r.id = new.resource_id and r.workspace_id = new.workspace_id);
  elsif tg_table_name = 'territory_members' then
    v_ok := exists (select 1 from app.territories t where t.id = new.territory_id and t.workspace_id = new.workspace_id)
      and private.workspace_has_user(new.workspace_id, new.user_id);
  elsif tg_table_name = 'calendar_revisions' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id);
  elsif tg_table_name in ('calendar_members', 'calendar_assignment_state') then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id)
      and private.workspace_has_user(new.workspace_id, new.user_id);
  elsif tg_table_name = 'calendar_services' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id)
      and exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id);
  elsif tg_table_name = 'calendar_resources' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id)
      and exists (select 1 from app.resources r where r.id = new.resource_id and r.workspace_id = new.workspace_id);
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  if v_zone is not null and not private.is_timezone(v_zone) then
    raise exception 'Unknown time zone: %', v_zone using errcode = '23514', detail = 'timezone_invalid';
  end if;
  return new;
end $$;
create trigger schedules_check_refs before insert or update of timezone on app.schedules for each row execute function private.check_calendar_refs();
create trigger calendars_check_refs before insert or update of owner_user_id, timezone on app.calendars for each row execute function private.check_calendar_refs();
create trigger schedule_exceptions_check_refs before insert on app.schedule_exceptions for each row execute function private.check_calendar_refs();
create trigger service_staff_check_refs before insert on app.service_staff for each row execute function private.check_calendar_refs();
create trigger service_resources_check_refs before insert on app.service_resources for each row execute function private.check_calendar_refs();
create trigger territory_members_check_refs before insert on app.territory_members for each row execute function private.check_calendar_refs();
create trigger calendar_revisions_check_refs before insert on app.calendar_revisions for each row execute function private.check_calendar_refs();
create trigger calendar_members_check_refs before insert on app.calendar_members for each row execute function private.check_calendar_refs();
create trigger calendar_services_check_refs before insert on app.calendar_services for each row execute function private.check_calendar_refs();
create trigger calendar_resources_check_refs before insert on app.calendar_resources for each row execute function private.check_calendar_refs();
create trigger calendar_assignment_state_check_refs before insert on app.calendar_assignment_state for each row execute function private.check_calendar_refs();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'calendars.manage'), ('admin', 'calendars.manage'),
  ('owner', 'appointments.write'), ('admin', 'appointments.write'), ('member', 'appointments.write');

-- Hours and time off: owners and admins edit anyone's, and every resource, service and calendar schedule;
-- everyone who books edits their own.
create or replace function private.may_edit_hours(p_ws uuid, p_owner_kind app.schedule_owner_kind, p_owner_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission(p_ws, 'calendars.manage')
    or (p_owner_kind = 'user' and p_owner_id = auth.uid() and private.has_permission(p_ws, 'appointments.write'))
$$;

create or replace function private.may_edit_schedule(p_schedule uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.may_edit_hours(s.workspace_id, s.owner_kind, s.owner_id) from app.schedules s where s.id = p_schedule
  ), false)
$$;

-- ---------- RLS: the whole team reads calendars and catalogs; owners and admins change them ----------
alter table app.resources enable row level security;
alter table app.services enable row level security;
alter table app.service_staff enable row level security;
alter table app.service_resources enable row level security;
alter table app.territories enable row level security;
alter table app.territory_members enable row level security;
alter table app.booking_sites enable row level security;
alter table app.calendars enable row level security;
alter table app.calendar_revisions enable row level security;
alter table app.calendar_slugs enable row level security;
alter table app.calendar_members enable row level security;
alter table app.calendar_services enable row level security;
alter table app.calendar_resources enable row level security;
alter table app.calendar_assignment_state enable row level security;
alter table app.schedules enable row level security;
alter table app.schedule_exceptions enable row level security;

create policy resources_select on app.resources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy resources_insert on app.resources for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and created_by = (select auth.uid()));
create policy resources_update on app.resources for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy resources_delete on app.resources for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy resources_service_all on app.resources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy services_select on app.services for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy services_insert on app.services for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and created_by = (select auth.uid()));
create policy services_update on app.services for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy services_delete on app.services for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy services_service_all on app.services for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy service_staff_select on app.service_staff for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy service_staff_insert on app.service_staff for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy service_staff_delete on app.service_staff for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy service_staff_service_all on app.service_staff for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy service_resources_select on app.service_resources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy service_resources_insert on app.service_resources for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy service_resources_update on app.service_resources for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy service_resources_delete on app.service_resources for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy service_resources_service_all on app.service_resources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy territories_select on app.territories for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy territories_insert on app.territories for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and created_by = (select auth.uid()));
create policy territories_update on app.territories for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy territories_delete on app.territories for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy territories_service_all on app.territories for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy territory_members_select on app.territory_members for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy territory_members_insert on app.territory_members for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy territory_members_delete on app.territory_members for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy territory_members_service_all on app.territory_members for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy booking_sites_select on app.booking_sites for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy booking_sites_insert on app.booking_sites for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and created_by = (select auth.uid()));
create policy booking_sites_update on app.booking_sites for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy booking_sites_service_all on app.booking_sites for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Calendars are archived, never deleted: their id and link outlive every change.
create policy calendars_select on app.calendars for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendars_insert on app.calendars for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and created_by = (select auth.uid()));
create policy calendars_update on app.calendars for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendars_service_all on app.calendars for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calendar_revisions_select on app.calendar_revisions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_revisions_insert on app.calendar_revisions for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage') and changed_by = (select auth.uid()));
create policy calendar_revisions_service_all on app.calendar_revisions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calendar_slugs_select on app.calendar_slugs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_slugs_service_all on app.calendar_slugs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calendar_members_select on app.calendar_members for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_members_insert on app.calendar_members for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_members_update on app.calendar_members for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_members_delete on app.calendar_members for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_members_service_all on app.calendar_members for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calendar_services_select on app.calendar_services for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_services_insert on app.calendar_services for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_services_update on app.calendar_services for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_services_delete on app.calendar_services for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_services_service_all on app.calendar_services for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy calendar_resources_select on app.calendar_resources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_resources_insert on app.calendar_resources for insert to authenticated
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_resources_update on app.calendar_resources for update to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'))
  with check (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_resources_delete on app.calendar_resources for delete to authenticated
  using (private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_resources_service_all on app.calendar_resources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Booking (by anyone who books, or the booking page) moves the rotation along.
create policy calendar_assignment_state_select on app.calendar_assignment_state for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_assignment_state_insert on app.calendar_assignment_state for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy calendar_assignment_state_update on app.calendar_assignment_state for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy calendar_assignment_state_service_all on app.calendar_assignment_state for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Everyone sees the team's hours (the team view); who may change them is private.may_edit_hours.
create policy schedules_select on app.schedules for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy schedules_insert on app.schedules for insert to authenticated
  with check (private.may_edit_hours(workspace_id, owner_kind, owner_id) and created_by = (select auth.uid()));
create policy schedules_update on app.schedules for update to authenticated
  using (private.may_edit_hours(workspace_id, owner_kind, owner_id))
  with check (private.may_edit_hours(workspace_id, owner_kind, owner_id));
create policy schedules_delete on app.schedules for delete to authenticated
  using (private.may_edit_hours(workspace_id, owner_kind, owner_id));
create policy schedules_service_all on app.schedules for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy schedule_exceptions_select on app.schedule_exceptions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy schedule_exceptions_insert on app.schedule_exceptions for insert to authenticated
  with check (private.may_edit_schedule(schedule_id) and created_by = (select auth.uid()));
create policy schedule_exceptions_update on app.schedule_exceptions for update to authenticated
  using (private.may_edit_schedule(schedule_id))
  with check (private.may_edit_schedule(schedule_id));
create policy schedule_exceptions_delete on app.schedule_exceptions for delete to authenticated
  using (private.may_edit_schedule(schedule_id));
create policy schedule_exceptions_service_all on app.schedule_exceptions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert, update, delete on app.resources, app.services, app.service_resources, app.territories,
  app.calendar_members, app.calendar_services, app.calendar_resources, app.schedules, app.schedule_exceptions
  to authenticated;
grant select, insert, delete on app.service_staff, app.territory_members to authenticated;
grant select, insert, update on app.booking_sites, app.calendars, app.calendar_assignment_state to authenticated;
grant select, insert on app.calendar_revisions to authenticated;
grant select on app.calendar_slugs to authenticated;

grant select, insert, update, delete on app.resources, app.services, app.service_staff, app.service_resources,
  app.territories, app.territory_members, app.calendar_members, app.calendar_services, app.calendar_resources,
  app.calendar_assignment_state, app.schedules, app.schedule_exceptions to service_actor;
grant select, insert, update on app.booking_sites, app.calendars to service_actor;
grant select, insert on app.calendar_revisions to service_actor;
grant select on app.calendar_slugs to service_actor;
revoke all on app.resources, app.services, app.service_staff, app.service_resources, app.territories,
  app.territory_members, app.booking_sites, app.calendars, app.calendar_revisions, app.calendar_slugs,
  app.calendar_members, app.calendar_services, app.calendar_resources, app.calendar_assignment_state,
  app.schedules, app.schedule_exceptions from anon;

-- ---------- turning weekly hours into instants ----------
-- Open time for one schedule between two instants: its weekly wall-clock windows laid on each local date
-- of the schedule's zone (the workspace's when it has none) and converted there, so Chicago's 09:00-17:00
-- stays 09:00-17:00 on the days clocks change; plus 'available' exceptions. Clipped to [from, to), not
-- merged; time off is subtracted by the engine. Local dates come from integer offsets added to a date:
-- generate_series over timestamps would step in the session's zone instead of the schedule's. Runs as
-- the caller, so RLS keeps it inside the caller's workspaces.
create or replace function private.expand_schedule(p_schedule_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable set search_path = '' as $$
  with s as (
    select sc.weekly, coalesce(sc.timezone, w.timezone) as zone
    from app.schedules sc join app.workspaces w on w.id = sc.workspace_id
    where sc.id = p_schedule_id and p_to > p_from
  ),
  days as (
    -- One local date of slack on each side catches windows that cross the range's edges.
    select s.weekly, s.zone, (p_from at time zone s.zone)::date - 1 + n as day
    from s, generate_series(0, least((p_to at time zone s.zone)::date - (p_from at time zone s.zone)::date + 2, 400)) as n
  ),
  windows as (
    select (d.day + (w ->> 'start')::time) at time zone d.zone as starts_at,
           (d.day + (w ->> 'end')::time) at time zone d.zone as ends_at
    from days d cross join lateral jsonb_array_elements(d.weekly) as w
    where (w ->> 'day')::int = extract(dow from d.day)::int
    union all
    select e.starts_at, e.ends_at
    from app.schedule_exceptions e
    where e.schedule_id = p_schedule_id and e.kind = 'available' and exists (select 1 from s)
  )
  select greatest(x.starts_at, p_from), least(x.ends_at, p_to)
  from windows x
  where x.starts_at < p_to and x.ends_at > p_from
  order by 1, 2
$$;

-- ---------- the worker's signed-out booking routes (the tenant is not known yet) ----------
-- /book/<site>/<calendar>: the workspace, organization and calendar a public link names. A retired slug
-- resolves to the calendar that used it (redirected = true, calendar_slug is the current one), and
-- site 'c' with a calendar id is the permanent /book/c/<id> link. With no calendar slug, only the site.
-- Status and public come back so the worker can say "not taking bookings" or hide the calendar.
create or replace function private.booking_route(p_site_slug text, p_calendar_slug text)
returns table (workspace_id uuid, organization_id uuid, timezone text, site_id uuid, site_slug text,
  site_name text, site_enabled boolean, calendar_id uuid, calendar_slug text,
  calendar_status app.calendar_status, calendar_public boolean, redirected boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_site uuid;
  v_calendar uuid;
  v_redirected boolean := false;
begin
  if lower(p_site_slug) = 'c' then
    if coalesce(p_calendar_slug, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return;
    end if;
    select c.id, c.workspace_id into v_calendar, v_ws from app.calendars c where c.id = p_calendar_slug::uuid;
    if v_calendar is null then
      return;
    end if;
    select s.id into v_site from app.booking_sites s where s.workspace_id = v_ws;
    v_redirected := true;
  else
    -- citext's own equality (case-insensitive, and the unique index's), named because search_path is empty.
    select s.id, s.workspace_id into v_site, v_ws from app.booking_sites s
    where s.slug operator(extensions.=) p_site_slug::extensions.citext;
    if v_site is null then
      return;
    end if;
    if p_calendar_slug is not null then
      select c.id into v_calendar from app.calendars c where c.workspace_id = v_ws and c.slug = lower(p_calendar_slug);
      if v_calendar is null then
        select cs.calendar_id into v_calendar from app.calendar_slugs cs
        where cs.workspace_id = v_ws and cs.slug = lower(p_calendar_slug);
        if v_calendar is null then
          return;
        end if;
        v_redirected := true;
      end if;
    end if;
  end if;
  return query
    select w.id, w.organization_id, coalesce(c.timezone, w.timezone), s.id, s.slug::text, s.name, s.enabled,
      c.id, c.slug, c.status, c.public, v_redirected
    from app.workspaces w
    left join app.booking_sites s on s.id = v_site
    left join app.calendars c on c.id = v_calendar
    where w.id = v_ws;
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.workspace_has_user(uuid, uuid), private.is_timezone(text), private.valid_weekly_hours(jsonb),
  private.booking_slug_reserved(text), private.guard_booking_site(), private.track_calendar_slug(),
  private.drop_owned_schedule(), private.check_calendar_refs(),
  private.may_edit_hours(uuid, app.schedule_owner_kind, uuid), private.may_edit_schedule(uuid),
  private.expand_schedule(uuid, timestamptz, timestamptz), private.booking_route(text, text)
  from public;
grant execute on function
  private.workspace_has_user(uuid, uuid), private.is_timezone(text), private.valid_weekly_hours(jsonb),
  private.booking_slug_reserved(text), private.guard_booking_site(), private.track_calendar_slug(),
  private.drop_owned_schedule(), private.check_calendar_refs(),
  private.may_edit_hours(uuid, app.schedule_owner_kind, uuid), private.may_edit_schedule(uuid),
  private.expand_schedule(uuid, timestamptz, timestamptz)
  to authenticated, service_actor;
-- Deleting an account (Auth) removes the person's schedules.
grant execute on function private.drop_owned_schedule() to supabase_auth_admin;
grant execute on function private.booking_route(text, text) to service_actor;

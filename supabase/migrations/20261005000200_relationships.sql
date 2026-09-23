-- =============================================================================
-- 0101 · Relationships, part 2: kinds of records a business makes up, and how
--        any two records relate.
--
--        A dog groomer's customers have pets, a repair shop's have cars, a
--        property manager's owners have properties and their tenants have
--        units, a school's students have parents. Until now the only
--        connection between two records was a person's one company. So:
--
--        **Kinds of records** (app.custom_record_types): "Pet", "Vehicle",
--        "Property", named by the business, each with its own fields (the M15
--        custom fields, which now reach them too). **Records**
--        (app.custom_records) are one pet, one car: a name, notes, their
--        fields, and — through the tables they already use — their own
--        timeline, tasks, files and visits. They are customers' things, so
--        they live under Customers and follow a customer's rules: anyone who
--        can write a record can add one, owners and admins archive them.
--
--        **Relationship types** (app.relationship_types) say which two kinds of
--        record can relate and what each end is called from the other: end A a
--        person called "Owner", end B a pet called "Pet"; a person "Parent" and
--        a person "Student"; a person "Spouse" on both ends. **Relationships**
--        (app.relationships) are one pair. They read both ways: a customer's
--        page lists their pets, and a pet's page its owners, from the same row.
--
--        Decisions worth writing down:
--
--        - **Nothing is assumed to be one-to-one.** A type is many-to-many
--          unless somebody says otherwise (0100's cardinality). One customer
--          with three cars, one car with two owners, one property with several
--          owners and several tenants: all the default. Saying "one" on an end
--          is enforced here, under a lock, whoever writes.
--        - **Each end is a real foreign key.** A relationship keeps one column
--          per kind of record on each end (a person, a company or a record),
--          exactly one of them set, as tasks and the timeline already do. The
--          database then keeps the pair honest on its own: a record that goes
--          takes its relationships with it.
--        - **A pair with no direction is kept one way round.** Spouses and
--          siblings are the same part on both ends; the lower id always sits on
--          end A, so the same two can never be related twice by being entered
--          the other way round.
--        - **A person's company stays where it is.** people.company_id is the
--          company someone belongs to, and it runs through leads, imports and
--          the phone. The apps show it beside these relationships rather than
--          moving it into them; more businesses and locations for the same
--          person are relationships like any other.
--        - **fields.manage decides the shape.** Owners and admins (the people
--          who already make fields) make kinds of records and relationship
--          types; anyone with records.write fills them in.
-- =============================================================================

-- ---------- kinds of records ----------
create table app.custom_record_types (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The short name used in the API and imports ('pet'). Unique per business, and never reused.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- One and more than one: "Pet" and "Pets".
  singular text not null check (length(btrim(singular)) between 1 and 40),
  plural text not null check (length(btrim(plural)) between 1 and 40),
  -- What one's name is called on its page: "Name" for a pet, "Address" for a property.
  name_label text not null default 'Name' check (length(btrim(name_label)) between 1 and 40),
  -- One of the pictures the apps draw (core's RECORD_ICONS); a picture an app doesn't know is drawn as a box.
  icon text not null default 'box' check (icon ~ '^[a-z][a-z0-9-]{0,30}$'),
  -- Where it sits among the tabs and menus, lowest first.
  position integer not null default 0 check (position between 0 and 1000),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);
create unique index custom_record_types_name_unique on app.custom_record_types (workspace_id, lower(btrim(singular)))
  where archived_at is null;
create index custom_record_types_list_idx on app.custom_record_types (workspace_id, position)
  where archived_at is null;
create index custom_record_types_created_by_idx on app.custom_record_types (created_by);
create trigger custom_record_types_updated_at before update on app.custom_record_types
  for each row execute function private.set_updated_at();
create trigger custom_record_types_immutable before update on app.custom_record_types
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'key', 'created_by');

-- A wall, not a wish: each kind is a tab under Customers.
create or replace function private.custom_record_type_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.custom_record_types t
  where t.workspace_id = new.workspace_id and t.archived_at is null;
  if v_count > 30 then
    raise exception 'That is as many kinds of records as a business can keep (30)'
      using errcode = '23514', detail = 'too_many_record_types';
  end if;
  return null;
end $$;
create constraint trigger custom_record_types_room after insert or update of archived_at on app.custom_record_types
  deferrable initially deferred for each row execute function private.custom_record_type_room();

-- ---------- records of those kinds ----------
create table app.custom_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Its kind never changes: its fields and its relationships are the kind's.
  type_id uuid not null references app.custom_record_types (id),
  name text not null check (length(btrim(name)) between 1 and 160),
  notes text check (notes is null or length(notes) <= 10000),
  -- The kind's fields, keyed by custom_fields.id: 0076's shape, and 0096's wall.
  custom jsonb not null default '{}'::jsonb
    check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 65536),
  -- When each column last changed, by the moment the person made the change (0055).
  field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384),
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Found by its name or by anything in its fields (a plate, a VIN, a breed); the field ids are left out.
  search_text text generated always as (
    lower(name || ' ' || coalesce(jsonb_path_query_array(custom, 'strict $.*')::text, ''))
  ) stored
);
create index custom_records_list_idx on app.custom_records (workspace_id, type_id, archived_at, lower(name));
create index custom_records_type_idx on app.custom_records (type_id);
create index custom_records_search_idx on app.custom_records using gin (search_text extensions.gin_trgm_ops);
create index custom_records_custom_idx on app.custom_records using gin (custom jsonb_path_ops);
create index custom_records_created_by_idx on app.custom_records (created_by);
create trigger custom_records_updated_at before update on app.custom_records
  for each row execute function private.set_updated_at();
create trigger custom_records_immutable before update on app.custom_records
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'type_id', 'created_by');
-- Archiving and restoring are for records.archive holders, as for people and companies (0006).
create trigger custom_records_archive_guard before update on app.custom_records
  for each row execute function private.guard_archive();

create or replace function private.check_custom_record_type()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from app.custom_record_types t where t.id = new.type_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger custom_records_check_type before insert on app.custom_records
  for each row execute function private.check_custom_record_type();

-- ---------- their fields: the M15 custom fields, one kind of record at a time ----------
alter table app.custom_fields add column record_type_id uuid references app.custom_record_types (id);
alter table app.custom_fields add constraint custom_fields_record_type_check
  check ((entity = 'custom_record') = (record_type_id is not null));
-- A key is unique per kind of record now, not per entity: a pet's "color" and a car's "color" are two fields.
-- Nulls not distinct, so a customer's fields (no kind) still clash on a key exactly as before.
alter table app.custom_fields drop constraint custom_fields_workspace_id_entity_key_key;
alter table app.custom_fields add constraint custom_fields_key_unique
  unique nulls not distinct (workspace_id, entity, record_type_id, key);
create index custom_fields_record_type_idx on app.custom_fields (record_type_id, position)
  where record_type_id is not null;
drop trigger custom_fields_immutable on app.custom_fields;
create trigger custom_fields_immutable before update on app.custom_fields
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'entity', 'record_type_id', 'created_by');

create or replace function private.check_custom_field_kind()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.record_type_id is not null and not exists (
    select 1 from app.custom_record_types t where t.id = new.record_type_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger custom_fields_check_kind before insert on app.custom_fields
  for each row execute function private.check_custom_field_kind();

-- 200 fields per kind of record, as 0096 set for customers: counted per kind, not across every kind.
create or replace function private.custom_field_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.custom_fields f
  where f.workspace_id = new.workspace_id and f.entity = new.entity
    and f.record_type_id is not distinct from new.record_type_id and f.archived_at is null;
  if v_count > 200 then
    raise exception 'That is as many fields as a record can carry (200)'
      using errcode = '23514', detail = 'too_many_custom_fields';
  end if;
  return null;
end $$;

-- A record holds only its own kind's fields. The rest is 0098's rule, unchanged: what is new or changed on the
-- record must belong to a live field, and a value already there is not a new claim about anything.
create or replace function private.check_custom_values()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_entity app.custom_field_entity := tg_argv[0]::app.custom_field_entity;
  -- Read through jsonb so the same function serves tables with no type_id at all.
  v_kind uuid := case when tg_argv[0] = 'custom_record' then (to_jsonb(new) ->> 'type_id')::uuid end;
  v_stray text;
begin
  if new.custom = '{}'::jsonb or (tg_op = 'UPDATE' and new.custom = old.custom) then
    return new;
  end if;
  select e.key into v_stray from jsonb_each(new.custom) as e
  where (tg_op = 'INSERT' or not (old.custom ? e.key) or old.custom -> e.key is distinct from e.value)
    and not exists (
      select 1 from app.custom_fields f
      where f.workspace_id = new.workspace_id and f.entity = v_entity and f.archived_at is null
        and f.record_type_id is not distinct from v_kind
        and f.id::text = e.key)
  limit 1;
  if v_stray is not null then
    raise exception 'There is no field % on this record', v_stray
      using errcode = '23514', detail = 'unknown_custom_field';
  end if;
  return new;
end $$;
create trigger custom_records_check_custom before insert or update of custom on app.custom_records
  for each row execute function private.check_custom_values('custom_record');

-- Retiring a field takes its value off the records that hold it (0076), now including a kind's records.
create or replace function private.clear_retired_custom_field()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null or old.archived_at is not null then
    return new;
  end if;
  if new.entity = 'person' then
    update app.people set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  elsif new.entity = 'company' then
    update app.companies set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  elsif new.entity = 'lead' then
    update app.leads set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  else
    update app.custom_records set custom = custom - new.id::text
      where workspace_id = new.workspace_id and type_id = new.record_type_id and custom ? new.id::text;
  end if;
  return new;
end $$;

-- ---------- relationship types: which two kinds relate, and what each end is called ----------
create table app.relationship_types (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- End A: a person, a company or a record of one kind, and what it is called from end B ("Owner").
  a_end app.relationship_end not null,
  a_record_type_id uuid references app.custom_record_types (id),
  a_label text not null check (length(btrim(a_label)) between 1 and 40),
  -- End B, the same ("Pet").
  b_end app.relationship_end not null,
  b_record_type_id uuid references app.custom_record_types (id),
  b_label text not null check (length(btrim(b_label)) between 1 and 40),
  -- How many on each end (0100). Many to many unless somebody said otherwise.
  cardinality app.relationship_cardinality not null default 'many_to_many',
  -- The same part on both ends (spouses, siblings): a pair with no direction.
  mutual boolean not null default false,
  position integer not null default 0 check (position between 0 and 1000),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((a_end = 'custom_record') = (a_record_type_id is not null)),
  check ((b_end = 'custom_record') = (b_record_type_id is not null)),
  -- A pair with no direction has one end twice over, and "one A, many Bs" means nothing without a direction.
  check (not mutual or (a_end = b_end and a_record_type_id is not distinct from b_record_type_id
    and a_label = b_label and cardinality in ('one_to_one', 'many_to_many')))
);
create unique index relationship_types_unique on app.relationship_types (
  workspace_id,
  a_end, coalesce(a_record_type_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(a_label)),
  b_end, coalesce(b_record_type_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(b_label))
) where archived_at is null;
create index relationship_types_list_idx on app.relationship_types (workspace_id, position)
  where archived_at is null;
create index relationship_types_a_record_type_idx on app.relationship_types (a_record_type_id)
  where a_record_type_id is not null;
create index relationship_types_b_record_type_idx on app.relationship_types (b_record_type_id)
  where b_record_type_id is not null;
create index relationship_types_created_by_idx on app.relationship_types (created_by);
create trigger relationship_types_updated_at before update on app.relationship_types
  for each row execute function private.set_updated_at();
-- What each end is never changes once pairs rest on it; what it is called, and how many, may.
create trigger relationship_types_immutable before update on app.relationship_types
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'a_end', 'a_record_type_id', 'b_end', 'b_record_type_id', 'mutual', 'created_by');

create or replace function private.check_relationship_type_kinds()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.a_record_type_id is not null and not exists (
        select 1 from app.custom_record_types t where t.id = new.a_record_type_id and t.workspace_id = new.workspace_id))
     or (new.b_record_type_id is not null and not exists (
        select 1 from app.custom_record_types t where t.id = new.b_record_type_id and t.workspace_id = new.workspace_id)) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger relationship_types_check_kinds before insert on app.relationship_types
  for each row execute function private.check_relationship_type_kinds();

create or replace function private.relationship_type_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.relationship_types t
  where t.workspace_id = new.workspace_id and t.archived_at is null;
  if v_count > 50 then
    raise exception 'That is as many relationship types as a business can keep (50)'
      using errcode = '23514', detail = 'too_many_relationship_types';
  end if;
  return null;
end $$;
create constraint trigger relationship_types_room after insert or update of archived_at on app.relationship_types
  deferrable initially deferred for each row execute function private.relationship_type_room();

-- ---------- relationships: one pair ----------
create table app.relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  type_id uuid not null references app.relationship_types (id),
  -- Each end is one record, in the column for its kind; the type says which kind each end is.
  a_person_id uuid references app.people (id) on delete cascade,
  a_company_id uuid references app.companies (id) on delete cascade,
  a_custom_record_id uuid references app.custom_records (id) on delete cascade,
  b_person_id uuid references app.people (id) on delete cascade,
  b_company_id uuid references app.companies (id) on delete cascade,
  b_custom_record_id uuid references app.custom_records (id) on delete cascade,
  -- Whichever record each end is, for reading a record's relationships from either end.
  a_id uuid generated always as (coalesce(a_person_id, a_company_id, a_custom_record_id)) stored,
  b_id uuid generated always as (coalesce(b_person_id, b_company_id, b_custom_record_id)) stored,
  -- A word about this one pair: "Primary driver", "Lease ends in August".
  note text check (note is null or length(note) <= 200),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(a_person_id, a_company_id, a_custom_record_id) = 1),
  check (num_nonnulls(b_person_id, b_company_id, b_custom_record_id) = 1),
  check (a_id <> b_id)
);
create unique index relationships_pair_unique on app.relationships (type_id, a_id, b_id);
create index relationships_type_b_idx on app.relationships (type_id, b_id);
create index relationships_a_idx on app.relationships (workspace_id, a_id);
create index relationships_b_idx on app.relationships (workspace_id, b_id);
create index relationships_a_person_idx on app.relationships (a_person_id) where a_person_id is not null;
create index relationships_a_company_idx on app.relationships (a_company_id) where a_company_id is not null;
create index relationships_a_custom_record_idx on app.relationships (a_custom_record_id) where a_custom_record_id is not null;
create index relationships_b_person_idx on app.relationships (b_person_id) where b_person_id is not null;
create index relationships_b_company_idx on app.relationships (b_company_id) where b_company_id is not null;
create index relationships_b_custom_record_idx on app.relationships (b_custom_record_id) where b_custom_record_id is not null;
create index relationships_created_by_idx on app.relationships (created_by);
create trigger relationships_updated_at before update on app.relationships
  for each row execute function private.set_updated_at();
-- A pair is what it relates; only its note changes. Relating two others is a new pair.
create trigger relationships_immutable before update on app.relationships
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'type_id', 'a_person_id', 'a_company_id', 'a_custom_record_id',
    'b_person_id', 'b_company_id', 'b_custom_record_id', 'created_by');

-- One end is the kind of record its type says, from the same business.
create or replace function private.check_relationship_end(
  p_workspace uuid, p_end app.relationship_end, p_kind uuid, p_person uuid, p_company uuid, p_record uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (p_end = 'person' and (p_person is null or not exists (
        select 1 from app.people p where p.id = p_person and p.workspace_id = p_workspace)))
     or (p_end = 'company' and (p_company is null or not exists (
        select 1 from app.companies c where c.id = p_company and c.workspace_id = p_workspace)))
     or (p_end = 'custom_record' and (p_record is null or not exists (
        select 1 from app.custom_records r
        where r.id = p_record and r.workspace_id = p_workspace and r.type_id = p_kind))) then
    raise exception 'That record can’t be on that end of this relationship'
      using errcode = '23514', detail = 'relationship_end_mismatch';
  end if;
end $$;

/*
 * Every new pair, whoever writes it: both ends are what the type says, a record is never related to itself, a pair
 * with no direction is turned the one way round, and an end that may have only one gets only one.
 *
 * "Only one" is checked under an advisory lock on that end of that type, so two people relating the same pet to two
 * different owners at the same moment can't both succeed. The type's row is read FOR SHARE, so a change to how many
 * each end may have (which takes the row for update, below) waits for pairs being made and is checked against them.
 */
create or replace function private.check_relationship()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  t app.relationship_types%rowtype;
  v_a uuid;
  v_b uuid;
  v_swap uuid;
begin
  select * into t from app.relationship_types rt where rt.id = new.type_id for share;
  if not found or t.workspace_id <> new.workspace_id then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  if t.archived_at is not null then
    raise exception 'That relationship type is archived'
      using errcode = '23514', detail = 'relationship_type_archived';
  end if;
  perform private.check_relationship_end(new.workspace_id, t.a_end, t.a_record_type_id,
    new.a_person_id, new.a_company_id, new.a_custom_record_id);
  perform private.check_relationship_end(new.workspace_id, t.b_end, t.b_record_type_id,
    new.b_person_id, new.b_company_id, new.b_custom_record_id);
  -- The generated a_id and b_id aren't worked out until after this trigger.
  v_a := coalesce(new.a_person_id, new.a_company_id, new.a_custom_record_id);
  v_b := coalesce(new.b_person_id, new.b_company_id, new.b_custom_record_id);
  if v_a = v_b then
    raise exception 'A record can’t be related to itself'
      using errcode = '23514', detail = 'relationship_to_itself';
  end if;
  if t.mutual and v_b < v_a then
    v_swap := new.a_person_id; new.a_person_id := new.b_person_id; new.b_person_id := v_swap;
    v_swap := new.a_company_id; new.a_company_id := new.b_company_id; new.b_company_id := v_swap;
    v_swap := new.a_custom_record_id; new.a_custom_record_id := new.b_custom_record_id; new.b_custom_record_id := v_swap;
    v_swap := v_a; v_a := v_b; v_b := v_swap;
  end if;
  if t.mutual then
    if t.cardinality = 'one_to_one' then
      -- Either record may sit on either end, so both are locked, lower id first.
      perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':' || v_a::text, 0));
      perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':' || v_b::text, 0));
      if exists (select 1 from app.relationships r
                 where r.type_id = t.id and (r.a_id in (v_a, v_b) or r.b_id in (v_a, v_b))) then
        raise exception 'Each can have only one %', t.a_label
          using errcode = '23514', detail = 'relationship_end_full';
      end if;
    end if;
    return new;
  end if;
  -- Each A with at most one B: one to one, and many to one.
  if t.cardinality in ('one_to_one', 'many_to_one') then
    perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':a:' || v_a::text, 0));
    if exists (select 1 from app.relationships r where r.type_id = t.id and r.a_id = v_a) then
      raise exception 'That record already has its %', t.b_label
        using errcode = '23514', detail = 'relationship_end_full';
    end if;
  end if;
  -- Each B with at most one A: one to one, and one to many.
  if t.cardinality in ('one_to_one', 'one_to_many') then
    perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':b:' || v_b::text, 0));
    if exists (select 1 from app.relationships r where r.type_id = t.id and r.b_id = v_b) then
      raise exception 'That record already has its %', t.a_label
        using errcode = '23514', detail = 'relationship_end_full';
    end if;
  end if;
  return new;
end $$;
create trigger relationships_check before insert on app.relationships
  for each row execute function private.check_relationship();

-- Saying "only one" on an end holds only if no record already has more than one there.
create or replace function private.check_relationship_cardinality()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_one_b boolean := new.cardinality in ('one_to_one', 'many_to_one');
  v_one_a boolean := new.cardinality in ('one_to_one', 'one_to_many');
  v_over integer := 0;
begin
  if new.cardinality = old.cardinality then
    return new;
  end if;
  if new.mutual then
    if new.cardinality = 'one_to_one' then
      select count(*) into v_over from (
        select e.id from app.relationships r, lateral (values (r.a_id), (r.b_id)) as e(id)
        where r.type_id = new.id group by e.id having count(*) > 1) over_one;
    end if;
  else
    select count(*) into v_over from (
      select r.a_id from app.relationships r where v_one_b and r.type_id = new.id
      group by r.a_id having count(*) > 1
      union all
      select r.b_id from app.relationships r where v_one_a and r.type_id = new.id
      group by r.b_id having count(*) > 1) over_one;
  end if;
  if v_over > 0 then
    raise exception 'Some records already have more than that allows (%)', v_over
      using errcode = '23514', detail = 'relationship_cardinality_conflict';
  end if;
  return new;
end $$;
create trigger relationship_types_check_cardinality before update of cardinality on app.relationship_types
  for each row execute function private.check_relationship_cardinality();

-- ---------- a record's own timeline, tasks and visits ----------
alter table app.activities add column custom_record_id uuid references app.custom_records (id) on delete set null;
alter table app.activities drop constraint activities_check,
  add constraint activities_check
    check (person_id is not null or company_id is not null or lead_id is not null or custom_record_id is not null);
create index activities_custom_record_idx on app.activities (workspace_id, custom_record_id, occurred_at desc, id desc)
  where custom_record_id is not null;

alter table app.tasks add column custom_record_id uuid references app.custom_records (id) on delete set null;
create index tasks_custom_record_idx on app.tasks (custom_record_id) where custom_record_id is not null;

-- The pet, car or property a visit is for.
alter table app.appointments add column custom_record_id uuid references app.custom_records (id) on delete set null;
create index appointments_custom_record_idx on app.appointments (custom_record_id) where custom_record_id is not null;
grant update (custom_record_id) on app.appointments to authenticated;

create or replace function private.check_custom_record_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.custom_record_id is not null and not exists (
    select 1 from app.custom_records r where r.id = new.custom_record_id and r.workspace_id = new.workspace_id
  ) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger tasks_check_custom_record before insert or update of custom_record_id on app.tasks
  for each row execute function private.check_custom_record_ref();
create trigger activities_check_custom_record before insert or update of custom_record_id on app.activities
  for each row execute function private.check_custom_record_ref();
create trigger appointments_check_custom_record before insert or update of custom_record_id on app.appointments
  for each row execute function private.check_custom_record_ref();

-- Files hang off a record by record_type = 'custom_record' (0100), with records.write deciding, as for a customer's
-- (0082's `else` arm). Tags are for customers, companies and leads: a record's kind already says what it is.
alter table app.record_tags
  add constraint record_tags_not_custom_record check (record_type <> 'custom_record');

-- ---------- RLS: everyone in the business reads; fields.manage shapes; records.write fills in ----------
alter table app.custom_record_types enable row level security;
alter table app.custom_records enable row level security;
alter table app.relationship_types enable row level security;
alter table app.relationships enable row level security;

create policy custom_record_types_select on app.custom_record_types for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy custom_record_types_insert on app.custom_record_types for insert to authenticated
  with check (private.has_permission(workspace_id, 'fields.manage') and created_by = (select auth.uid())
    and archived_at is null);
create policy custom_record_types_update on app.custom_record_types for update to authenticated
  using (private.has_permission(workspace_id, 'fields.manage'))
  with check (private.has_permission(workspace_id, 'fields.manage'));
create policy custom_record_types_service_all on app.custom_record_types for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy custom_records_select on app.custom_records for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy custom_records_insert on app.custom_records for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid())
    and archived_at is null);
create policy custom_records_update on app.custom_records for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy custom_records_service_all on app.custom_records for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy relationship_types_select on app.relationship_types for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy relationship_types_insert on app.relationship_types for insert to authenticated
  with check (private.has_permission(workspace_id, 'fields.manage') and created_by = (select auth.uid())
    and archived_at is null);
create policy relationship_types_update on app.relationship_types for update to authenticated
  using (private.has_permission(workspace_id, 'fields.manage'))
  with check (private.has_permission(workspace_id, 'fields.manage'));
create policy relationship_types_service_all on app.relationship_types for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy relationships_select on app.relationships for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy relationships_insert on app.relationships for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy relationships_update on app.relationships for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
-- Taking a pair apart relates nobody to anything new, and the timeline says who did it: records.write, as for a
-- tag coming off.
create policy relationships_delete on app.relationships for delete to authenticated
  using (private.has_permission(workspace_id, 'records.write'));
create policy relationships_service_all on app.relationships for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.custom_record_types to authenticated;
grant update (singular, plural, name_label, icon, position, archived_at, updated_at)
  on app.custom_record_types to authenticated;
grant select, insert on app.custom_records to authenticated;
grant update (name, notes, custom, field_times, archived_at, updated_at) on app.custom_records to authenticated;
grant select, insert on app.relationship_types to authenticated;
grant update (a_label, b_label, cardinality, position, archived_at, updated_at)
  on app.relationship_types to authenticated;
grant select, insert, delete on app.relationships to authenticated;
grant update (note, updated_at) on app.relationships to authenticated;
grant select, insert, update, delete on app.custom_record_types, app.custom_records, app.relationship_types,
  app.relationships to service_actor;
revoke all on app.custom_record_types, app.custom_records, app.relationship_types, app.relationships from anon;

revoke all on function private.custom_record_type_room(), private.check_custom_record_type(),
  private.check_custom_field_kind(), private.check_relationship_type_kinds(), private.relationship_type_room(),
  private.check_relationship_end(uuid, app.relationship_end, uuid, uuid, uuid, uuid),
  private.check_relationship(), private.check_relationship_cardinality(), private.check_custom_record_ref()
  from public, authenticated, anon;
revoke all on function private.check_custom_values(), private.clear_retired_custom_field(),
  private.custom_field_room() from public, authenticated, anon;

-- =============================================================================
-- 0065 · The engine underneath a migration: the work it is broken into, what it
--        read, what it wrote, and what it would take back.
--
--        Five ideas hold the whole thing up.
--
--        1. One source identity, one record here. Every record this brings over
--           carries where it came from, and `source_target_mappings` is the one
--           index of that. Reading the same page twice, retrying a batch, or a
--           catch-up sync months later all land on the same row rather than a
--           second copy. That unique index is the idempotency boundary, and
--           every other guarantee leans on it.
--        2. Read, then write. `source_objects` holds the payload as the old
--           system gave it, checksummed. Mapping can be improved and re-run
--           without asking the old system again — which matters most after the
--           customer has cancelled it.
--        3. Small leased batches. `migration_jobs` is the work; a worker claims
--           one, and a worker that dies mid-batch loses a lease, not a
--           migration. `migration_checkpoints` is where to start again.
--        4. Nothing is silently lost. A record that cannot be mapped is
--           quarantined in `migration_errors` with a reason, and the category
--           around it keeps going.
--        5. Everything written is written down. `migration_change_journal` is
--           what makes rollback possible, and it is what refuses to undo a
--           field that somebody here has since changed by hand.
-- =============================================================================

create type app.migration_job_state as enum (
  'pending', 'leased', 'done', 'retry', 'quarantined', 'failed', 'cancelled'
);
-- What a unit of work does. `link` is the second pass that attaches the optional
-- relationships a record could not have while its parent was still arriving.
create type app.migration_job_kind as enum (
  'discover', 'scan', 'fetch', 'normalize', 'import', 'media', 'link', 'verify', 'reconcile', 'rollback'
);
create type app.migration_item_state as enum (
  'discovered', 'staged', 'normalized', 'matched', 'imported', 'verified',
  'skipped', 'waiting', 'needs_review', 'failed', 'rolled_back'
);
-- Why something stopped. Each of these has its own answer, and the report never folds them together.
create type app.migration_error_kind as enum (
  'transient', 'permission', 'mapping', 'dependency', 'conflict', 'source_gone', 'policy', 'target'
);
create type app.migration_media_state as enum ('pending', 'copying', 'stored', 'missing', 'failed', 'skipped');
-- What a merge decided, and who decided it.
create type app.merge_resolution as enum ('pending', 'merged', 'separate', 'remapped', 'dismissed');

-- ---------- what the old system said ----------
-- The payload as it arrived, kept so a mapping can be corrected later without asking the old system again.
-- `payload_checksum` is what tells a re-read that nothing changed, so a catch-up sync does no work.
create table app.migration_source_objects (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The source identity: what it is over there, and which one.
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  source_parent_object_id text check (source_parent_object_id is null or length(btrim(source_parent_object_id)) between 1 and 300),
  category text not null check (length(btrim(category)) between 1 and 60),
  -- The old system's own times, never ours. 0064's rule in one line: history keeps its dates.
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_deleted_at timestamptz,
  retrieved_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1048576),
  payload_checksum text not null check (length(btrim(payload_checksum)) between 8 and 128),
  payload_version integer not null default 1 check (payload_version between 1 and 100000),
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  state app.migration_item_state not null default 'staged',
  -- When the raw copy may be thrown away. Set from the organization's retention rule; null means keep.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One staged row per source record per sub-account. A second read of the same record updates it.
create unique index migration_source_objects_identity on app.migration_source_objects
  (scope_id, source_object_type, source_object_id);
create index migration_source_objects_work on app.migration_source_objects (scope_id, category, state);
create index migration_source_objects_parent on app.migration_source_objects
  (scope_id, source_object_type, source_parent_object_id) where source_parent_object_id is not null;
create index migration_source_objects_expiry on app.migration_source_objects (expires_at)
  where expires_at is not null;
create trigger migration_source_objects_updated_at before update on app.migration_source_objects
  for each row execute function private.set_updated_at();

-- ---------- one source record, one record here ----------
-- The idempotency boundary. `installation_id` is the connection, `source_location_id` the sub-account: two
-- sub-accounts landing in one business (which Chris allowed) each keep their own row, and both may point at
-- the same person here — which is exactly what a merge is.
create table app.migration_source_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  source_system app.migration_source not null,
  installation_id uuid not null references app.migration_connections (id) on delete cascade,
  source_location_id text not null check (length(btrim(source_location_id)) between 1 and 200),
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  -- Where it landed here: 'person', 'company', 'lead', 'tag', 'user', 'conversation', 'message'…
  target_type text not null check (length(btrim(target_type)) between 1 and 60),
  target_id uuid not null,
  -- Whether this migration made that record or found it already here and joined the two. Rollback reads this
  -- and nothing else to decide what it may remove.
  created_here boolean not null default true,
  -- The migration that first brought it and the one that last touched it; a second migration from the same
  -- source finds the mapping and updates rather than duplicating.
  first_migration_id uuid not null references app.migrations (id) on delete cascade,
  last_migration_id uuid not null references app.migrations (id) on delete cascade,
  canonical_schema_version integer not null default 1 check (canonical_schema_version between 1 and 1000),
  mapping_version integer not null default 1 check (mapping_version between 1 and 1000),
  source_checksum text check (source_checksum is null or length(btrim(source_checksum)) between 8 and 128),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The rule the whole platform rests on. Written out in full because it is worth reading twice.
create unique index migration_source_mappings_identity on app.migration_source_mappings
  (workspace_id, source_system, installation_id, source_location_id, source_object_type, source_object_id);
-- Everything that came from over there for one record here (the customer's "Imported from GoHighLevel"), and
-- the sweep rollback makes.
create index migration_source_mappings_target on app.migration_source_mappings
  (workspace_id, target_type, target_id);
create index migration_source_mappings_migration on app.migration_source_mappings
  (last_migration_id, target_type);
create trigger migration_source_mappings_updated_at before update on app.migration_source_mappings
  for each row execute function private.set_updated_at();
create trigger migration_source_mappings_immutable before update on app.migration_source_mappings
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'organization_id', 'source_system', 'installation_id', 'source_location_id',
    'source_object_type', 'source_object_id', 'first_migration_id');

-- ---------- two records that may be one person ----------
-- Never guessed from a name. The evidence is kept so the review screen can show why, and so a decision made
-- once can be applied to the rest of the run.
create table app.migration_merge_candidates (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  target_type text not null check (length(btrim(target_type)) between 1 and 60),
  -- The record here it might be. Null when two source records in the same run look like one person and
  -- neither is here yet.
  target_id uuid,
  -- 'phone', 'email', 'extra_phone', 'extra_email', 'corroborating', 'conflict'. The hierarchy lives in core;
  -- this is which rung matched.
  match_rule text not null check (length(btrim(match_rule)) between 1 and 40),
  -- 0 to 100. Only an exact, unambiguous match on a normalized phone or email auto-merges.
  score integer not null default 0 check (score between 0 and 100),
  -- What matched, what disagreed, and which fields could not both be true. No message bodies, ever.
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 65536),
  resolution app.merge_resolution not null default 'pending',
  auto_resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((resolution = 'pending') = (resolved_at is null))
);
create unique index migration_merge_candidates_key on app.migration_merge_candidates
  (scope_id, source_object_type, source_object_id,
   coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index migration_merge_candidates_queue on app.migration_merge_candidates
  (migration_id, resolution, created_at);
create trigger migration_merge_candidates_updated_at before update on app.migration_merge_candidates
  for each row execute function private.set_updated_at();

-- ---------- everything this migration wrote ----------
-- One row per create, per field change and per link. This is what rollback reads, and it is also the honest
-- answer to "what did the import actually do to my data?".
create table app.migration_change_journal (
  id bigserial primary key,
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- 'create', 'update', 'link', 'merge'.
  action text not null check (action in ('create', 'update', 'link', 'merge')),
  target_type text not null check (length(btrim(target_type)) between 1 and 60),
  target_id uuid not null,
  source_object_type text check (source_object_type is null or length(btrim(source_object_type)) between 1 and 60),
  source_object_id text check (source_object_id is null or length(btrim(source_object_id)) between 1 and 300),
  -- For an update: the fields this wrote, each with what was there before and what it put. Rollback puts the
  -- old value back only where the current value is still the one it wrote — a later edit here wins, and says
  -- so in the rollback's own report.
  changed_fields jsonb not null default '{}'::jsonb
    check (jsonb_typeof(changed_fields) = 'object' and pg_column_size(changed_fields) <= 65536),
  reverted_at timestamptz,
  -- Why a rollback left this alone: 'changed_since', 'depended_on', 'external'.
  revert_skipped_reason text check (revert_skipped_reason is null
    or revert_skipped_reason in ('changed_since', 'depended_on', 'external')),
  created_at timestamptz not null default now()
);
create index migration_change_journal_rollback on app.migration_change_journal
  (migration_id, action, id) where reverted_at is null;
create index migration_change_journal_target on app.migration_change_journal
  (workspace_id, target_type, target_id);

-- ---------- what stopped, and whether it can be tried again ----------
create table app.migration_errors (
  id bigserial primary key,
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  category text check (category is null or length(btrim(category)) between 1 and 60),
  source_object_type text check (source_object_type is null or length(btrim(source_object_type)) between 1 and 60),
  source_object_id text check (source_object_id is null or length(btrim(source_object_id)) between 1 and 300),
  kind app.migration_error_kind not null,
  -- A stable code ('rate_limited', 'media_url_expired', 'unknown_field_type'), and one sanitized sentence.
  code text not null check (length(btrim(code)) between 1 and 80),
  message text not null check (length(btrim(message)) between 1 and 2000),
  retryable boolean not null default true,
  attempts integer not null default 1 check (attempts between 1 and 100000),
  -- The sanitized detail support needs. Redacted before it gets here: no tokens, no signed URLs, no bodies.
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 32768),
  resolved_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index migration_errors_list on app.migration_errors (migration_id, kind, last_seen_at desc);
create index migration_errors_retry on app.migration_errors (migration_id, category)
  where resolved_at is null and retryable;
-- The same failure on the same record counts up instead of filling the table.
create unique index migration_errors_key on app.migration_errors
  (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
   coalesce(source_object_type, ''), coalesce(source_object_id, ''));

-- ---------- files brought across ----------
-- A recording, a photo in a text, an attachment on an email. Copied into storage here, checksummed, so the
-- history still plays after the old system is cancelled and its links stop working.
create table app.migration_media (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  -- Where it was. Signed links expire, so this is kept only to ask again while the connection lives, and it
  -- is never shown to a person.
  source_locator text not null check (length(btrim(source_locator)) between 1 and 4000),
  state app.migration_media_state not null default 'pending',
  -- Where it is now, and the row in app.files it became once it is stored.
  bucket text check (bucket is null or length(btrim(bucket)) between 1 and 60),
  object_path text check (object_path is null or length(btrim(object_path)) between 1 and 400),
  file_id uuid references app.files (id) on delete set null,
  file_name text check (file_name is null or length(btrim(file_name)) between 1 and 300),
  -- What the old system said it was, and what the bytes turned out to be. A disagreement is a finding.
  declared_mime text check (declared_mime is null or length(btrim(declared_mime)) between 1 and 200),
  detected_mime text check (detected_mime is null or length(btrim(detected_mime)) between 1 and 200),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum text check (checksum is null or length(btrim(checksum)) between 8 and 128),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  stored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'stored') = (stored_at is not null))
);
create unique index migration_media_key on app.migration_media
  (scope_id, source_object_type, source_object_id, md5(source_locator));
create index migration_media_work on app.migration_media (migration_id, state)
  where state in ('pending', 'copying', 'failed');
-- The same bytes arriving twice under two records: one copy in storage, two references.
create index migration_media_checksum on app.migration_media (workspace_id, checksum)
  where checksum is not null;
create trigger migration_media_updated_at before update on app.migration_media
  for each row execute function private.set_updated_at();

-- ---------- the work itself ----------
-- Small leased batches. A worker claims one, does it, and writes where to start next; a worker that dies
-- loses its lease and the batch comes back after `leased_until`.
create table app.migration_jobs (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  kind app.migration_job_kind not null,
  category text not null check (length(btrim(category)) between 1 and 60),
  state app.migration_job_state not null default 'pending',
  -- Lower runs first, so the things others depend on go first: the pass number from core's graph.
  pass integer not null default 0 check (pass between 0 and 100),
  -- What this batch is: a page cursor, a range of ids, one record to retry.
  input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 65536),
  -- How it went: counts this batch added, and the next cursor, committed together with the rows themselves.
  result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536),
  run_at timestamptz not null default now(),
  leased_by text check (leased_by is null or length(btrim(leased_by)) between 1 and 120),
  leased_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'leased') = (leased_until is not null))
);
-- What to pick up next: the earliest due job of the lowest pass that nobody holds.
create index migration_jobs_claim on app.migration_jobs (pass, run_at, id)
  where state in ('pending', 'retry');
create index migration_jobs_lease on app.migration_jobs (leased_until) where state = 'leased';
create index migration_jobs_progress on app.migration_jobs (migration_id, category, state);
create index migration_jobs_scope on app.migration_jobs (scope_id, state) where scope_id is not null;
create trigger migration_jobs_updated_at before update on app.migration_jobs
  for each row execute function private.set_updated_at();

-- ---------- where to start again ----------
-- Saved only after the rows a page produced are safely stored, never before. Resuming re-reads a little
-- either side of the mark; the unique index above is what makes that harmless.
create table app.migration_checkpoints (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  category text not null check (length(btrim(category)) between 1 and 60),
  -- The source's own place-marker, whatever shape it takes.
  cursor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor) = 'object' and pg_column_size(cursor) <= 16384),
  -- The newest source time this category has taken in, and how far back to re-read for safety.
  high_water_at timestamptz,
  overlap_seconds integer not null default 300 check (overlap_seconds between 0 and 86400),
  last_source_object_id text check (last_source_object_id is null or length(btrim(last_source_object_id)) between 1 and 300),
  -- Every number the progress bar and the final report are made of.
  counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 16384),
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  mapping_version integer not null default 1 check (mapping_version between 1 and 1000),
  complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index migration_checkpoints_key on app.migration_checkpoints (scope_id, category);
create index migration_checkpoints_migration on app.migration_checkpoints (migration_id);
create trigger migration_checkpoints_updated_at before update on app.migration_checkpoints
  for each row execute function private.set_updated_at();

-- ---------- references ----------
-- Every engine row names a scope; this checks it belongs to the migration, and that the business is the
-- scope's own. A scope's workspace can only be set once it is mapped, so a job written before that has none.
create or replace function private.check_migration_engine_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_ws uuid; v_mig uuid;
begin
  select m.organization_id into v_org from app.migrations m where m.id = new.migration_id;
  if v_org is null or v_org is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.scope_id is not null then
    select s.workspace_id, s.migration_id into v_ws, v_mig
      from app.migration_scopes s where s.id = new.scope_id;
    if v_mig is distinct from new.migration_id then
      raise exception 'References must belong to the same migration'
        using errcode = '23514', detail = 'record_migration_mismatch';
    end if;
    if new.workspace_id is not null and v_ws is distinct from new.workspace_id then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end if;
  return new;
end $$;
create trigger migration_source_objects_check_refs before insert on app.migration_source_objects
  for each row execute function private.check_migration_engine_refs();
create trigger migration_merge_candidates_check_refs before insert on app.migration_merge_candidates
  for each row execute function private.check_migration_engine_refs();
create trigger migration_change_journal_check_refs before insert on app.migration_change_journal
  for each row execute function private.check_migration_engine_refs();
create trigger migration_errors_check_refs before insert on app.migration_errors
  for each row execute function private.check_migration_engine_refs();
create trigger migration_media_check_refs before insert on app.migration_media
  for each row execute function private.check_migration_engine_refs();
create trigger migration_jobs_check_refs before insert on app.migration_jobs
  for each row execute function private.check_migration_engine_refs();
-- Checkpoints name no business (a category's place-marker belongs to the sub-account), so they use the
-- child check rather than the engine one, which asks about a workspace column they do not have.
create trigger migration_checkpoints_check_refs before insert on app.migration_checkpoints
  for each row execute function private.check_migration_child_refs();

-- A mapping's business belongs to the migration's organization.
create or replace function private.check_migration_mapping_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.workspace_organization(new.workspace_id) is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if not exists (select 1 from app.migrations m
                 where m.id = new.last_migration_id and m.organization_id = new.organization_id) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;
create trigger migration_source_mappings_check_refs before insert on app.migration_source_mappings
  for each row execute function private.check_migration_mapping_refs();

-- ---------- RLS ----------
-- The agency's owners and admins read all of it. The worker writes it, inside one business at a time — which
-- is what keeps one sub-account's import from touching another business's rows even by mistake.
alter table app.migration_source_objects enable row level security;
alter table app.migration_source_mappings enable row level security;
alter table app.migration_merge_candidates enable row level security;
alter table app.migration_change_journal enable row level security;
alter table app.migration_errors enable row level security;
alter table app.migration_media enable row level security;
alter table app.migration_jobs enable row level security;
alter table app.migration_checkpoints enable row level security;

create policy migration_source_objects_select on app.migration_source_objects for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_source_objects_service_all on app.migration_source_objects for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- The one people see beyond the migration screens: "brought over from GoHighLevel" on a customer's own page,
-- which anyone who may read the record may see. It names no source payload and no token.
create policy migration_source_mappings_select on app.migration_source_mappings for select to authenticated
  using (private.has_permission(workspace_id, 'records.read')
    or private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_source_mappings_service_all on app.migration_source_mappings for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy migration_merge_candidates_select on app.migration_merge_candidates for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_merge_candidates_service_all on app.migration_merge_candidates for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy migration_change_journal_select on app.migration_change_journal for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_change_journal_service_all on app.migration_change_journal for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy migration_errors_select on app.migration_errors for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_errors_service_all on app.migration_errors for all to service_actor
  using (workspace_id is null or workspace_id = private.system_scope_workspace())
  with check (workspace_id is null or workspace_id = private.system_scope_workspace());

create policy migration_media_select on app.migration_media for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_media_service_all on app.migration_media for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy migration_jobs_select on app.migration_jobs for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
-- Jobs and checkpoints are claimed before a business is known (the discover pass), so the worker's scope for
-- them is the organization.
create policy migration_jobs_service_all on app.migration_jobs for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_checkpoints_select on app.migration_checkpoints for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_checkpoints_service_all on app.migration_checkpoints for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

-- ---------- grants ----------
grant select on app.migration_source_objects, app.migration_source_mappings,
  app.migration_merge_candidates, app.migration_change_journal, app.migration_errors,
  app.migration_media, app.migration_jobs, app.migration_checkpoints to authenticated;
grant select, insert, update, delete on app.migration_source_objects, app.migration_source_mappings,
  app.migration_merge_candidates, app.migration_change_journal, app.migration_errors,
  app.migration_media, app.migration_jobs, app.migration_checkpoints to service_actor;
grant usage, select on sequence app.migration_change_journal_id_seq, app.migration_errors_id_seq
  to service_actor;
revoke all on app.migration_source_objects, app.migration_source_mappings,
  app.migration_merge_candidates, app.migration_change_journal, app.migration_errors,
  app.migration_media, app.migration_jobs, app.migration_checkpoints from anon;

-- ---------- claiming work ----------
-- One claim, whatever the number of workers: the row is locked and skipped if somebody else holds it. A job
-- whose lease ran out comes back on its own, which is what makes a worker's death cost one batch.
create or replace function private.claim_migration_jobs(p_worker text, p_limit integer, p_lease_seconds integer)
returns setof app.migration_jobs
language sql volatile security definer set search_path = '' as $$
  with due as (
    select j.id from app.migration_jobs j
    join app.migrations m on m.id = j.migration_id
    where (j.state in ('pending', 'retry') and j.run_at <= now()
           or (j.state = 'leased' and j.leased_until < now()))
      and m.status in ('scanning', 'importing', 'verifying', 'transition', 'finalizing', 'rolling_back')
    order by j.pass, j.run_at, j.id
    limit greatest(p_limit, 0)
    for update of j skip locked
  )
  update app.migration_jobs j
     set state = 'leased',
         leased_by = p_worker,
         leased_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         attempts = j.attempts + 1
    from due where j.id = due.id
  returning j.*
$$;

revoke all on function private.check_migration_engine_refs(), private.check_migration_mapping_refs(),
  private.claim_migration_jobs(text, integer, integer) from public;
grant execute on function private.check_migration_engine_refs(), private.check_migration_mapping_refs()
  to authenticated, service_actor;
grant execute on function private.claim_migration_jobs(text, integer, integer) to service_actor;

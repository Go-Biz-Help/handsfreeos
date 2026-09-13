-- =============================================================================
-- 0021 · Workflows. A business's automations: a trigger, then steps (actions,
--        waits, branches, AI steps, approvals, goto, end). Each workflow keeps
--        one draft (`definition`, core's WorkflowDefinition) that the Steps,
--        Canvas and Describe editors all change. Publishing freezes the draft
--        as an append-only version, and a run keeps the version it started on
--        to the end, so publishing never changes a run in flight. A run logs
--        each step once under (run_id, step_key), so a retried job never sends
--        a text twice. Re-entry ("once ever", "again after they finish") lives
--        in unique indexes, which also settle two events racing to enrol the
--        same customer. Also: approvals, schedule state, inbound webhook URLs
--        (their HMAC secrets sealed by the worker) and the AI builder's
--        proposals. workflows.manage (owners, admins) builds, publishes,
--        pauses and stops; everyone in the workspace reads. The engine runs as
--        the system (service_actor), recorded as actor_type 'workflow'.
-- =============================================================================

create type app.workflow_status as enum ('draft', 'active', 'paused', 'archived');
create type app.workflow_trigger_kind as enum ('event', 'schedule', 'date', 'webhook', 'manual');
create type app.workflow_reentry as enum ('once', 'after_exit', 'always');
-- running, waiting, awaiting_approval and held are "active": the run still holds its place (see the indexes).
create type app.workflow_run_status as enum ('running', 'waiting', 'awaiting_approval', 'held', 'completed', 'stopped', 'failed');
create type app.workflow_test_mode as enum ('simulate', 'send_to_me');
create type app.workflow_step_status as enum ('running', 'done', 'skipped', 'waiting', 'failed', 'dead');
create type app.workflow_approval_status as enum ('pending', 'approved', 'rejected', 'expired', 'cancelled');

-- ---------- workflows: the permanent identity and the one draft all three editors change ----------
create table app.workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  status app.workflow_status not null default 'draft',
  -- The draft. It never runs: a publish copies it into workflow_versions. Core validates it.
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null default 1 check (definition_version >= 1),
  -- Every save raises it. A save names the revision it started from and fails with revision_conflict otherwise.
  revision integer not null default 1 check (revision >= 1),
  -- The draft revision the last passing test ran. Publishing needs tested_revision = revision, so any edit
  -- after a test needs another test. Only the worker sets it (people have no grant on it).
  tested_revision integer check (tested_revision is null or tested_revision between 1 and revision),
  -- The version new runs start on (foreign key below: versions point back here).
  active_version_id uuid,
  -- What the dispatcher matches on, copied from a definition's trigger: the published version's once there is
  -- one, so it finds workflows by what actually runs; the draft's before the first publish (lists, and the
  -- calendar's Automations module).
  trigger_kind app.workflow_trigger_kind not null default 'manual',
  -- The event that starts it, or that a date trigger counts from ("2 hours after appointment.completed").
  trigger_event text check (trigger_event is null or trigger_event ~ '^[a-z_]+(\.[a-z_]+)+$'),
  -- Appointment triggers: the calendars they watch, or all_calendars for every one, now and later.
  calendar_ids uuid[] not null default '{}'
    check (cardinality(calendar_ids) <= 200 and array_position(calendar_ids, null) is null),
  all_calendars boolean not null default false,
  reentry app.workflow_reentry not null default 'after_exit',
  -- Reserved. M6 never stores canvas positions: the layout is computed from the tree every time.
  layout jsonb not null default '{}'::jsonb check (jsonb_typeof(layout) = 'object'),
  -- Installed from an agency template (0022 adds the foreign key): its version, and the draft revision the
  -- install left, so an update can warn when the business has changed its copy since.
  template_id uuid,
  template_version integer check (template_version is null or template_version >= 1),
  installed_revision integer check (installed_revision is null or installed_revision >= 1),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('active', 'paused') or active_version_id is not null)
);
create index workflows_list_idx on app.workflows (workspace_id, status, lower(name));
-- The dispatcher: the active workflows an event starts (or anchors a date trigger for). Paused ones are left
-- out on purpose: triggers that arrive while paused are ignored, not queued.
create index workflows_trigger_idx on app.workflows (workspace_id, trigger_event) where status = 'active';
-- The calendar's Automations: the workflows that watch this calendar.
create index workflows_calendar_ids_idx on app.workflows using gin (calendar_ids);
create index workflows_active_version_id_idx on app.workflows (active_version_id);
create index workflows_created_by_idx on app.workflows (created_by);
create trigger workflows_updated_at before update on app.workflows for each row execute function private.set_updated_at();
create trigger workflows_immutable before update on app.workflows for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- versions: what a publish froze; runs point here for their whole life ----------
create table app.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  workflow_id uuid not null references app.workflows (id) on delete cascade,
  version integer not null check (version >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null check (definition_version >= 1),
  -- The draft revision this version froze.
  revision integer not null check (revision >= 1),
  -- The passing test the publish relied on. No foreign key: runs are pruned, and versions never change.
  test_run_id uuid,
  source text not null default 'editor' check (source in ('editor', 'assistant', 'template')),
  diff_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(diff_summary) = 'array'),
  published_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workflow_id, version)
);
create index workflow_versions_workspace_id_idx on app.workflow_versions (workspace_id);
create index workflow_versions_published_by_idx on app.workflow_versions (published_by);

-- NO ACTION rather than RESTRICT: deleting a whole workflow or workspace cascades to both sides at once,
-- and NO ACTION checks only at the end of that statement.
alter table app.workflows add constraint workflows_active_version_id_fkey
  foreign key (active_version_id) references app.workflow_versions (id);

-- Nobody edits a version, and one goes only with its parent (deleting a workflow or template, or a whole
-- workspace or organization, cascades here). The one change allowed is the foreign key forgetting a deleted
-- account (published_by set to null). Arguments: the parent table and the column naming it, then the
-- tenant table and the column naming it. 0022 reuses it for template versions.
create or replace function private.guard_version_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_parent_alive boolean;
  v_tenant_alive boolean;
begin
  if tg_op = 'DELETE' then
    execute format('select exists (select 1 from app.%I x where x.id = $1)', tg_argv[0])
      into v_parent_alive using (to_jsonb(old) ->> tg_argv[1])::uuid;
    execute format('select exists (select 1 from app.%I x where x.id = $1)', tg_argv[2])
      into v_tenant_alive using (to_jsonb(old) ->> tg_argv[3])::uuid;
    if not (v_parent_alive and v_tenant_alive) then
      return old;
    end if;
  elsif new.published_by is null and (to_jsonb(new) - 'published_by') = (to_jsonb(old) - 'published_by') then
    return new;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501', detail = 'version_immutable';
end $$;
create trigger workflow_versions_append_only before update or delete on app.workflow_versions
  for each row execute function private.guard_version_row('workflows', 'workflow_id', 'workspaces', 'workspace_id');

-- ---------- runs: one customer (or none) going through one version ----------
create table app.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  workflow_id uuid not null references app.workflows (id) on delete cascade,
  -- The version it runs from start to end. A test of the draft has none: it keeps the draft it tested.
  version_id uuid references app.workflow_versions (id),
  test_revision integer check (test_revision is null or test_revision >= 1),
  test_definition jsonb
    check (test_definition is null or (jsonb_typeof(test_definition) = 'object' and pg_column_size(test_definition) <= 524288)),
  status app.workflow_run_status not null default 'running',
  is_test boolean not null default false,
  test_mode app.workflow_test_mode,
  -- Who started a manual or test run ("Send to me" sends only to them).
  started_by uuid references app.users (id) on delete set null,
  -- Whom and what the run is about.
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  appointment_id uuid references app.appointments (id) on delete set null,
  conversation_id uuid references app.conversations (id) on delete set null,
  -- The event that started it (none for schedules, webhooks and manual starts). Events are never deleted,
  -- so this key needs no index.
  trigger_event_id uuid references app.events (id),
  -- One run per trigger: an outbox retry or a replayed webhook lands on the same row.
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  -- Re-entry, filled in by the engine from the workflow's setting (usually the person's id): enrol_key for
  -- "again after they finish" (unique among active runs), once_key for "once ever" (unique forever).
  -- Both stay null for "always".
  enrol_key text check (enrol_key is null or length(enrol_key) between 1 and 300),
  once_key text check (once_key is null or length(once_key) between 1 and 300),
  -- Variables: the trigger's values, AI outputs, and what earlier steps produced.
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 262144),
  -- The step the run is on (a step id); its step key is "<cursor>#<visits[cursor]>".
  cursor text check (cursor is null or length(cursor) between 1 and 100),
  -- How often each step ran ({stepId: n}): goto caps and step keys come from it.
  visits jsonb not null default '{}'::jsonb check (jsonb_typeof(visits) = 'object'),
  step_count integer not null default 0 check (step_count >= 0),
  -- Event keys that wake this run from a wait, and that stop it (a reply, a booking).
  waiting_for text[] not null default '{}' check (cardinality(waiting_for) <= 20 and array_position(waiting_for, null) is null),
  stop_on text[] not null default '{}' check (cardinality(stop_on) <= 20 and array_position(stop_on, null) is null),
  -- Loop guards: the run whose events started this one, the first run of the chain's depth. Capped at 3.
  origin_run_id uuid references app.workflow_runs (id) on delete set null,
  depth integer not null default 0 check (depth between 0 and 3),
  end_reason text check (end_reason is null or length(end_reason) <= 200),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, dedupe_key),
  check (is_test = (test_mode is not null)),
  check (version_id is not null or (is_test and test_revision is not null and test_definition is not null)),
  -- Tests never count toward re-entry.
  check (not is_test or once_key is null),
  check ((status in ('completed', 'stopped', 'failed')) = (ended_at is not null))
);
-- "Again after they finish": one active run per key. Inserting with ON CONFLICT DO NOTHING settles two events
-- racing to enrol the same customer. Tests don't count.
create unique index workflow_runs_enrol_unique on app.workflow_runs (workflow_id, enrol_key)
  where enrol_key is not null and not is_test and status in ('running', 'waiting', 'awaiting_approval', 'held');
-- "Once ever": the key stays taken after the run ends.
create unique index workflow_runs_once_unique on app.workflow_runs (workflow_id, once_key) where once_key is not null;
-- The dispatcher wakes the runs waiting for an event and stops the ones that stop on it.
create index workflow_runs_waiting_for_idx on app.workflow_runs using gin (waiting_for)
  where status in ('running', 'waiting', 'awaiting_approval', 'held');
create index workflow_runs_stop_on_idx on app.workflow_runs using gin (stop_on)
  where status in ('running', 'waiting', 'awaiting_approval', 'held');
-- A customer's active runs: the customer page, "Remove from workflow", stop-on matching.
create index workflow_runs_person_active_idx on app.workflow_runs (workspace_id, person_id)
  where status in ('running', 'waiting', 'awaiting_approval', 'held');
-- One workflow's runs, newest first: the Runs page, and pause and resume in batches.
create index workflow_runs_workflow_idx on app.workflow_runs (workflow_id, status, started_at desc);
create index workflow_runs_workspace_idx on app.workflow_runs (workspace_id, started_at desc);
create index workflow_runs_version_id_idx on app.workflow_runs (version_id);
create index workflow_runs_started_by_idx on app.workflow_runs (started_by);
create index workflow_runs_person_id_idx on app.workflow_runs (person_id);
create index workflow_runs_lead_id_idx on app.workflow_runs (lead_id);
create index workflow_runs_appointment_id_idx on app.workflow_runs (appointment_id);
create index workflow_runs_conversation_id_idx on app.workflow_runs (conversation_id);
create index workflow_runs_origin_run_id_idx on app.workflow_runs (origin_run_id);
create trigger workflow_runs_updated_at before update on app.workflow_runs for each row execute function private.set_updated_at();
create trigger workflow_runs_immutable before update on app.workflow_runs for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'workflow_id', 'version_id', 'is_test', 'test_mode', 'dedupe_key');

-- People stop a run (Stop, or taking a customer out of a workflow); everything else about a run is the
-- engine's. Other updates by people are refused only when they touch the status or how it ended, so the
-- foreign keys can still forget a deleted person, lead or account.
create or replace function private.guard_workflow_run_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if (old.status, old.end_reason, old.ended_at) is distinct from (new.status, new.end_reason, new.ended_at)
     and not (old.status in ('running', 'waiting', 'awaiting_approval', 'held') and new.status = 'stopped') then
    raise exception 'People can only stop a run that is still going' using errcode = '42501', detail = 'workflow_run_status_transition';
  end if;
  return new;
end $$;
create trigger workflow_runs_update_guard before update on app.workflow_runs for each row execute function private.guard_workflow_run_update();

-- ---------- the step log: each step of each run, once ----------
-- The engine claims a step with INSERT … ON CONFLICT (run_id, step_key) DO UPDATE … WHERE status IN
-- ('running', 'failed'), so a step already done is never done again. Kept 180 days.
create table app.workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  run_id uuid not null references app.workflow_runs (id) on delete cascade,
  -- "<stepId>#<visit>": a step revisited through a goto logs again under its next visit.
  step_key text not null check (length(step_key) between 3 and 100 and step_key ~ '#[1-9][0-9]*$'),
  status app.workflow_step_status not null default 'running',
  attempt integer not null default 1 check (attempt between 1 and 100),
  -- What the step was about to do, rendered, with secrets redacted.
  input jsonb check (input is null or (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 131072)),
  output jsonb check (output is null or (jsonb_typeof(output) = 'object' and pg_column_size(output) <= 131072)),
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and pg_column_size(error) <= 16384)),
  -- The events its command emitted: the timeline and the audit log link back to the run through them.
  event_ids uuid[] not null default '{}' check (cardinality(event_ids) <= 50),
  next_step_key text check (next_step_key is null or length(next_step_key) <= 100),
  tokens integer not null default 0 check (tokens >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, step_key)
);
-- Also the 180-day clean-up's index.
create index workflow_run_steps_workspace_idx on app.workflow_run_steps (workspace_id, created_at);
create trigger workflow_run_steps_updated_at before update on app.workflow_run_steps for each row execute function private.set_updated_at();
create trigger workflow_run_steps_immutable before update on app.workflow_run_steps for each row execute function private.forbid_tenant_column_change('workspace_id', 'run_id', 'step_key');

-- ---------- approvals: a run waiting for a person's OK ----------
create table app.workflow_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  workflow_id uuid not null references app.workflows (id) on delete cascade,
  run_id uuid not null references app.workflow_runs (id) on delete cascade,
  step_key text not null check (length(step_key) between 3 and 100 and step_key ~ '#[1-9][0-9]*$'),
  status app.workflow_approval_status not null default 'pending',
  -- The people the step names. With none named, the owners and admins decide; they may decide either way.
  approvers uuid[] not null default '{}' check (cardinality(approvers) <= 50 and array_position(approvers, null) is null),
  -- What happens once approved (the step it previews, rendered), and the approver's changes to it.
  preview jsonb not null default '{}'::jsonb check (jsonb_typeof(preview) = 'object' and pg_column_size(preview) <= 131072),
  edits jsonb check (edits is null or (jsonb_typeof(edits) = 'object' and pg_column_size(edits) <= 131072)),
  reason text check (reason is null or length(reason) <= 1000),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  -- Where it was decided. 'system' covers expiry, a stopped run and simulated tests.
  via text check (via is null or via in ('web', 'email', 'assistant', 'system')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, step_key),
  check ((status = 'pending') = (decided_at is null))
);
-- The Approvals page and the count on Home.
create index workflow_approvals_pending_idx on app.workflow_approvals (workspace_id, created_at desc) where status = 'pending';
create index workflow_approvals_workspace_id_idx on app.workflow_approvals (workspace_id);
create index workflow_approvals_workflow_id_idx on app.workflow_approvals (workflow_id);
create index workflow_approvals_decided_by_idx on app.workflow_approvals (decided_by);
create trigger workflow_approvals_updated_at before update on app.workflow_approvals for each row execute function private.set_updated_at();
create trigger workflow_approvals_immutable before update on app.workflow_approvals for each row execute function private.forbid_tenant_column_change('workspace_id', 'workflow_id', 'run_id', 'step_key');

-- ---------- schedules: where a scheduled workflow's next occurrence stands ----------
-- A workflow.schedule job re-arms itself for the next occurrence (there is no cron); this row is what it
-- and the list read: when it runs next, and how far enrolling the current occurrence got. Audiences are
-- enrolled in pages, so a crash resumes instead of starting over.
create table app.workflow_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  workflow_id uuid not null unique references app.workflows (id) on delete cascade,
  -- The version whose schedule this is; publishing another re-arms it.
  version_id uuid references app.workflow_versions (id),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_occurrence_at timestamptz,
  page_cursor text check (page_cursor is null or length(page_cursor) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_schedules_workspace_id_idx on app.workflow_schedules (workspace_id);
create index workflow_schedules_version_id_idx on app.workflow_schedules (version_id);
create trigger workflow_schedules_updated_at before update on app.workflow_schedules for each row execute function private.set_updated_at();
create trigger workflow_schedules_immutable before update on app.workflow_schedules for each row execute function private.forbid_tenant_column_change('workspace_id', 'workflow_id');

-- ---------- inbound webhooks: POST /webhooks/workflows/<token> ----------
create table app.workflow_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  workflow_id uuid not null unique references app.workflows (id) on delete cascade,
  -- Random and unguessable, but it travels in URLs and logs: the HMAC secret is what proves a sender.
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{24,64}$'),
  -- The HMAC secret, sealed by the worker. People see it once, when it is made; `authenticated` can never
  -- select these two columns.
  secret_enc text not null,
  key_id text not null,
  last_received_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_webhooks_workspace_id_idx on app.workflow_webhooks (workspace_id);
create index workflow_webhooks_created_by_idx on app.workflow_webhooks (created_by);
create trigger workflow_webhooks_updated_at before update on app.workflow_webhooks for each row execute function private.set_updated_at();
create trigger workflow_webhooks_immutable before update on app.workflow_webhooks for each row execute function private.forbid_tenant_column_change('workspace_id', 'workflow_id', 'created_by');

-- ---------- proposals: what the AI builder suggests, before anyone applies it ----------
create table app.workflow_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- null: a proposal for a new workflow ("Describe it", or the Assistant's draft_workflow).
  workflow_id uuid references app.workflows (id) on delete cascade,
  -- The draft revision the ops were written against. Apply refuses a proposal made against an older one.
  base_revision integer check (base_revision is null or base_revision >= 1),
  prompt text not null check (length(btrim(prompt)) between 1 and 4000),
  ops jsonb not null default '[]'::jsonb check (jsonb_typeof(ops) = 'array' and pg_column_size(ops) <= 524288),
  summary text check (summary is null or length(summary) <= 4000),
  -- What was asked for that workflows can't do, for the "unsupported" callout.
  unsupported jsonb not null default '[]'::jsonb check (jsonb_typeof(unsupported) = 'array'),
  applied_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((workflow_id is null) = (base_revision is null))
);
create index workflow_proposals_workspace_idx on app.workflow_proposals (workspace_id, created_at desc);
create index workflow_proposals_workflow_id_idx on app.workflow_proposals (workflow_id);
create index workflow_proposals_created_by_idx on app.workflow_proposals (created_by);
create trigger workflow_proposals_updated_at before update on app.workflow_proposals for each row execute function private.set_updated_at();
create trigger workflow_proposals_immutable before update on app.workflow_proposals for each row execute function private.forbid_tenant_column_change('workspace_id', 'workflow_id', 'created_by');

-- ---------- references stay inside the workspace, whoever writes ----------
-- Foreign keys don't see RLS, so without this a key copied from another business would still be accepted.
create or replace function private.check_workflow_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_table_name = 'workflows' then
    v_ok := (new.active_version_id is null or exists (
        select 1 from app.workflow_versions v where v.id = new.active_version_id and v.workflow_id = new.id))
      and not exists (
        select 1 from unnest(new.calendar_ids) as c (id)
        where not exists (select 1 from app.calendars k where k.id = c.id and k.workspace_id = new.workspace_id));
  elsif tg_table_name in ('workflow_versions', 'workflow_webhooks') then
    v_ok := exists (select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id);
  elsif tg_table_name = 'workflow_proposals' then
    v_ok := new.workflow_id is null
      or exists (select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id);
  elsif tg_table_name = 'workflow_schedules' then
    v_ok := exists (select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id)
      and (new.version_id is null or exists (
        select 1 from app.workflow_versions v where v.id = new.version_id and v.workflow_id = new.workflow_id));
  elsif tg_table_name = 'workflow_runs' then
    v_ok := exists (select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id)
      and (new.version_id is null or exists (
        select 1 from app.workflow_versions v where v.id = new.version_id and v.workflow_id = new.workflow_id))
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.appointment_id is null or exists (
        select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id))
      and (new.conversation_id is null or exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
      and (new.origin_run_id is null or exists (
        select 1 from app.workflow_runs r where r.id = new.origin_run_id and r.workspace_id = new.workspace_id));
  elsif tg_table_name = 'workflow_run_steps' then
    v_ok := exists (select 1 from app.workflow_runs r where r.id = new.run_id and r.workspace_id = new.workspace_id);
  elsif tg_table_name = 'workflow_approvals' then
    v_ok := exists (
        select 1 from app.workflow_runs r
        where r.id = new.run_id and r.workspace_id = new.workspace_id and r.workflow_id = new.workflow_id)
      and not exists (
        select 1 from unnest(new.approvers) as a (id) where not private.workspace_has_user(new.workspace_id, a.id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger workflows_check_refs before insert or update of active_version_id, calendar_ids on app.workflows
  for each row execute function private.check_workflow_refs();
create trigger workflow_versions_check_refs before insert on app.workflow_versions for each row execute function private.check_workflow_refs();
create trigger workflow_runs_check_refs before insert or update of person_id, lead_id, appointment_id, conversation_id
  on app.workflow_runs for each row execute function private.check_workflow_refs();
create trigger workflow_run_steps_check_refs before insert on app.workflow_run_steps for each row execute function private.check_workflow_refs();
create trigger workflow_approvals_check_refs before insert or update of approvers on app.workflow_approvals
  for each row execute function private.check_workflow_refs();
create trigger workflow_schedules_check_refs before insert or update of version_id on app.workflow_schedules
  for each row execute function private.check_workflow_refs();
create trigger workflow_webhooks_check_refs before insert on app.workflow_webhooks for each row execute function private.check_workflow_refs();
create trigger workflow_proposals_check_refs before insert on app.workflow_proposals for each row execute function private.check_workflow_refs();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'workflows.manage'), ('admin', 'workflows.manage');

-- ---------- RLS: the whole team reads; workflows.manage builds, publishes and stops; the engine does the rest ----------
alter table app.workflows enable row level security;
alter table app.workflow_versions enable row level security;
alter table app.workflow_runs enable row level security;
alter table app.workflow_run_steps enable row level security;
alter table app.workflow_approvals enable row level security;
alter table app.workflow_schedules enable row level security;
alter table app.workflow_webhooks enable row level security;
alter table app.workflow_proposals enable row level security;

-- Workflows are archived, never deleted: runs and the audit log keep pointing at them.
create policy workflows_select on app.workflows for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- A new workflow is an untested draft with nothing published.
create policy workflows_insert on app.workflows for insert to authenticated
  with check (private.has_permission(workspace_id, 'workflows.manage') and created_by = (select auth.uid())
    and status = 'draft' and active_version_id is null and tested_revision is null);
create policy workflows_update on app.workflows for update to authenticated
  using (private.has_permission(workspace_id, 'workflows.manage'))
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy workflows_service_all on app.workflows for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy workflow_versions_select on app.workflow_versions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_versions_insert on app.workflow_versions for insert to authenticated
  with check (private.has_permission(workspace_id, 'workflows.manage') and published_by = (select auth.uid()));
create policy workflow_versions_service_all on app.workflow_versions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Only the engine starts runs (an event, a schedule, a webhook, or a person's start request it picks up).
create policy workflow_runs_select on app.workflow_runs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_runs_update on app.workflow_runs for update to authenticated
  using (private.has_permission(workspace_id, 'workflows.manage'))
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy workflow_runs_service_all on app.workflow_runs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy workflow_run_steps_select on app.workflow_run_steps for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_run_steps_service_all on app.workflow_run_steps for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- An approval is decided once (a second click matches no pending row), by a named approver or anyone with
-- workflows.manage, and says who decided it.
create policy workflow_approvals_select on app.workflow_approvals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_approvals_update on app.workflow_approvals for update to authenticated
  using (status = 'pending' and workspace_id in (select private.accessible_workspace_ids())
    and (private.has_permission(workspace_id, 'workflows.manage') or (select auth.uid()) = any (approvers)))
  with check (status in ('approved', 'rejected') and decided_by = (select auth.uid()) and via in ('web', 'assistant')
    and (private.has_permission(workspace_id, 'workflows.manage') or (select auth.uid()) = any (approvers)));
create policy workflow_approvals_service_all on app.workflow_approvals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy workflow_schedules_select on app.workflow_schedules for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_schedules_service_all on app.workflow_schedules for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- The worker makes and rotates webhook URLs, since it is the one that seals secrets.
create policy workflow_webhooks_select on app.workflow_webhooks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_webhooks_service_all on app.workflow_webhooks for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy workflow_proposals_select on app.workflow_proposals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy workflow_proposals_insert on app.workflow_proposals for insert to authenticated
  with check (private.has_permission(workspace_id, 'workflows.manage') and created_by = (select auth.uid()) and applied_at is null);
create policy workflow_proposals_update on app.workflow_proposals for update to authenticated
  using (private.has_permission(workspace_id, 'workflows.manage'))
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy workflow_proposals_service_all on app.workflow_proposals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert on app.workflows, app.workflow_versions, app.workflow_proposals to authenticated;
-- Everything a save, publish, pause, restore or template update changes. tested_revision is left out: only a
-- passing test run (the worker) sets it, so nobody can open the publish gate by hand.
grant update (name, description, status, definition, definition_version, revision, active_version_id, trigger_kind,
  trigger_event, calendar_ids, all_calendars, reentry, layout, template_id, template_version, installed_revision)
  on app.workflows to authenticated;
grant select on app.workflow_runs, app.workflow_run_steps, app.workflow_approvals, app.workflow_schedules to authenticated;
grant update (status, end_reason, ended_at) on app.workflow_runs to authenticated;
grant update (status, edits, reason, decided_by, decided_at, via) on app.workflow_approvals to authenticated;
-- The URL, never the sealed secret. RETURNING must name columns from this list.
grant select (id, workspace_id, workflow_id, token, last_received_at, created_by, created_at, updated_at)
  on app.workflow_webhooks to authenticated;
grant update (applied_at) on app.workflow_proposals to authenticated;

grant select, insert, update on app.workflows, app.workflow_approvals to service_actor;
grant select, insert on app.workflow_versions to service_actor;
grant select, insert, update, delete on app.workflow_runs, app.workflow_run_steps, app.workflow_schedules,
  app.workflow_webhooks, app.workflow_proposals to service_actor;
revoke all on app.workflows, app.workflow_versions, app.workflow_runs, app.workflow_run_steps, app.workflow_approvals,
  app.workflow_schedules, app.workflow_webhooks, app.workflow_proposals from anon;

-- ---------- the inbound webhook route (the tenant is not known yet) ----------
-- The workflow a URL's token names, with its tenant and sealed secret. The worker checks the HMAC first,
-- then reads everything else under that workspace's scope.
create or replace function private.workflow_webhook_route(p_token text)
returns table (webhook_id uuid, workflow_id uuid, workspace_id uuid, organization_id uuid, secret_enc text, key_id text)
language sql stable security definer set search_path = '' as $$
  select h.id, h.workflow_id, h.workspace_id, w.organization_id, h.secret_enc, h.key_id
  from app.workflow_webhooks h join app.workspaces w on w.id = h.workspace_id
  where p_token ~ '^[A-Za-z0-9_-]{24,64}$' and h.token = p_token
$$;

-- ---------- function privileges ----------
revoke all on function
  private.guard_version_row(), private.guard_workflow_run_update(), private.check_workflow_refs(),
  private.workflow_webhook_route(text)
  from public;
grant execute on function
  private.guard_version_row(), private.guard_workflow_run_update(), private.check_workflow_refs()
  to authenticated, service_actor;
grant execute on function private.workflow_webhook_route(text) to service_actor;

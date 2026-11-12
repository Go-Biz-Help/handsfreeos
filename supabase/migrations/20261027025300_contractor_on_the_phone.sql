-- =============================================================================
-- Contractor Operations, part 6: the phone's field pages
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        A crew works where there's no signal: a basement, a roof, a new
--        build with no tower near. So the phone keeps the add-on's jobs, and
--        ticking a checklist item, adding its photo, counting what was used,
--        taking a break and leaving a note all work with none and go when
--        it's back.
--
--        - **notes**: a note from the field on a job, or on one of its
--          visits: typed, a recording (its words follow on their own) or
--          photos. Made on the phone, so it carries the phone's id and the
--          moment it was taken. The recording and photos are files on the
--          job, as a checklist's photos are.
--        - **team** gets an `id` of its own (the job and the person), since a
--          phone names each row it keeps by one column.
--        - **What phones keep** (`private.addon_phone_addon` and
--          `addon_phone_table`, as Real Estate's): each job with its phases,
--          team, work orders and their checklists and subcontractors, its
--          materials, its time and its notes, and the business's crews. Each
--          job's rows follow its record, so a job that leaves phones (done or
--          cancelled a month ago, the worker says when) takes them along.
--          **No money goes to a phone**: not a job's price or budget, what a
--          material or an hour costs, nor its other costs (the owner's
--          decision 11). Those tables aren't named here, and a phone's rows
--          reach everyone who uses the add-on.
--
-- Only adds. Core never points here; `notes` points at core's files,
-- appointments and users. No sync-config change: the rows ride records_v1.
-- =============================================================================

-- ---------- notes from the field ----------
create table addon_contractor.notes (
  -- Made on the phone, or by the web for one typed there.
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job it's on.
  record_id uuid not null,
  -- The visit it was taken on. Kept on the job when the visit is deleted for good.
  appointment_id uuid references app.appointments (id) on delete set null,
  body text check (body is null or length(btrim(body)) between 1 and 4000),
  -- A voice note: the recording (a core file on the job), and its words once they come.
  audio_file_id uuid references app.files (id) on delete set null,
  transcript text check (transcript is null or length(transcript) <= 20000),
  transcript_state text not null default 'none' check (transcript_state in ('none', 'waiting', 'done', 'failed')),
  photo_file_ids uuid[] not null default '{}' check (cardinality(photo_file_ids) <= 20),
  created_by uuid references app.users (id) on delete set null,
  -- When it was taken (the phone's moment), not when it arrived.
  noted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  -- A recording whose file is gone keeps its words, or the note that it had one.
  check (body is not null or audio_file_id is not null or transcript_state <> 'none'
         or cardinality(photo_file_ids) > 0),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index notes_job_idx on addon_contractor.notes (workspace_id, record_id, noted_at);
create index notes_appointment_idx on addon_contractor.notes (appointment_id) where appointment_id is not null;
create index notes_audio_idx on addon_contractor.notes (audio_file_id) where audio_file_id is not null;
create index notes_created_by_idx on addon_contractor.notes (created_by) where created_by is not null;
-- Everyone who uses the add-on reads and adds notes; who may take one off is the command's rule.
select private.addon_table_policies('addon_contractor.notes', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- a job's team, each row named by one column ----------
alter table addon_contractor.team
  add column id text generated always as (record_id::text || ':' || user_id::text) stored;
create unique index team_id_idx on addon_contractor.team (id);

-- ---------- what phones keep ----------
select private.addon_phone_addon('contractor', 'contractor.use');

select private.addon_phone_table('addon_contractor.jobs', 'record_id',
  array['kind', 'status', 'status_at', 'status_reason', 'trade', 'details', 'starts_on', 'due_on', 'done_at',
        'percent_done', 'lead_user_id', 'updated_at'],
  'team', 'record_id');
select private.addon_phone_table('addon_contractor.phases', 'record_id',
  array['position', 'name', 'status', 'percent_done', 'starts_on', 'due_on', 'done_at', 'created_at']);
select private.addon_phone_table('addon_contractor.team', 'record_id', array['user_id', 'created_at']);
-- The business's own: a work order names its crew.
select private.addon_phone_table('addon_contractor.crews', null, array['name', 'archived_at']);
select private.addon_phone_table('addon_contractor.work_orders', 'record_id',
  array['crew_id', 'instructions', 'bring', 'updated_at'], 'team', 'appointment_id');
select private.addon_phone_table('addon_contractor.work_order_items', 'record_id',
  array['appointment_id', 'position', 'label', 'kind', 'required', 'done_at', 'done_by', 'file_id', 'skipped_at',
        'skipped_by', 'skip_reason', 'created_at']);
select private.addon_phone_table('addon_contractor.work_order_subs', 'record_id',
  array['appointment_id', 'person_id', 'told_at', 'done_at', 'done_by', 'note', 'created_at']);
-- What's needed and counted, never what it costs (that's material_costs, which no phone keeps).
select private.addon_phone_table('addon_contractor.materials', 'record_id',
  array['position', 'name', 'unit_label', 'appointment_id', 'needed', 'ordered', 'delivered', 'used', 'wasted',
        'returned', 'supplier', 'expected_on', 'note', 'created_at']);
-- The hours, never what an hour cost (that's time_costs).
select private.addon_phone_table('addon_contractor.time_entries', 'record_id',
  array['appointment_id', 'user_id', 'kind', 'started_at', 'ended_at', 'source', 'auto_stopped', 'fixed_at']);
select private.addon_phone_table('addon_contractor.notes', 'record_id',
  array['appointment_id', 'body', 'audio_file_id', 'transcript', 'transcript_state', 'photo_file_ids', 'created_by',
        'noted_at']);

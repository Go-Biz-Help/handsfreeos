-- =============================================================================
-- Real Estate Agent, round two, step 12: the client's tasks, and what their
-- portal reads.
--
--        Chris decided (2026-09-30): in their portal the client sees where
--        their deal stands and its key dates, does their own tasks (upload a
--        preapproval or ID, sign off), saves or passes on homes, leaves
--        feedback after a tour, and messages the agent. Co-buyers each sign in
--        on their own, and each one's own word is theirs.
--
--        **client_tasks**: what the client does themselves: upload something,
--        sign off on words, or do something; for one client or all of them.
--        **client_task_completions**: each client's part of it: the file they
--        uploaded, or the exact words they signed off on, and when.
--
--        The portal also reads, for the client's own deals: where each stands
--        (`deals`), its key dates (`term_entries`, dates only), its main agent's
--        name and the other clients' first names (`portal.record_owners()`,
--        `portal.record_people()`).
-- =============================================================================

create table addon_realestate.client_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null check (kind in ('upload', 'sign_off', 'do')),
  title text not null check (length(btrim(title)) between 1 and 200),
  -- What to do, in the client's words.
  detail text check (detail is null or length(detail) <= 2000),
  -- A sign-off's exact words, kept as each client agrees to them.
  sign_off_words text check (sign_off_words is null or length(btrim(sign_off_words)) between 1 and 2000),
  -- One client's, or (null) every client's on the deal.
  for_person_id uuid references app.people (id) on delete cascade,
  due_on date,
  -- An upload becomes one of the deal's documents of this kind (a preapproval letter: proof for its duty).
  document_kind text check (document_kind is null or document_kind ~ '^[a-z_]{2,40}$'),
  status text not null default 'open' check (status in ('open', 'done', 'canceled')),
  done_at timestamptz,
  canceled_reason text check (canceled_reason is null or length(canceled_reason) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((kind = 'sign_off') = (sign_off_words is not null)),
  check (document_kind is null or kind = 'upload'),
  check ((status = 'done') = (done_at is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index client_tasks_deal_idx on addon_realestate.client_tasks (workspace_id, deal_record_id, status);
create index client_tasks_person_idx on addon_realestate.client_tasks (for_person_id) where for_person_id is not null;
create index client_tasks_created_by_idx on addon_realestate.client_tasks (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.client_tasks', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.client_tasks', 'deal_record_id',
  array['id', 'kind', 'title', 'detail', 'sign_off_words', 'for_person_id', 'due_on', 'status', 'done_at',
    'created_at']);
-- A client sees the tasks for them, and the ones for every client; not a co-buyer's own.
create policy client_tasks_portal_theirs on addon_realestate.client_tasks as restrictive for select to portal_actor
  using (status <> 'canceled' and (for_person_id is null or for_person_id = (select portal.person())));

create table addon_realestate.client_task_completions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  task_id uuid not null,
  person_id uuid not null references app.people (id) on delete cascade,
  -- An upload's file.
  file_id uuid references app.files (id) on delete set null,
  -- A sign-off's words, exactly as they were when the client agreed.
  signed_words text check (signed_words is null or length(signed_words) <= 2000),
  -- Marked done by someone on the team for the client (an ID handed over at the office), with a note.
  recorded_by uuid references app.users (id) on delete set null,
  note text check (note is null or length(note) <= 500),
  at timestamptz not null default now(),
  unique (task_id, person_id),
  foreign key (workspace_id, task_id) references addon_realestate.client_tasks (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index client_task_completions_deal_idx on addon_realestate.client_task_completions
  (workspace_id, deal_record_id);
create index client_task_completions_person_idx on addon_realestate.client_task_completions (person_id);
create index client_task_completions_file_idx on addon_realestate.client_task_completions (file_id)
  where file_id is not null;
create index client_task_completions_recorded_by_idx on addon_realestate.client_task_completions (recorded_by)
  where recorded_by is not null;
select private.addon_table_policies('addon_realestate.client_task_completions', 'realestate.use', 'realestate.use',
  null, 'deal_record_id');
select private.addon_portal_policies('addon_realestate.client_task_completions', 'deal_record_id',
  array['id', 'task_id', 'person_id', 'file_id', 'signed_words', 'at']);

-- ---------- what the portal reads of a deal ----------

select private.addon_portal_policies('addon_realestate.deals', 'record_id',
  array['side', 'stage', 'stage_entered_at', 'outcome', 'outcome_at']);
select private.addon_portal_policies('addon_realestate.term_entries', 'deal_record_id',
  array['id', 'key', 'value_date', 'value_time', 'confirmed_at', 'superseded_at', 'rejected_at', 'entered_at']);
-- Dates only: never an amount or the deal's words.
create policy term_entries_portal_dates on addon_realestate.term_entries as restrictive for select to portal_actor
  using (value_date is not null);

-- The business's time zone, so a deadline reads as the business's clock says it.
grant select (timezone) on app.workspaces to portal_actor;

-- The main person on each of the customer's records, by name.
create or replace function portal.record_owners()
returns table (record_id uuid, user_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select r.id, u.id, u.full_name from app.custom_records r
  join app.users u on u.id = r.owner_user_id
  where r.id in (select portal.records())
$$;
-- The customers on each of their records (co-buyers), by first name only.
create or replace function portal.record_people()
returns table (record_id uuid, person_id uuid, first_name text)
language sql stable security definer set search_path = '' as $$
  select rel.b_custom_record_id, p.id, p.first_name from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible
  join app.people p on p.id = rel.a_person_id
  where rel.b_custom_record_id in (select portal.records())
  union
  select rel.a_custom_record_id, p.id, p.first_name from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible
  join app.people p on p.id = rel.b_person_id
  where rel.a_custom_record_id in (select portal.records())
$$;
revoke all on function portal.record_owners(), portal.record_people() from public;
grant execute on function portal.record_owners(), portal.record_people() to portal_actor;

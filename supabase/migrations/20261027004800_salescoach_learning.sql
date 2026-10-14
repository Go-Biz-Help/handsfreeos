-- =============================================================================
-- AI Sales Coach, round four: learning from wins
-- (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md).
--
--        **A win.** A coached call or conversation is a win when, within a
--        week of it, the customer books a job, accepts an estimate, pays an
--        invoice, or their Pipeline deal is won (Chris, 2026-10-14). The
--        worker marks it: when, and which.
--
--        **Lessons.** Once a week the coach compares the answers reps gave to
--        objections in wins, and suggests to owners and admins
--        (`salescoach.manage`) a better answer for a playbook objection, or a
--        new objection the playbook lacks, with its numbers. A lesson changes
--        nothing until someone uses it; then the playbook is changed and the
--        lesson kept as used. Only the worker writes lessons; people decide.
-- =============================================================================

alter table addon_salescoach.calls
  add column won_at timestamptz,
  add column won_how text check (won_how is null or won_how in ('booked', 'estimate', 'paid', 'deal')),
  add constraint calls_won_how_with_won_at check ((won_at is null) = (won_how is null));
create index calls_won_idx on addon_salescoach.calls (workspace_id, won_at) where won_at is not null;

create table addon_salescoach.lessons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  playbook_id uuid not null,
  kind text not null check (kind in ('better_answer', 'new_objection')),
  -- The playbook's objection a better answer is for; null for a new one.
  objection_id text check (objection_id is null or objection_id ~ '^o[0-9]{1,3}$'),
  objection text not null check (length(btrim(objection)) between 1 and 160),
  answer text not null check (length(btrim(answer)) between 1 and 800),
  wins integer not null check (wins >= 0),
  of_count integer not null check (of_count >= wins),
  -- The coached records it was learned from.
  evidence uuid[] not null default '{}' check (cardinality(evidence) <= 200),
  state text not null default 'open' check (state in ('open', 'used', 'dismissed')),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, playbook_id) references addon_salescoach.playbooks (workspace_id, id)
    on delete cascade,
  check ((kind = 'better_answer') = (objection_id is not null)),
  check ((state = 'open') = (decided_at is null))
);
create unique index lessons_open_answer_idx on addon_salescoach.lessons (playbook_id, objection_id)
  where state = 'open' and kind = 'better_answer';
create unique index lessons_open_new_idx on addon_salescoach.lessons (playbook_id, lower(btrim(objection)))
  where state = 'open' and kind = 'new_objection';
create index lessons_workspace_idx on addon_salescoach.lessons (workspace_id, state);
create index lessons_playbook_idx on addon_salescoach.lessons (workspace_id, playbook_id);
create index lessons_decided_by_idx on addon_salescoach.lessons (decided_by) where decided_by is not null;
select private.addon_table_policies('addon_salescoach.lessons', 'salescoach.manage', 'salescoach.manage', null, null);
-- The worker writes lessons; owners and admins only decide them.
create policy lessons_worker_insert on addon_salescoach.lessons as restrictive for insert to authenticated
  with check (false);

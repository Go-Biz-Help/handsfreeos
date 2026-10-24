-- =============================================================================
-- Funnels (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): the steps the
-- AI teammate takes each person through.
--
--        **A funnel** is a pipeline's stages plus, for each, its goal, what
--        moves someone on and what the teammate says there and when. Its
--        definition is core's `FunnelDefinition`, checked before every save.
--        One funnel a pipeline (archived ones aside), so a lead's stage is
--        always one funnel's stage. Up to 20 a business. Owners and admins
--        (ai_team.manage) make and change them; everyone sees them.
--
--        **Who's in it** is a row a person: the funnel, their lead in its
--        pipeline, the stage they're at and when they reached it, the booking
--        its messages are timed around, what they've done and been sent at
--        this stage, and whether it's paused for them (someone on the team
--        took the conversation) or they've left. One active row a person:
--        joining a funnel ends the one they were in. The teammate's
--        suggestions are rows too, waiting for a person's yes. Anyone who works
--        records adds, pauses and moves people. A row is hidden while its
--        person is in the Deleted bin, and goes with them when it's emptied.
-- =============================================================================

create table app.funnels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  pipeline_id uuid not null references app.pipelines (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'on', 'paused', 'archived')),
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 262144),
  -- Goes up with every save: a save names the one it started from, so two editors never undo each other.
  revision integer not null default 1 check (revision >= 1),
  turned_on_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index funnels_one_per_pipeline on app.funnels (pipeline_id) where status <> 'archived';
create unique index funnels_name_unique on app.funnels (workspace_id, lower(name)) where status <> 'archived';
create index funnels_workspace_idx on app.funnels (workspace_id, created_at);
create index funnels_created_by_idx on app.funnels (created_by);
create index funnels_updated_by_idx on app.funnels (updated_by);
create trigger funnels_updated_at before update on app.funnels
  for each row execute function private.set_updated_at();
create trigger funnels_immutable before update on app.funnels
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'pipeline_id', 'created_by');

create or replace function private.check_funnel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.pipelines p
                 where p.id = new.pipeline_id and p.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  if new.status <> 'archived' and (tg_op = 'INSERT' or old.status = 'archived')
     and (select count(*) from app.funnels f
          where f.workspace_id = new.workspace_id and f.status <> 'archived' and f.id <> new.id) >= 20 then
    raise exception 'A business keeps 20 funnels at most'
      using errcode = '23514', detail = 'funnels_full';
  end if;
  return new;
end $$;
create trigger funnels_check before insert or update on app.funnels
  for each row execute function private.check_funnel();

alter table app.funnels enable row level security;
create policy funnels_select on app.funnels for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy funnels_insert on app.funnels for insert to authenticated
  with check (private.has_permission(workspace_id, 'ai_team.manage') and created_by = (select auth.uid())
    and updated_by = (select auth.uid()));
create policy funnels_update on app.funnels for update to authenticated
  using (private.has_permission(workspace_id, 'ai_team.manage'))
  with check (private.has_permission(workspace_id, 'ai_team.manage') and updated_by = (select auth.uid()));
create policy funnels_service_all on app.funnels for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.funnels to authenticated;
grant update (name, status, definition, revision, turned_on_at, updated_by, updated_at) on app.funnels to authenticated;
grant select, insert, update, delete on app.funnels to service_actor;
revoke all on app.funnels from anon;

-- ---------- who's in each ----------
create table app.funnel_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  funnel_id uuid not null references app.funnels (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- Their lead in the funnel's pipeline. A suggestion may not have one yet.
  lead_id uuid references app.leads (id) on delete cascade,
  stage_id uuid references app.pipeline_stages (id) on delete set null,
  -- active, paused (for them alone), left, suggested (by the teammate, waiting for a person), declined.
  status text not null default 'active'
    check (status in ('active', 'paused', 'left', 'suggested', 'declined')),
  stage_reached_at timestamptz not null default now(),
  -- The booking this stage's messages are timed around.
  appointment_id uuid references app.appointments (id) on delete set null,
  -- What they've done at this stage (event types), and the stage's messages already sent (or skipped).
  seen text[] not null default '{}' check (cardinality(seen) <= 20 and array_position(seen, null) is null),
  sent text[] not null default '{}' check (cardinality(sent) <= 40 and array_position(sent, null) is null),
  paused_reason text check (paused_reason in ('taken_over', 'handed_off', 'by_hand')),
  left_reason text check (left_reason in ('won', 'lost', 'removed', 'outside', 'other_funnel', 'opted_out',
    'funnel_archived', 'lead_gone')),
  left_at timestamptz,
  added_by text not null default 'rule' check (added_by in ('rule', 'hand', 'ai', 'turn_on')),
  added_by_user uuid references app.users (id) on delete set null,
  -- The teammate's reason, for a suggestion.
  suggested_why text check (suggested_why is null or length(btrim(suggested_why)) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'paused') = (paused_reason is not null)),
  check ((status = 'left') = (left_at is not null)),
  check ((status = 'left') = (left_reason is not null)),
  check (status in ('suggested', 'declined', 'left') or lead_id is not null)
);
-- One funnel at a time, and one suggestion a funnel a person.
create unique index funnel_people_one_at_a_time on app.funnel_people (person_id) where status in ('active', 'paused');
create unique index funnel_people_one_suggestion on app.funnel_people (funnel_id, person_id) where status = 'suggested';
create index funnel_people_stage_idx on app.funnel_people (funnel_id, stage_id) where status in ('active', 'paused');
create index funnel_people_workspace_id_idx on app.funnel_people (workspace_id);
create index funnel_people_funnel_id_idx on app.funnel_people (funnel_id, created_at desc);
create index funnel_people_person_id_idx on app.funnel_people (person_id);
create index funnel_people_lead_id_idx on app.funnel_people (lead_id);
create index funnel_people_stage_id_idx on app.funnel_people (stage_id);
create index funnel_people_appointment_id_idx on app.funnel_people (appointment_id);
create index funnel_people_added_by_user_idx on app.funnel_people (added_by_user);
create trigger funnel_people_updated_at before update on app.funnel_people
  for each row execute function private.set_updated_at();
create trigger funnel_people_immutable before update on app.funnel_people
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'funnel_id', 'person_id',
    'added_by', 'added_by_user');

create or replace function private.check_funnel_person()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  f_pipeline uuid;
begin
  select f.pipeline_id into f_pipeline from app.funnels f
    where f.id = new.funnel_id and f.workspace_id = new.workspace_id;
  if f_pipeline is null
     or not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
     or (new.lead_id is not null and not exists (
           select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id
             and l.pipeline_id = f_pipeline and l.person_id = new.person_id))
     or (new.stage_id is not null and not exists (
           select 1 from app.pipeline_stages s where s.id = new.stage_id and s.pipeline_id = f_pipeline))
     or (new.appointment_id is not null and not exists (
           select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business, or to another pipeline'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger funnel_people_check before insert or update on app.funnel_people
  for each row execute function private.check_funnel_person();

alter table app.funnel_people enable row level security;
create policy funnel_people_select on app.funnel_people for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Who's in a funnel changes with the records (adding a person, a lead moving), or with the funnel itself (a stage
-- taken out, the funnel archived) by whoever runs the AI teammate.
create policy funnel_people_insert on app.funnel_people for insert to authenticated
  with check ((private.has_permission(workspace_id, 'records.write')
      or private.has_permission(workspace_id, 'ai_team.manage'))
    and (added_by_user is null or added_by_user = (select auth.uid())));
create policy funnel_people_update on app.funnel_people for update to authenticated
  using (private.has_permission(workspace_id, 'records.write')
    or private.has_permission(workspace_id, 'ai_team.manage'))
  with check (private.has_permission(workspace_id, 'records.write')
    or private.has_permission(workspace_id, 'ai_team.manage'));
-- Hidden and frozen while the customer is in the Deleted bin, for people and the worker alike, so nothing more is sent;
-- back with Bring back (docs/deleting.md). Emptying the bin takes the row with the customer.
create policy funnel_people_follow_person on app.funnel_people as restrictive for all
  to authenticated, service_actor
  using (exists (select 1 from app.people p
                 where p.id = funnel_people.person_id and (p.bin_item_id is null or private.reading_bin())))
  with check (exists (select 1 from app.people p
                      where p.id = funnel_people.person_id and p.bin_item_id is null));
create policy funnel_people_service_all on app.funnel_people for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.funnel_people to authenticated;
grant update (lead_id, stage_id, status, stage_reached_at, appointment_id, seen, sent, paused_reason, left_reason,
  left_at, updated_at) on app.funnel_people to authenticated;
grant select, insert, update, delete on app.funnel_people to service_actor;
revoke all on app.funnel_people from anon;

-- The AI's draft of a funnel from the business's description counts toward the daily AI limit as its own source.
alter type app.ai_usage_source add value if not exists 'funnel';

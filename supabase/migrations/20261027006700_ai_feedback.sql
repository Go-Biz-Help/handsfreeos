-- =============================================================================
-- Coaching the AI teammate: feedback on its replies, and an Instructions list
-- (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md).
--
--        `teammate_instructions` is the list of rules the AI teammate reads
--        whole on every reply, call and test, after its fixed rules. A person
--        adds, edits and deletes them (ai_team.manage); a lesson a person
--        OKs adds one. At most 50 per teammate, 300 characters each.
--
--        `teammate_feedback` is a person's thumbs up or down on a reply the
--        AI wrote, in a test or for real, with what it should have said and
--        why. One per person per reply. The worker reads a thumbs down into
--        one line of guidance (a `teammate_lessons` row), or one question
--        when it can't tell what the feedback means, or nothing to learn;
--        `learn` says which, and where it stands. A person writes only
--        `none` or `reading` there: the rest is the worker's.
--        Feedback follows its run: whoever may read the run may read it.
--
--        `teammate_lessons.feedback_ids` is the feedback a lesson was read
--        from, beside `draft_ids`.
--
--        Lessons a person already added to Policies move to the list, once:
--        each applied lesson's line comes out of the business profile's
--        policies, which the prompt cut at 80 words, and into the list.
-- =============================================================================

create table app.teammate_instructions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 300),
  -- A person wrote it, or it's a lesson a person OK'd.
  source text not null default 'person' check (source in ('person', 'lesson')),
  lesson_id uuid references app.teammate_lessons (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index teammate_instructions_teammate_idx on app.teammate_instructions (teammate_id, created_at);
create index teammate_instructions_workspace_id_idx on app.teammate_instructions (workspace_id);
create index teammate_instructions_lesson_id_idx on app.teammate_instructions (lesson_id);
create index teammate_instructions_created_by_idx on app.teammate_instructions (created_by);
create index teammate_instructions_updated_by_idx on app.teammate_instructions (updated_by);
create trigger teammate_instructions_updated_at before update on app.teammate_instructions
  for each row execute function private.set_updated_at();
create trigger teammate_instructions_immutable before update on app.teammate_instructions
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'source',
    'lesson_id', 'created_by');

create or replace function private.check_teammate_instruction()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.ai_teammates t
                 where t.id = new.teammate_id and t.workspace_id = new.workspace_id)
     or (new.lesson_id is not null and not exists (
           select 1 from app.teammate_lessons l
           where l.id = new.lesson_id and l.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  if tg_op = 'INSERT' and (select count(*) from app.teammate_instructions i
                           where i.teammate_id = new.teammate_id) >= 50 then
    raise exception 'The AI teammate has 50 instructions, the most it keeps'
      using errcode = '23514', detail = 'instructions_full';
  end if;
  return new;
end $$;
create trigger teammate_instructions_check before insert or update on app.teammate_instructions
  for each row execute function private.check_teammate_instruction();

alter table app.teammate_instructions enable row level security;
create policy teammate_instructions_select on app.teammate_instructions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy teammate_instructions_insert on app.teammate_instructions for insert to authenticated
  with check (private.has_permission(workspace_id, 'ai_team.manage') and created_by = (select auth.uid())
    and updated_by = (select auth.uid()));
create policy teammate_instructions_update on app.teammate_instructions for update to authenticated
  using (private.has_permission(workspace_id, 'ai_team.manage'))
  with check (private.has_permission(workspace_id, 'ai_team.manage') and updated_by = (select auth.uid()));
create policy teammate_instructions_delete on app.teammate_instructions for delete to authenticated
  using (private.has_permission(workspace_id, 'ai_team.manage'));
create policy teammate_instructions_service_all on app.teammate_instructions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, delete on app.teammate_instructions to authenticated;
grant update (body, updated_by, updated_at) on app.teammate_instructions to authenticated;
grant select, insert, update, delete on app.teammate_instructions to service_actor;
revoke all on app.teammate_instructions from anon;

-- ---------- feedback on a reply ----------
create table app.teammate_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  -- The run that wrote the reply, and the message it sent (none for a test, or a reply that wasn't sent).
  run_id uuid not null references app.ai_teammate_runs (id) on delete cascade,
  message_id uuid references app.messages (id) on delete set null,
  is_test boolean not null default false,
  rating text not null check (rating in ('good', 'bad')),
  -- What it should have said, and why.
  better_reply text check (better_reply is null or length(btrim(better_reply)) between 1 and 2000),
  note text check (note is null or length(btrim(note)) between 1 and 500),
  -- What the customer said and what the AI replied, as they were, for the read.
  asked text check (asked is null or length(asked) <= 2000),
  reply text check (reply is null or length(reply) <= 4000),
  -- none: nothing to read (a thumbs up, or nothing said); reading; asking (a question waits for the person);
  -- suggested (lesson_id); nothing (nothing to learn, learn_why says why); failed (the read didn't work).
  learn text not null default 'none'
    check (learn in ('none', 'reading', 'asking', 'suggested', 'nothing', 'failed')),
  learn_why text check (learn_why is null or length(learn_why) <= 500),
  question text check (question is null or length(btrim(question)) between 1 and 200),
  choices text[] not null default '{}'
    check (cardinality(choices) <= 4 and array_position(choices, null) is null
      and length(array_to_string(choices, '')) <= 400),
  answer text check (answer is null or length(btrim(answer)) between 1 and 300),
  lesson_id uuid references app.teammate_lessons (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, created_by),
  check ((learn = 'asking') <= (question is not null)),
  check ((learn = 'suggested') = (lesson_id is not null))
);
create index teammate_feedback_teammate_idx on app.teammate_feedback (teammate_id, created_at desc);
create index teammate_feedback_workspace_id_idx on app.teammate_feedback (workspace_id);
create index teammate_feedback_message_id_idx on app.teammate_feedback (message_id);
create index teammate_feedback_lesson_id_idx on app.teammate_feedback (lesson_id);
create index teammate_feedback_created_by_idx on app.teammate_feedback (created_by);
create trigger teammate_feedback_updated_at before update on app.teammate_feedback
  for each row execute function private.set_updated_at();
create trigger teammate_feedback_immutable before update on app.teammate_feedback
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'run_id',
    'message_id', 'is_test', 'asked', 'reply', 'created_by');

create or replace function private.check_teammate_feedback_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.ai_teammate_runs r
                 where r.id = new.run_id and r.workspace_id = new.workspace_id
                   and r.teammate_id = new.teammate_id and r.is_test = new.is_test)
     or (new.message_id is not null and not exists (
           select 1 from app.messages m
           where m.id = new.message_id and m.workspace_id = new.workspace_id and m.ai_run_id = new.run_id))
     or (new.lesson_id is not null and not exists (
           select 1 from app.teammate_lessons l
           where l.id = new.lesson_id and l.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger teammate_feedback_check_refs before insert or update on app.teammate_feedback
  for each row execute function private.check_teammate_feedback_refs();

alter table app.teammate_feedback enable row level security;
-- It follows its run, as app.ai_teammate_runs' policies decide (20261012020200).
create policy teammate_feedback_select on app.teammate_feedback for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and exists (select 1 from app.ai_teammate_runs r where r.id = teammate_feedback.run_id));
create policy teammate_feedback_insert on app.teammate_feedback for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid())
    and learn in ('none', 'reading') and lesson_id is null
    and exists (select 1 from app.ai_teammate_runs r where r.id = teammate_feedback.run_id));
-- Each person changes only their own, and only to start a read.
create policy teammate_feedback_update on app.teammate_feedback for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid()))
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid())
    and learn in ('none', 'reading') and lesson_id is null);
create policy teammate_feedback_service_all on app.teammate_feedback for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.teammate_feedback to authenticated;
grant update (rating, better_reply, note, learn, learn_why, question, choices, answer, lesson_id, updated_at)
  on app.teammate_feedback to authenticated;
grant select, insert, update, delete on app.teammate_feedback to service_actor;
revoke all on app.teammate_feedback from anon;

-- ---------- the feedback a lesson was read from ----------
alter table app.teammate_lessons
  add column feedback_ids uuid[] not null default '{}' check (cardinality(feedback_ids) <= 20);

-- Saving a lesson adds an instruction (ai_team.manage), and dropping one is the same people's call. Changing what
-- the AI knows when it clashes still needs knowledge.manage, which the command checks.
alter policy teammate_lessons_update on app.teammate_lessons
  using (private.has_permission(workspace_id, 'knowledge.manage')
    or private.has_permission(workspace_id, 'ai_team.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage')
    or private.has_permission(workspace_id, 'ai_team.manage'));

-- ---------- lessons already in Policies move to the list ----------
-- A line of the policies that is an applied lesson's line (as teammate_lesson.apply added it: spaces squashed,
-- maybe after "- " or "• ") comes out of the policies and into the list, oldest first, as that lesson. The rest
-- of the policies stays as it was.
do $$
declare
  p record;
  lines text[];
  kept text[];
  l text;
  clean text;
  v_lesson uuid;
  v_teammate uuid;
  v_by uuid;
  v_at timestamptz;
  moved boolean;
begin
  for p in
    select kp.workspace_id, kp.profile from app.knowledge_profiles kp
    where coalesce(kp.profile ->> 'policies', '') <> ''
      and exists (select 1 from app.teammate_lessons tl
                  where tl.workspace_id = kp.workspace_id and tl.status = 'applied')
  loop
    lines := string_to_array(p.profile ->> 'policies', E'\n');
    kept := '{}';
    moved := false;
    foreach l in array lines loop
      clean := regexp_replace(btrim(regexp_replace(btrim(l), '^[-•]\s*', '')), '\s+', ' ', 'g');
      v_lesson := null;
      if clean <> '' then
        select tl.id, tl.teammate_id, tl.decided_by, tl.decided_at into v_lesson, v_teammate, v_by, v_at
        from app.teammate_lessons tl
        where tl.workspace_id = p.workspace_id and tl.status = 'applied'
          and regexp_replace(btrim(tl.line), '\s+', ' ', 'g') = clean
        order by tl.decided_at
        limit 1;
      end if;
      if v_lesson is null then
        kept := kept || l;
      elsif exists (select 1 from app.teammate_instructions i
                    where i.teammate_id = v_teammate
                      and regexp_replace(btrim(i.body), '\s+', ' ', 'g') = clean) then
        -- The same line twice: once in the list is enough.
        moved := true;
      elsif (select count(*) from app.teammate_instructions i where i.teammate_id = v_teammate) < 50 then
        insert into app.teammate_instructions
          (workspace_id, teammate_id, body, source, lesson_id, created_by, updated_by, created_at, updated_at)
        values (p.workspace_id, v_teammate, left(clean, 300), 'lesson', v_lesson, v_by, v_by,
          coalesce(v_at, now()), coalesce(v_at, now()));
        moved := true;
      else
        kept := kept || l;
      end if;
    end loop;
    if moved then
      update app.knowledge_profiles
      set profile = jsonb_set(profile, '{policies}', to_jsonb(btrim(array_to_string(kept, E'\n'), E' \n')))
      where workspace_id = p.workspace_id;
    end if;
  end loop;
end $$;

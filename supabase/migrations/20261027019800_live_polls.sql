-- =============================================================================
-- Webinars, part 2: live polls
-- (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's answers of 29 October 2026).
--
--        A live poll is a form of mode `poll` (20261027019700): questions and
--        buttons that pop up one at a time in a HandsFreeOS video call.
--
--        - **A call picks its poll** (`video_calls.poll_form_id`), from the
--          session's calendar or by the team.
--        - **Each question asked** is a row of `app.video_call_polls`: open
--          until its time is up, nearly everyone has answered, or the team
--          closes it; or skipped for now. One open at a time in a call.
--        - **Each person's answers** are one form response on their contact
--          (`form_responses.video_call_id`), filled in as the questions come,
--          one answer per question. The worker writes them, as it does every
--          response from outside the business.
--
-- Only widens, except that a sheet the app starts on the phone is never a
-- call's (the phone's insert rule, with the new column).
-- =============================================================================

-- ---------- the poll a call uses ----------
alter table app.video_calls
  add column poll_form_id uuid references app.forms (id) on delete set null;
create index video_calls_poll_form_idx on app.video_calls (poll_form_id) where poll_form_id is not null;
-- The team picks it during the call, like the attendees' cameras.
grant update (poll_form_id) on app.video_calls to authenticated;

-- A call's poll is one of its own business's forms.
create or replace function private.check_video_call_poll_form()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.poll_form_id is not null and not exists (
    select 1 from app.forms f where f.id = new.poll_form_id and f.workspace_id = new.workspace_id
  ) then
    raise exception 'That form belongs to another business' using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger video_calls_poll_form before insert or update of poll_form_id on app.video_calls
  for each row execute function private.check_video_call_poll_form();

-- ---------- each question asked in a call ----------
create table app.video_call_polls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null references app.video_calls (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  -- The published version it was asked from: its wording, and the response's version.
  version_id uuid not null references app.form_versions (id),
  question_id text not null check (question_id ~ '^q_[a-z0-9]{8}$'),
  state text not null default 'open' check (state in ('open', 'closed', 'skipped')),
  -- Who put it up: someone on the team, or the AI hearing the presenter (part 3).
  opened_by text not null default 'team' check (opened_by in ('team', 'ai')),
  opened_by_user_id uuid references app.users (id) on delete set null,
  opened_at timestamptz,
  closes_at timestamptz,
  closed_at timestamptz,
  answers integer not null default 0 check (answers >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'open' or (opened_at is not null and closes_at is not null)),
  unique (video_call_id, form_id, question_id)
);
-- One question up at a time in a call.
create unique index video_call_polls_one_open on app.video_call_polls (video_call_id) where state = 'open';
create index video_call_polls_closing_idx on app.video_call_polls (closes_at) where state = 'open';
create index video_call_polls_workspace_idx on app.video_call_polls (workspace_id);
create index video_call_polls_form_idx on app.video_call_polls (form_id);
create trigger video_call_polls_updated_at before update on app.video_call_polls
  for each row execute function private.set_updated_at();
create trigger video_call_polls_immutable before update on app.video_call_polls
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'video_call_id', 'form_id',
    'question_id');

-- A question belongs to its call's business, and to a version of that call's business's form.
create or replace function private.check_video_call_poll_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.video_calls c where c.id = new.video_call_id and c.workspace_id = new.workspace_id)
     or not exists (select 1 from app.form_versions v
                    where v.id = new.version_id and v.form_id = new.form_id and v.workspace_id = new.workspace_id) then
    raise exception 'That poll belongs to another business' using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger video_call_polls_check_refs before insert or update of version_id on app.video_call_polls
  for each row execute function private.check_video_call_poll_refs();

-- Whoever sees the call sees its questions; the team puts them up, skips and closes them (appointments.write), and
-- the worker counts the answers and closes them when their time is up.
alter table app.video_call_polls enable row level security;
create policy video_call_polls_select on app.video_call_polls for select to authenticated
  using (video_call_id in (select c.id from app.video_calls c));
create policy video_call_polls_insert on app.video_call_polls for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write')
    and video_call_id in (select c.id from app.video_calls c)
    and opened_by = 'team'
    and (opened_by_user_id is null or opened_by_user_id = (select auth.uid()))
    and answers = 0 and closed_at is null);
create policy video_call_polls_update on app.video_call_polls for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
    and video_call_id in (select c.id from app.video_calls c))
  with check (private.has_permission(workspace_id, 'appointments.write')
    and (opened_by_user_id is null or opened_by_user_id = (select auth.uid()) or opened_by = 'ai'));
create policy video_call_polls_service_all on app.video_call_polls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.video_call_polls to authenticated;
grant update (state, opened_by, opened_by_user_id, opened_at, closes_at, closed_at, version_id)
  on app.video_call_polls to authenticated;
grant select, insert, update, delete on app.video_call_polls to service_actor;
revoke all on app.video_call_polls from anon;

-- ---------- each person's answers: one response on their contact ----------
alter table app.form_responses
  add column video_call_id uuid references app.video_calls (id) on delete set null;
-- One sheet per person per poll in a call, which is what settles two answers arriving at once.
create unique index form_responses_one_per_call on app.form_responses (video_call_id, form_id, person_id)
  where video_call_id is not null;
grant select (video_call_id) on app.form_responses to authenticated;

-- A sheet the app starts on the phone is never a call's (0109's rule, with the new column).
alter policy form_responses_insert_from_app on app.form_responses
  with check (
    source = 'app'
    and status = 'in_progress'
    and resume_token_hash is null
    and visitor_hash is null
    and person_id is null
    and lead_id is null
    and invoice_id is null
    and form_link_id is null
    and video_call_id is null
    and private.has_permission(workspace_id, 'records.write')
  );

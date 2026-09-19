-- =============================================================================
-- 0074 · What people answered (M15). A response holds the version it was given
--        on, so the answers still read right after the form is reworded — the
--        same promise lead.record_answers made in M7, kept the same way.
--
--        The answers live twice on purpose. `answers` on the response is what
--        was submitted, whole, in one JSON document: that is what the engine
--        re-checks and what a screen replays. `form_answers` is the same thing
--        one row per question, which is what makes "what did 400 people say to
--        question 3?" a group-by instead of a scan through 400 JSON blobs. The
--        second is written from the first by the worker, in the same
--        transaction, so neither can be the odd one out.
--
--        A response can be half-finished. Chris chose (2026-09-18) that a form
--        may be picked up later, so an unfinished one keeps a resume token
--        (hashed, never stored plain, like every other token here) and turns
--        into a completed one when they get to the end. Anonymous forms keep no
--        customer at all: person_id is simply null, and nothing about who they
--        are is written anywhere.
--
--        Everyone in the business reads responses. Nobody types one in: they
--        arrive through the worker, which is the only thing that writes here.
-- =============================================================================

create type app.form_response_status as enum ('in_progress', 'completed');
-- Where they were when they filled it in. `chat` is the AI teammate asking the same form as a conversation.
create type app.form_source as enum ('link', 'embed', 'chat', 'qr', 'app', 'api');

create table app.form_responses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  -- The version they were actually shown. Publishing a new one never moves a response onto it.
  version_id uuid not null references app.form_versions (id),
  status app.form_response_status not null default 'in_progress',
  source app.form_source not null default 'link',
  -- Null on an anonymous form, and until a half-finished one has said who they are.
  person_id uuid references app.people (id) on delete set null,
  -- What the submission opened, if anything.
  lead_id uuid references app.leads (id) on delete set null,
  invoice_id uuid references app.invoices (id) on delete set null,
  -- The answers as submitted, already pruned to the questions that were showing.
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 262144),
  -- What the form worked out: the calculations by id, and the quiz's score.
  calculations jsonb not null default '{}'::jsonb check (jsonb_typeof(calculations) = 'object'),
  score numeric(12, 2),
  score_possible numeric(12, 2),
  score_percent integer check (score_percent is null or score_percent between 0 and 100),
  passed boolean,
  -- The result they landed on (core's r_ id inside the version), so the screen can be shown again.
  result_id text check (result_id is null or result_id ~ '^r_[a-z0-9]{8}$'),
  -- Save and resume: the hash of the token in their link. Never the token itself.
  resume_token_hash bytea check (resume_token_hash is null or length(resume_token_hash) between 16 and 64),
  resume_expires_at timestamptz,
  -- Anti-spam and "is this the same person filling it in twice", kept as a hash with no address in it.
  visitor_hash bytea check (visitor_hash is null or length(visitor_hash) between 16 and 64),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'completed') = (completed_at is not null)),
  check ((resume_token_hash is null) = (resume_expires_at is null)),
  -- A half-finished response has worked nothing out yet.
  check (status = 'completed' or (score is null and passed is null and result_id is null))
);
-- The Results screen, newest first.
create index form_responses_list_idx on app.form_responses (form_id, completed_at desc nulls last, id desc);
create index form_responses_workspace_idx on app.form_responses (workspace_id, created_at desc);
-- A customer's timeline, and "has this person already answered?".
create index form_responses_person_idx on app.form_responses (person_id, completed_at desc) where person_id is not null;
create index form_responses_version_idx on app.form_responses (version_id);
create index form_responses_lead_idx on app.form_responses (lead_id) where lead_id is not null;
create index form_responses_invoice_idx on app.form_responses (invoice_id) where invoice_id is not null;
-- Picking up where they left off.
create unique index form_responses_resume_unique on app.form_responses (resume_token_hash)
  where resume_token_hash is not null;
-- "One response per customer": the index is what settles two tabs submitting at once, not a check in code.
create unique index form_responses_one_per_person on app.form_responses (form_id, person_id)
  where person_id is not null and status = 'completed';
create trigger form_responses_updated_at before update on app.form_responses
  for each row execute function private.set_updated_at();
create trigger form_responses_immutable before update on app.form_responses
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'form_id', 'version_id',
    'source', 'started_at');

-- ---------- one row per answer, which is what the Results screen counts ----------
create table app.form_answers (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  response_id uuid not null references app.form_responses (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  question_id text not null check (question_id ~ '^q_[a-z0-9]{8}$'),
  -- Copied in at the moment they answered, so a reworded question doesn't rewrite history.
  question_title text not null check (length(question_title) between 1 and 300),
  question_type text not null check (question_type ~ '^[a-z_]{1,20}$'),
  -- The answer as given, whatever shape that is.
  value jsonb not null default 'null'::jsonb check (pg_column_size(value) <= 65536),
  -- The same answer in the three shapes a summary needs: an average, a word cloud, a bar per choice.
  number_value numeric(16, 4),
  text_value text check (text_value is null or length(text_value) <= 5000),
  choice_ids text[] not null default '{}' check (cardinality(choice_ids) <= 60),
  -- What those choices were called when they picked them.
  choice_labels text[] not null default '{}' check (cardinality(choice_labels) <= 60),
  answered_at timestamptz not null default now(),
  primary key (response_id, question_id)
);
-- "What did everyone say to question 3?" — the whole point of this table.
create index form_answers_question_idx on app.form_answers (form_id, question_id);
create index form_answers_choices_idx on app.form_answers using gin (choice_ids);
create index form_answers_workspace_idx on app.form_answers (workspace_id);

-- An answer belongs to its response's workspace and form; a response to its form's workspace.
create or replace function private.check_form_response_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_form_workspace uuid;
  v_response_form uuid;
  v_response_workspace uuid;
begin
  if tg_table_name = 'form_responses' then
    select f.workspace_id into v_form_workspace from app.forms f where f.id = new.form_id;
    if v_form_workspace is distinct from new.workspace_id then
      raise exception 'That form belongs to another business' using errcode = '23514', detail = 'cross_workspace';
    end if;
  else
    select r.form_id, r.workspace_id into v_response_form, v_response_workspace
    from app.form_responses r where r.id = new.response_id;
    if v_response_form is distinct from new.form_id or v_response_workspace is distinct from new.workspace_id then
      raise exception 'That answer belongs to another response' using errcode = '23514', detail = 'cross_response';
    end if;
  end if;
  return new;
end $$;
create trigger form_responses_check_refs before insert on app.form_responses
  for each row execute function private.check_form_response_refs();
create trigger form_answers_check_refs before insert on app.form_answers
  for each row execute function private.check_form_response_refs();

-- ---------- RLS: the business reads its answers; only the worker writes them ----------
alter table app.form_responses enable row level security;
alter table app.form_answers enable row level security;

create policy form_responses_select on app.form_responses for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Deleting one (a test response, or a customer asking to be forgotten) needs forms.manage.
create policy form_responses_delete on app.form_responses for delete to authenticated
  using (private.has_permission(workspace_id, 'forms.manage'));
create policy form_responses_service_all on app.form_responses for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy form_answers_select on app.form_answers for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy form_answers_service_all on app.form_answers for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- The token hashes are the worker's business, and a response is never edited by hand.
grant select (id, workspace_id, form_id, version_id, status, source, person_id, lead_id, invoice_id,
  answers, calculations, score, score_possible, score_percent, passed, result_id, started_at,
  completed_at, created_at, updated_at) on app.form_responses to authenticated;
grant delete on app.form_responses to authenticated;
grant select on app.form_answers to authenticated;
grant select, insert, update, delete on app.form_responses, app.form_answers to service_actor;

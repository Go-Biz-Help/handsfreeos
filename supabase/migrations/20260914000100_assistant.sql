-- =============================================================================
-- 0014 · The Assistant. A person's chats with HandsFreeOS: threads, messages,
--        the runs that answered them (with token use for the daily budget), and
--        every tool call a run made, including the ones waiting for the
--        person's OK. Chats are private to their person. The worker writes
--        them; the person reads them through the API and may rename or archive
--        a thread.
--        The worker runs the Assistant's tools as the signed-in person (the same
--        commands, permission checks and RLS as a click), so it may now switch
--        into `authenticated` inside a transaction, the way the API does. It
--        already acts as the system in every tenant, so this adds no reach.
-- =============================================================================

grant authenticated to hfos_worker;

create type app.assistant_role as enum ('user', 'assistant');
create type app.assistant_run_status as enum ('running', 'done', 'failed', 'cancelled');
create type app.assistant_autonomy as enum ('auto', 'confirm');
create type app.assistant_tool_status as enum ('done', 'failed', 'awaiting_confirmation', 'confirmed', 'cancelled', 'expired');

-- ---------- threads: one chat, private to its person ----------
create table app.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  title text not null default 'New chat' check (length(btrim(title)) between 1 and 200),
  last_message_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_threads_list_idx on app.assistant_threads (workspace_id, user_id, last_message_at desc, id desc)
  where archived_at is null;
create trigger assistant_threads_updated_at before update on app.assistant_threads for each row execute function private.set_updated_at();
create trigger assistant_threads_immutable before update on app.assistant_threads for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id');

-- ---------- runs: one answer to one question, with what it cost ----------
create table app.assistant_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  thread_id uuid not null references app.assistant_threads (id) on delete cascade,
  model text not null check (length(model) between 1 and 100),
  status app.assistant_run_status not null default 'running',
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  tool_rounds integer not null default 0 check (tool_rounds >= 0),
  correlation_id uuid not null,
  error text check (error is null or length(error) <= 2000),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One question at a time per person (the worker fails a run left behind by a crash before starting another).
create unique index assistant_runs_one_running on app.assistant_runs (user_id) where status = 'running';
create index assistant_runs_budget_idx on app.assistant_runs (workspace_id, started_at);
create index assistant_runs_thread_idx on app.assistant_runs (thread_id, started_at);
create trigger assistant_runs_updated_at before update on app.assistant_runs for each row execute function private.set_updated_at();
create trigger assistant_runs_immutable before update on app.assistant_runs for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'thread_id');

-- ---------- messages: what the person asked and what the Assistant said, with its cards ----------
create table app.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  thread_id uuid not null references app.assistant_threads (id) on delete cascade,
  role app.assistant_role not null,
  text text not null default '' check (length(text) <= 20000),
  cards jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array'),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  run_id uuid references app.assistant_runs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index assistant_messages_thread_idx on app.assistant_messages (thread_id, created_at, id);

-- ---------- tool calls: every command or query a run used, and the ones waiting for an OK ----------
create table app.assistant_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  thread_id uuid not null references app.assistant_threads (id) on delete cascade,
  run_id uuid not null references app.assistant_runs (id) on delete cascade,
  provider_call_id text check (provider_call_id is null or length(provider_call_id) <= 200),
  tool text not null check (tool ~ '^[a-z][a-z_]{0,63}$'),
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  autonomy app.assistant_autonomy not null,
  status app.assistant_tool_status not null,
  result jsonb check (result is null or jsonb_typeof(result) in ('object', 'array')),
  error text check (error is null or length(error) <= 2000),
  command text check (command is null or length(command) <= 100),
  correlation_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_tool_calls_run_idx on app.assistant_tool_calls (run_id, created_at);
create index assistant_tool_calls_waiting_idx on app.assistant_tool_calls (thread_id) where status = 'awaiting_confirmation';
create trigger assistant_tool_calls_updated_at before update on app.assistant_tool_calls for each row execute function private.set_updated_at();
create trigger assistant_tool_calls_immutable before update on app.assistant_tool_calls for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'thread_id', 'run_id', 'tool', 'autonomy');

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'assistant.use'), ('admin', 'assistant.use'), ('member', 'assistant.use');

-- ---------- RLS: a person sees only their own chats; the worker writes them ----------
alter table app.assistant_threads enable row level security;
alter table app.assistant_runs enable row level security;
alter table app.assistant_messages enable row level security;
alter table app.assistant_tool_calls enable row level security;

create policy assistant_threads_select on app.assistant_threads for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_threads_update on app.assistant_threads for update to authenticated
  using (user_id = (select auth.uid()) and private.has_permission(workspace_id, 'assistant.use'))
  with check (user_id = (select auth.uid()));
create policy assistant_threads_service_all on app.assistant_threads for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy assistant_runs_select on app.assistant_runs for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_runs_service_all on app.assistant_runs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy assistant_messages_select on app.assistant_messages for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_messages_service_all on app.assistant_messages for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy assistant_tool_calls_select on app.assistant_tool_calls for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_tool_calls_service_all on app.assistant_tool_calls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select on app.assistant_threads, app.assistant_runs, app.assistant_messages, app.assistant_tool_calls to authenticated;
-- A person renames or archives a thread; nothing else about a chat is theirs to change.
grant update (title, archived_at) on app.assistant_threads to authenticated;

grant select, insert, update on app.assistant_threads, app.assistant_runs, app.assistant_tool_calls to service_actor;
grant select, insert on app.assistant_messages to service_actor;
revoke all on app.assistant_threads, app.assistant_runs, app.assistant_messages, app.assistant_tool_calls from anon;

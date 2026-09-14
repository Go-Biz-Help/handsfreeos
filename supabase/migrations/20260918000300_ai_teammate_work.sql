-- =============================================================================
-- 0032 · The AI teammate's work. Each time the teammate answers (or tries
--        to) is a run, the blueprint's "AI Run": what started it, the
--        customer messages it answered, what it wrote, a summary, the
--        knowledge it used, the checks its reply went through, the model,
--        tokens and tool steps. One run per conversation at a time. Each tool
--        call is logged once under (run_id, provider_call_id), so a retried
--        job never runs a tool twice. While the teammate trains, everything a
--        run would do that reaches the customer becomes one draft a person
--        approves, edits or rejects; something that needs a manager's OK in
--        any mode (a discount) is a draft too. A draft is decided once. AI
--        usage now names the teammate and run it paid for. Everyone reads
--        runs and tool calls; people who work the inbox read drafts and
--        decide replies, approvals need ai_team.manage, and only the worker
--        writes the rest.
-- =============================================================================

-- ---------- runs: one answer (or one try) in one conversation ----------
create table app.ai_teammate_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  -- None yet for a first message to a new lead (sending it starts the conversation), and none for a test.
  conversation_id uuid references app.conversations (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  -- What started it: the event ("message.received", "lead.created", "conversation.handed_to_ai") or the job
  -- ("follow_up", "test").
  triggered_by text not null check (length(triggered_by) between 1 and 80 and triggered_by ~ '^[a-z_]+(\.[a-z_]+)*$'),
  -- running; done (what it did is `outcome`); superseded (a person replied, the customer wrote again, or the
  -- conversation changed hands before it finished); failed.
  status text not null default 'running' check (status in ('running', 'done', 'superseded', 'failed')),
  outcome text check (outcome is null or outcome in ('replied', 'drafted', 'handed_off', 'no_reply')),
  -- The test console: look-ups are real; nothing is sent or changed.
  is_test boolean not null default false,
  -- The conversation's ai_epoch when it started.
  ai_epoch integer check (ai_epoch is null or ai_epoch >= 0),
  -- The customer messages it answered: its conversation's, after ai_answered_through.
  message_ids uuid[] not null default '{}'
    check (cardinality(message_ids) <= 100 and array_position(message_ids, null) is null),
  -- What it wrote (a test's too, and a reply the safety checks replaced), and a summary for the Activity view.
  reply_text text check (reply_text is null or length(reply_text) <= 10000),
  summary text check (summary is null or length(summary) <= 2000),
  -- The knowledge items it used ([{itemId, title}]; items are archived, never deleted) and the checks its reply
  -- went through.
  knowledge jsonb not null default '[]'::jsonb check (jsonb_typeof(knowledge) = 'array' and pg_column_size(knowledge) <= 65536),
  checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array' and pg_column_size(checks) <= 65536),
  -- Totals for the Activity view. The daily budget sums ai_usage (a row per model call), never these.
  model text check (model is null or length(model) between 1 and 100),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  tool_steps integer not null default 0 check (tool_steps >= 0),
  error text check (error is null or length(error) <= 2000),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'running') = (ended_at is null)),
  check (status <> 'running' or outcome is null)
);
-- One run per conversation at a time: a second job for the same conversation inserts nothing and moves on
-- (INSERT … ON CONFLICT DO NOTHING).
create unique index ai_teammate_runs_one_running on app.ai_teammate_runs (conversation_id) where status = 'running';
-- The Activity view, newest first.
create index ai_teammate_runs_activity_idx on app.ai_teammate_runs (workspace_id, started_at desc);
create trigger ai_teammate_runs_updated_at before update on app.ai_teammate_runs for each row execute function private.set_updated_at();
create trigger ai_teammate_runs_immutable before update on app.ai_teammate_runs for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'triggered_by', 'is_test');

-- ---------- tool calls: each tool a run used, once ----------
-- The worker records a call before running it (INSERT … ON CONFLICT (run_id, provider_call_id) DO NOTHING),
-- so a retried job finds the call already made instead of making it again.
create table app.ai_teammate_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  run_id uuid not null references app.ai_teammate_runs (id) on delete cascade,
  -- The model's id for the call.
  provider_call_id text not null check (length(provider_call_id) between 1 and 200),
  tool text not null check (tool ~ '^[a-z][a-z_]{0,63}$'),
  arguments jsonb not null default '{}'::jsonb
    check (jsonb_typeof(arguments) = 'object' and pg_column_size(arguments) <= 65536),
  -- running; done; held (a customer-facing action waiting in a draft while the teammate trains); simulated
  -- (the test console); refused (not allowed, or its input was wrong); failed.
  status text not null default 'running' check (status in ('running', 'done', 'held', 'simulated', 'refused', 'failed')),
  result jsonb check (result is null or (jsonb_typeof(result) in ('object', 'array') and pg_column_size(result) <= 65536)),
  error text check (error is null or length(error) <= 2000),
  -- The kernel command it ran, if any.
  command text check (command is null or length(command) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, provider_call_id)
);
create trigger ai_teammate_tool_calls_updated_at before update on app.ai_teammate_tool_calls for each row execute function private.set_updated_at();
create trigger ai_teammate_tool_calls_immutable before update on app.ai_teammate_tool_calls for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'run_id', 'provider_call_id', 'tool');

-- ---------- drafts: what waits for a person's OK ----------
-- reply: while the teammate trains, everything one run would do that reaches the customer (the message, and
-- any booking, reschedule or cancellation) is one draft, so nothing is half done when it is rejected;
-- internal work (notes, tasks, answers, stage moves) already ran. approval: something that needs a manager's
-- OK in any mode (a discount). Decided once: a second click matches no pending row.
create table app.ai_teammate_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  -- The run that made it (runs may be pruned; the draft stays).
  run_id uuid references app.ai_teammate_runs (id) on delete set null,
  -- None yet for a first message to a new lead: approving it starts the conversation.
  conversation_id uuid references app.conversations (id) on delete cascade,
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  kind text not null check (kind in ('reply', 'approval')),
  status app.workflow_approval_status not null default 'pending',
  -- What approving does (the message and the held actions), as the person saw it. It never changes.
  preview jsonb not null default '{}'::jsonb check (jsonb_typeof(preview) = 'object' and pg_column_size(preview) <= 131072),
  -- The approver's changes: an approval with edits counts as edited.
  edits jsonb check (edits is null or (jsonb_typeof(edits) = 'object' and pg_column_size(edits) <= 131072)),
  reason text check (reason is null or length(reason) <= 1000),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  -- Where it was decided. 'system' covers expiry and a draft the customer's next message superseded.
  via text check (via is null or via in ('web', 'email', 'assistant', 'system')),
  -- A pending draft past this hands the conversation to a person.
  expires_at timestamptz,
  -- The clientId the approved message goes out with, fixed when the draft is made: approving twice, or a
  -- retry, still sends once.
  client_id text not null check (length(client_id) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'pending') = (decided_at is null))
);
-- At most one pending reply per conversation: a new one supersedes the old one first.
create unique index ai_teammate_drafts_one_pending_reply on app.ai_teammate_drafts (conversation_id)
  where status = 'pending' and kind = 'reply';
-- The Approvals page and Home's count.
create index ai_teammate_drafts_pending_idx on app.ai_teammate_drafts (workspace_id, created_at desc) where status = 'pending';
-- The expiry sweep.
create index ai_teammate_drafts_expiry_idx on app.ai_teammate_drafts (expires_at) where status = 'pending';
create trigger ai_teammate_drafts_updated_at before update on app.ai_teammate_drafts for each row execute function private.set_updated_at();
create trigger ai_teammate_drafts_immutable before update on app.ai_teammate_drafts for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'conversation_id', 'kind', 'preview', 'client_id');

-- ---------- messages: the run that wrote one and the draft that sent it ----------
alter table app.messages
  add constraint messages_ai_run_id_fkey foreign key (ai_run_id) references app.ai_teammate_runs (id) on delete set null,
  add constraint messages_ai_draft_id_fkey foreign key (ai_draft_id) references app.ai_teammate_drafts (id) on delete set null;

-- ---------- AI usage: the teammate's calls count in the same daily limit ----------
-- source 'teammate' rows name the teammate (for its share of the limit) and the run.
alter table app.ai_usage
  add column teammate_id uuid references app.ai_teammates (id) on delete set null,
  -- Runs may be pruned; the usage stays and still counts.
  add column teammate_run_id uuid references app.ai_teammate_runs (id) on delete set null;

-- Foreign keys don't see RLS: keep a row's workflow, run, teammate and teammate run inside its workspace, and
-- a teammate run with its own teammate.
create or replace function private.check_ai_usage_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.workflow_id is not null and not exists (
        select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id))
     or (new.run_id is not null and not exists (
        select 1 from app.workflow_runs r where r.id = new.run_id and r.workspace_id = new.workspace_id))
     or (new.teammate_id is not null and not exists (
        select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id))
     or (new.teammate_run_id is not null and not exists (
        select 1 from app.ai_teammate_runs r
        where r.id = new.teammate_run_id and r.workspace_id = new.workspace_id and r.teammate_id = new.teammate_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- ---------- references stay inside the workspace, whoever writes ----------
-- An update once the workspace is gone is its deletion cascading (a foreign key clearing a column on the way
-- out), and is let through.
create or replace function private.check_ai_teammate_work_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'ai_teammate_runs' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id)
      and (new.conversation_id is null or exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      -- The batch is its own conversation's messages. Checked when the list is written, not when a deleted
      -- conversation clears conversation_id.
      and ((tg_op = 'UPDATE' and new.message_ids = old.message_ids) or not exists (
        select 1 from unnest(new.message_ids) as b (id)
        where not exists (
          select 1 from app.messages m
          where m.id = b.id and m.workspace_id = new.workspace_id and m.conversation_id = new.conversation_id)));
  elsif tg_table_name = 'ai_teammate_tool_calls' then
    v_ok := exists (select 1 from app.ai_teammate_runs r where r.id = new.run_id and r.workspace_id = new.workspace_id);
  elsif tg_table_name = 'ai_teammate_drafts' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id)
      and (new.run_id is null or exists (
        select 1 from app.ai_teammate_runs r
        where r.id = new.run_id and r.workspace_id = new.workspace_id and r.teammate_id = new.teammate_id))
      and (new.conversation_id is null or exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.decided_by is null or private.workspace_has_user(new.workspace_id, new.decided_by));
  elsif tg_table_name = 'messages' then
    v_ok := (new.ai_run_id is null or exists (
        select 1 from app.ai_teammate_runs r where r.id = new.ai_run_id and r.workspace_id = new.workspace_id))
      and (new.ai_draft_id is null or exists (
        select 1 from app.ai_teammate_drafts d where d.id = new.ai_draft_id and d.workspace_id = new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger ai_teammate_runs_check_refs before insert or update of conversation_id, person_id, lead_id, message_ids
  on app.ai_teammate_runs for each row execute function private.check_ai_teammate_work_refs();
create trigger ai_teammate_tool_calls_check_refs before insert on app.ai_teammate_tool_calls
  for each row execute function private.check_ai_teammate_work_refs();
create trigger ai_teammate_drafts_check_refs before insert or update of run_id, person_id, lead_id, decided_by
  on app.ai_teammate_drafts for each row execute function private.check_ai_teammate_work_refs();
create trigger messages_check_ai_work_refs before insert or update of ai_run_id, ai_draft_id on app.messages
  for each row execute function private.check_ai_teammate_work_refs();

-- ---------- RLS: the whole team reads runs; the inbox decides drafts; the worker does the rest ----------
alter table app.ai_teammate_runs enable row level security;
alter table app.ai_teammate_tool_calls enable row level security;
alter table app.ai_teammate_drafts enable row level security;

-- Only the worker runs the teammate.
create policy ai_teammate_runs_select on app.ai_teammate_runs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_teammate_runs_service_all on app.ai_teammate_runs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy ai_teammate_tool_calls_select on app.ai_teammate_tool_calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_teammate_tool_calls_service_all on app.ai_teammate_tool_calls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Everyone who works the inbox reads drafts. A person decides a pending one, once, in their own name: a reply
-- with inbox.use, an approval with ai_team.manage. Cancelling one is deciding it too (a person who takes the
-- conversation over drops its pending reply). Only the worker makes drafts, and it expires them.
create policy ai_teammate_drafts_select on app.ai_teammate_drafts for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'));
create policy ai_teammate_drafts_update on app.ai_teammate_drafts for update to authenticated
  using (status = 'pending'
    and private.has_permission(workspace_id, case when kind = 'reply' then 'inbox.use' else 'ai_team.manage' end))
  with check (status in ('approved', 'rejected', 'cancelled') and decided_by = (select auth.uid()) and via in ('web', 'assistant')
    and private.has_permission(workspace_id, case when kind = 'reply' then 'inbox.use' else 'ai_team.manage' end));
create policy ai_teammate_drafts_service_all on app.ai_teammate_drafts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
-- private.check_ai_usage_refs keeps the privileges 0023 gave it.
revoke all on function private.check_ai_teammate_work_refs() from public;
grant execute on function private.check_ai_teammate_work_refs() to authenticated, service_actor;

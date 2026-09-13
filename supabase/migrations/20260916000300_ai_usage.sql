-- =============================================================================
-- 0023 · AI usage outside the Assistant. Workflow AI steps, the AI builder
--        and the knowledge base ("Try it", website scans) share the
--        Assistant's one daily limit per workspace. The Assistant's own tokens
--        stay on assistant_runs; everything else lands here, and the daily
--        total sums both. The worker writes it; everyone in the workspace may
--        read it.
-- =============================================================================

create type app.ai_usage_source as enum ('workflow', 'builder', 'knowledge');

create table app.ai_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source app.ai_usage_source not null,
  -- The person who asked (the builder, "Try it"); null for a workflow step.
  user_id uuid references app.users (id) on delete set null,
  workflow_id uuid references app.workflows (id) on delete set null,
  -- Runs are pruned; the usage stays and still counts.
  run_id uuid references app.workflow_runs (id) on delete set null,
  step_key text check (step_key is null or length(step_key) <= 100),
  model text not null check (length(model) between 1 and 100),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  created_at timestamptz not null default now()
);
-- The daily total.
create index ai_usage_budget_idx on app.ai_usage (workspace_id, created_at);
create index ai_usage_user_id_idx on app.ai_usage (user_id);
create index ai_usage_workflow_id_idx on app.ai_usage (workflow_id);
create index ai_usage_run_id_idx on app.ai_usage (run_id);

-- Foreign keys don't see RLS: keep a row's workflow and run inside its workspace.
create or replace function private.check_ai_usage_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.workflow_id is not null and not exists (
        select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id))
     or (new.run_id is not null and not exists (
        select 1 from app.workflow_runs r where r.id = new.run_id and r.workspace_id = new.workspace_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger ai_usage_check_refs before insert on app.ai_usage for each row execute function private.check_ai_usage_refs();

-- ---------- RLS: a ledger the worker appends to ----------
alter table app.ai_usage enable row level security;

create policy ai_usage_select on app.ai_usage for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_usage_service_all on app.ai_usage for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- No update or delete for anyone: a row is what was spent.
grant select on app.ai_usage to authenticated;
grant select, insert on app.ai_usage to service_actor;
revoke all on app.ai_usage from anon;

revoke all on function private.check_ai_usage_refs() from public;
grant execute on function private.check_ai_usage_refs() to authenticated, service_actor;

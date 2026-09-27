-- =============================================================================
-- A phone keeps the tasks still to do, and the ones done in the last 90 days.
--
--        business_v1 sent every task a business ever had, the finished ones
--        with the rest: thousands a year for a busy business, sent again on
--        every full recopy and once per business an agency owner keeps
--        offline. Tasks now carry sync_window (0056) like appointments: in
--        the window while open or done no more than 90 days ago, worked out
--        on every write, so a task reopened comes back at once; the nightly
--        sweep turns it off for the ones that aged out. Writing the flag
--        isn't an edit: updated_at stays put.
-- =============================================================================

alter table app.tasks add column if not exists sync_window boolean not null default true;

-- In the window while open, or done within 90 days. Nothing reads it but the phone's stream.
create or replace function private.task_sync_window()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sync_window := new.done_at is null or new.done_at >= now() - interval '90 days';
  return new;
end $$;
drop trigger if exists tasks_sync_window on app.tasks;
create trigger tasks_sync_window before insert or update on app.tasks
  for each row execute function private.task_sync_window();

-- Bookkeeping isn't an edit (0056's pair of updated_at triggers).
drop trigger if exists tasks_updated_at on app.tasks;
create trigger tasks_updated_at before update on app.tasks for each row
  when (old.sync_window is not distinct from new.sync_window)
  execute function private.set_updated_at();
drop trigger if exists tasks_updated_at_bookkeeping on app.tasks;
create trigger tasks_updated_at_bookkeeping before update on app.tasks for each row
  when (old.sync_window is distinct from new.sync_window)
  execute function private.set_updated_at_unless_bookkeeping();

-- The worker's nightly job, as 0056 wrote it, and tasks done more than 90 days ago.
create or replace function private.sync_window_sweep(p_workspace uuid, p_limit integer default 10000)
returns table (table_name text, hidden integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_year constant timestamptz := now() - interval '12 months';
  v_quarter constant timestamptz := now() - interval '90 days';
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 10000), 1000000));
  v_count integer;
begin
  if p_workspace is null or p_workspace is distinct from private.system_scope_workspace() then
    raise exception 'The sweep runs for the business the worker is scoped to'
      using errcode = '42501', detail = 'sync_window_scope';
  end if;

  update app.messages m set sync_window = false
  where m.id in (
    select x.id from app.messages x
    where x.workspace_id = p_workspace and x.sync_window and x.occurred_at < v_year
      and not exists (select 1 from app.conversations c where c.id = x.conversation_id and c.status <> 'closed')
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'messages'; hidden := v_count; return next;

  update app.calls c set sync_window = false
  where c.id in (
    select x.id from app.calls x
    where x.workspace_id = p_workspace and x.sync_window and x.started_at < v_year
      and not exists (select 1 from app.conversations v where v.id = x.conversation_id and v.status <> 'closed')
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'calls'; hidden := v_count; return next;

  update app.activities a set sync_window = false
  where a.id in (
    select x.id from app.activities x
    where x.workspace_id = p_workspace and x.sync_window and x.occurred_at < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'activities'; hidden := v_count; return next;

  -- The appointments' own trigger works the flag out from ends_at; the update only asks it to.
  update app.appointments a set sync_window = false
  where a.id in (
    select x.id from app.appointments x
    where x.workspace_id = p_workspace and x.sync_window and x.starts_at < v_quarter and x.ends_at < v_quarter
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'appointments'; hidden := v_count; return next;

  update app.estimates e set sync_window = false
  where e.id in (
    select x.id from app.estimates x
    where x.workspace_id = p_workspace and x.sync_window
      and x.status in ('accepted', 'declined', 'expired', 'void')
      and coalesce(x.voided_at, x.declined_at, x.accepted_at, x.expires_on::timestamp at time zone 'UTC', x.updated_at) < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'estimates'; hidden := v_count; return next;

  update app.invoices i set sync_window = false
  where i.id in (
    select x.id from app.invoices x
    where x.workspace_id = p_workspace and x.sync_window and x.status in ('paid', 'void')
      and coalesce(x.voided_at, x.paid_at, x.updated_at) < v_year
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'invoices'; hidden := v_count; return next;

  -- Like appointments: the tasks' own trigger works the flag out from done_at.
  update app.tasks t set sync_window = false
  where t.id in (
    select x.id from app.tasks x
    where x.workspace_id = p_workspace and x.sync_window and x.done_at < v_quarter
    limit v_limit);
  get diagnostics v_count = row_count;
  table_name := 'tasks'; hidden := v_count; return next;
end $$;

-- The tasks done before the window, today. The trigger works each one out; only the ones it hides are written.
update app.tasks t set sync_window = false
where t.sync_window and t.done_at < now() - interval '90 days';

revoke all on function private.task_sync_window(), private.sync_window_sweep(uuid, integer) from public;
grant execute on function private.task_sync_window() to authenticated, service_actor;
grant execute on function private.sync_window_sweep(uuid, integer) to service_actor;

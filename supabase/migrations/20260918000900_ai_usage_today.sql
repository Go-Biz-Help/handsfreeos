-- =============================================================================
-- 0038 · Today's AI use for a whole business. The daily AI limit adds up the
--        Assistant's runs and app.ai_usage since midnight in the business's
--        time zone (apps/worker/src/ai/budget.ts). A person sees only their
--        own Assistant chats, so the AI teammate's pages ask this function for
--        the total instead: the budget's sources, day boundary and token
--        columns, as one number that says nothing about who used what.
--        A signed-in person gets it only for a business they belong to, and
--        the worker only for the business it is scoped to. Anyone else is
--        refused.
-- =============================================================================

create or replace function private.ai_tokens_today(p_workspace uuid)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_since timestamptz;
  v_total bigint;
begin
  -- A definer function runs as its owner, so current_user can't tell callers apart. A person is known by
  -- their JWT (auth.uid()) and the businesses it gives them; the worker has no JWT and a system scope.
  if p_workspace is null or not coalesce(
    p_workspace in (select private.accessible_workspace_ids())
    or ((select auth.uid()) is null and p_workspace = private.system_scope_workspace()),
    false
  ) then
    raise exception 'Only the business''s own people can read its AI use'
      using errcode = '42501', detail = 'ai_usage_forbidden';
  end if;
  select w.timezone into v_tz from app.workspaces w where w.id = p_workspace;
  v_tz := coalesce(v_tz, 'UTC');
  v_since := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  select
    coalesce((select sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)
      from app.assistant_runs r where r.workspace_id = p_workspace and r.started_at >= v_since), 0)
    + coalesce((select sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
      from app.ai_usage u where u.workspace_id = p_workspace and u.created_at >= v_since), 0)
    into v_total;
  return v_total;
end $$;

revoke all on function private.ai_tokens_today(uuid) from public;
grant execute on function private.ai_tokens_today(uuid) to authenticated, service_actor;

-- =============================================================================
-- A backup for the AI: OpenAI answers when Claude is in trouble.
--
--        Every AI feature runs on Claude. When Claude is down or slow,
--        the worker sends the same requests to OpenAI instead, and comes
--        back to Claude once it's well again. One row says which is
--        answering and why, so every worker machine follows the same
--        choice and support can see it in /admin.
--
--        The worker writes the choice: a check every 5 minutes reads
--        Claude's status page, and calls that fail in a row switch at
--        once. Support can pin it on either one from /admin (`mode`);
--        `private.set_ai_provider_mode` checks the staff permission itself
--        and writes past the policies. Nobody else writes it.
-- =============================================================================

create table platform.ai_provider (
  id boolean primary key default true constraint ai_provider_one_row check (id),
  -- auto follows `active`; claude and openai pin it there whatever the checks say.
  mode text not null default 'auto' constraint ai_provider_mode_check
    check (mode in ('auto', 'claude', 'openai')),
  -- Who answers while the mode is auto.
  active text not null default 'claude' constraint ai_provider_active_check
    check (active in ('claude', 'openai')),
  -- Why it's on OpenAI: Claude's status page said so, or Claude's answers kept failing.
  reason text constraint ai_provider_reason_check check (reason in ('status', 'errors')),
  -- What Claude's status page last said about the Claude API (operational, degraded_performance, …).
  claude_status text,
  -- Checks in a row that found Claude well, while on OpenAI: two bring it back.
  good_checks integer not null default 0 constraint ai_provider_good_checks_check check (good_checks >= 0),
  checked_at timestamptz,
  switched_at timestamptz,
  mode_set_by uuid references app.users (id) on delete set null,
  mode_set_at timestamptz,
  constraint ai_provider_reason_when_openai check (active = 'openai' or reason is null)
);

comment on table platform.ai_provider is
  'Which AI answers: Claude, or OpenAI while Claude is in trouble. One row, written by the worker and by support''s switch in /admin.';

create index ai_provider_mode_set_by_idx on platform.ai_provider (mode_set_by);

insert into platform.ai_provider default values;

-- Staff-only. It says what it was, so pressing the same button twice is visibly a no-op.
create or replace function private.set_ai_provider_mode(p_mode text)
returns table (was text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was text;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'Only a HandsFreeOS admin can change which AI answers. Ask one of them.'
      using errcode = '42501', detail = 'ai_provider_is_ours';
  end if;
  select p.mode into v_was from platform.ai_provider p for update;
  -- A repeat keeps who set it, and when.
  update platform.ai_provider
    set mode = p_mode, mode_set_by = auth.uid(), mode_set_at = now()
    where mode is distinct from p_mode;
  return query select v_was, v_was is distinct from p_mode;
end $$;

revoke execute on function private.set_ai_provider_mode(text) from public;
grant execute on function private.set_ai_provider_mode(text) to authenticated;

-- ---------- row level security ----------
alter table platform.ai_provider enable row level security;

-- Staff who watch the platform's health see it; only the worker writes it, and support through the function.
create policy ai_provider_read on platform.ai_provider for select to authenticated
  using ((select private.staff_can('platform.health.read')));
create policy ai_provider_service on platform.ai_provider for all to service_actor
  using (true) with check (true);

grant select on platform.ai_provider to authenticated;
grant select, update on platform.ai_provider to service_actor;
revoke all on platform.ai_provider from anon;

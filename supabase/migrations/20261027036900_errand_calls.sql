-- The AI teammate calls a supplier for someone (the owner, 25 Nov 2026: "would calling suppliers be the AI
-- teammate?" — yes). A call with purpose `errand`: the person asks the Assistant, OKs it on a card, and the teammate
-- rings someone in Contacts with their questions. It goes only to someone who agreed in writing to calls, or a number
-- the phone company says is a business landline, and the answer comes back to the person in the Assistant's chat.
--
--   asked_by   who asked for it (their chat and their phone get the answer)
--   thread_id  the Assistant chat it was asked in, where the answer goes
--   errand     what to find out, and what the teammate may say: {"ask": "...", "say": "..."}
--   reported_at when the answer went back to them

alter table app.ai_calls drop constraint if exists ai_calls_purpose_check;
alter table app.ai_calls add constraint ai_calls_purpose_check
  check (purpose in ('confirm_visit', 'missed_call', 'quote', 'campaign', 'workflow', 'errand'));

alter table app.ai_calls
  add column if not exists asked_by uuid references app.users (id) on delete set null,
  add column if not exists thread_id uuid references app.assistant_threads (id) on delete set null,
  add column if not exists errand jsonb,
  add column if not exists reported_at timestamptz;

alter table app.ai_calls drop constraint if exists ai_calls_errand_check;
alter table app.ai_calls add constraint ai_calls_errand_check
  check ((purpose = 'errand') = (errand is not null) and (errand is null or jsonb_typeof(errand) = 'object'));

create index if not exists ai_calls_asked_by_idx on app.ai_calls (asked_by) where asked_by is not null;
create index if not exists ai_calls_thread_idx on app.ai_calls (thread_id) where thread_id is not null;

-- The chat it points at is the asker's own, in the same business.
create or replace function private.check_ai_call_thread()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.thread_id is not null and not exists (
    select 1 from app.assistant_threads t
    where t.id = new.thread_id and t.workspace_id = new.workspace_id and t.user_id = new.asked_by) then
    raise exception 'That chat belongs to someone else'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
drop trigger if exists ai_calls_check_thread on app.ai_calls;
create trigger ai_calls_check_thread before insert or update of thread_id, asked_by on app.ai_calls
  for each row execute function private.check_ai_call_thread();

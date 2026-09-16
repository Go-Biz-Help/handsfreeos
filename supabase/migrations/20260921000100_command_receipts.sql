-- =============================================================================
-- 0054 · A command runs once. The phone gives every command it sends its own
--        id, and executeCommand claims that id in app.command_receipts as the
--        first statement of the command's transaction: a repeat of the same
--        command, even one that arrives while the first is still running,
--        waits on the unique key and then gets the first answer back instead
--        of running again. The answer is stored at the end of that same
--        transaction, so a receipt that exists always says what happened; a
--        final refusal is recorded in a short transaction of its own. Only the
--        person reads their receipts (their phone syncs them to learn what
--        became of a change whose reply never arrived), and a daily job
--        removes receipts older than 90 days, long after a phone's copy locks.
--        Also: app.events.occurred_at, the moment a change was really made,
--        so the worker can tell a lead that synced three hours late from one
--        made just now. Existing events leave it empty (they happened when
--        they were recorded), and every write that doesn't say otherwise gets
--        the event's own time.
-- =============================================================================

create type app.command_outcome as enum ('applied', 'refused');

create table app.command_receipts (
  id uuid primary key default gen_random_uuid(),
  -- The person who sent it, and the id their device gave the command (a uuid, unique per person).
  user_id uuid not null references app.users (id) on delete cascade,
  command_id uuid not null,
  -- The business it ran in; null for a command about the person's own account.
  workspace_id uuid references app.workspaces (id) on delete cascade,
  -- The command's name ("person.update") and a hash of its input: the same id with a different input is refused.
  command text not null check (command ~ '^[a-z_]+(\.[a-z_]+)+$'),
  input_hash text not null check (length(input_hash) between 16 and 128),
  -- applied: it ran and committed. refused: a final refusal (never "ask" or "retry" answers).
  outcome app.command_outcome not null,
  -- What the command answered (its output, or the refusal's body). Empty only inside the transaction that claimed
  -- the id; the constraint trigger below refuses to commit a receipt without one.
  answer jsonb check (answer is null or pg_column_size(answer) <= 262144),
  -- When the person made the change (corrected for their phone's clock), and when the server received it.
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint command_receipts_user_command_key unique (user_id, command_id)
);
-- The daily clean-up, oldest first.
create index command_receipts_received_idx on app.command_receipts (received_at);

-- ---------- an answer is stored once ----------
-- People (the kernel, running as the person) may only fill in the answer of a receipt that has none yet: the
-- column grant below names nothing else, and this holds the value. The test is on current_user, which no role
-- can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_command_receipt()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if old.answer is not null and new.answer is distinct from old.answer then
    raise exception 'A command''s answer is stored once' using errcode = '42501', detail = 'command_receipt_answered';
  end if;
  return new;
end $$;
create trigger command_receipts_guard before update on app.command_receipts
  for each row execute function private.guard_command_receipt();

-- A receipt never commits without its answer, or a repeat would get nothing back. Checked at commit against the
-- row as it stands then (the insert's own row still has no answer when the kernel stores it at the end).
create or replace function private.check_command_receipt_answered()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from app.command_receipts r where r.id = new.id and r.answer is null) then
    raise exception 'A command receipt needs its answer before the transaction ends'
      using errcode = '23514', detail = 'command_receipt_unanswered';
  end if;
  return null;
end $$;
create constraint trigger command_receipts_answered after insert or update on app.command_receipts
  deferrable initially deferred
  for each row execute function private.check_command_receipt_answered();

-- ---------- references stay inside what the person can reach ----------
-- Foreign keys don't see RLS: a receipt names a business the person works in (checked by the insert policy for
-- people, and here whoever writes, so an owner's direct insert can't point one elsewhere).
create or replace function private.check_command_receipt_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.workspace_id is not null and not private.workspace_has_user(new.workspace_id, new.user_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger command_receipts_check_refs before insert on app.command_receipts
  for each row execute function private.check_command_receipt_refs();

-- ---------- the daily clean-up ----------
-- Receipts older than 90 days go, a batch at a time (the worker calls it until it returns fewer than it asked for).
-- A phone that has not synced for 30 days locks its copy, so nothing that old is ever sent again. Runs across
-- every person and business, so it is a definer only the worker may call; the age is fixed here, not passed in.
create or replace function private.delete_expired_command_receipts(p_limit integer default 5000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from app.command_receipts r
  where r.id in (
    select x.id from app.command_receipts x
    where x.received_at < now() - interval '90 days'
    order by x.received_at
    limit greatest(1, least(coalesce(p_limit, 5000), 50000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------- events: when a change was really made ----------
-- Added empty first, so the events already recorded keep none (each happened when it was recorded: created_at);
-- the default then gives every write that doesn't name a time the event's own. The kernel names the corrected
-- moment for commands from the phone.
alter table app.events add column occurred_at timestamptz;
alter table app.events alter column occurred_at set default now();
comment on column app.events.occurred_at is
  'When the change was really made: the phone''s moment, corrected for its clock and never later than now. Null on events recorded before 0054, which happened at created_at.';

-- ---------- RLS: a person reads and writes only their own receipts ----------
alter table app.command_receipts enable row level security;

create policy command_receipts_select on app.command_receipts for select to authenticated
  using (user_id = (select auth.uid()));
create policy command_receipts_insert on app.command_receipts for insert to authenticated
  with check (user_id = (select auth.uid())
    and (workspace_id is null or workspace_id in (select private.accessible_workspace_ids())));
create policy command_receipts_update on app.command_receipts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------- grants ----------
-- Here rather than in 0060, so the kernel can use receipts as soon as this migration is in. RETURNING and ON
-- CONFLICT work with the select grant; people change nothing but the answer.
grant select, insert on app.command_receipts to authenticated;
grant update (answer) on app.command_receipts to authenticated;
revoke all on app.command_receipts from anon;

-- ---------- function privileges ----------
revoke all on function
  private.guard_command_receipt(), private.check_command_receipt_answered(), private.check_command_receipt_refs(),
  private.delete_expired_command_receipts(integer)
  from public;
grant execute on function
  private.guard_command_receipt(), private.check_command_receipt_answered(), private.check_command_receipt_refs()
  to authenticated, service_actor;
grant execute on function private.delete_expired_command_receipts(integer) to service_actor;

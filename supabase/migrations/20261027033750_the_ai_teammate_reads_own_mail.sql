-- "Let Ava read this mail" (owner, 2026-11-22: "need to add a toggle that allows Ava to read the Only me emails
-- and it can be changed after setup as well"). Until now the AI teammate never read anyone's own mail (the
-- owner's 2026-11-10 pick). This changes that for the addresses whose own person says so, and only this far:
--
--   1. The switch is on the address (ai_reads), off until its own person turns it on. Nobody turns it on for
--      them: not an admin adding their address, and not an owner. It goes off again when the address changes
--      hands, because the yes was one person's.
--   2. With it on, the AI teammate reads mail that comes in to that address and writes a draft answer on the
--      thread (conversations.ai_draft). The thread is private, so the draft is too: the policies that hide the
--      thread hide it. Nothing is sent: only its person sends from their own address
--      (private.guard_private_sender), and that stays so.
--
-- A thread that stops being its person's (shared with the team, or given to someone else by an owner) loses the
-- draft with it.

-- ---------- the switch ----------
alter table app.email_addresses add column ai_reads boolean not null default false;

comment on column app.email_addresses.ai_reads is
  'Its own person lets the AI teammate read the mail that comes in here and draft answers only they see. '
  'Only on a person''s own address, and only they turn it on (private.set_email_address_ai_reads).';

alter table app.email_addresses add constraint email_addresses_ai_reads_owned
  check (not ai_reads or owner_user_id is not null);

-- People write an address's columns one by one (0012), and this one isn't among them: the function below is the
-- only way a person changes it. A new row can't arrive with it on either, and it never outlasts its person.
create or replace function private.guard_email_address_ai_reads()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
    new.ai_reads := false;
  end if;
  if new.ai_reads and (tg_op = 'INSERT' or not old.ai_reads) and current_user = 'authenticated' then
    raise exception 'Only its own person lets the AI teammate read an address''s mail'
      using errcode = '42501', detail = 'email_address_ai_reads_is_theirs';
  end if;
  return new;
end $$;

create trigger email_addresses_ai_reads_guard before insert or update on app.email_addresses
  for each row execute function private.guard_email_address_ai_reads();

-- Runs as the person asking, and checks for itself who that is. Returns whether anything changed.
create or replace function private.set_email_address_ai_reads(p_address uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_owner uuid;
  v_was boolean;
begin
  select a.workspace_id, a.owner_user_id, a.ai_reads into v_ws, v_owner, v_was
  from app.email_addresses a where a.id = p_address for update;
  if not found or v_ws not in (select private.accessible_workspace_ids()) then
    raise exception 'No address with that id' using errcode = 'P0002', detail = 'no_email_address';
  end if;
  if not private.has_permission(v_ws, 'inbox.use') then
    raise exception 'Reading mail takes inbox.use' using errcode = '42501';
  end if;
  if v_owner is null then
    raise exception 'The team''s mail follows the AI teammate''s own settings'
      using errcode = '23514', detail = 'email_address_ai_reads_team';
  end if;
  if v_owner is distinct from (select auth.uid()) then
    raise exception 'Only its own person lets the AI teammate read an address''s mail'
      using errcode = '42501', detail = 'email_address_ai_reads_is_theirs';
  end if;
  if v_was is not distinct from p_on then
    return false;
  end if;
  update app.email_addresses set ai_reads = p_on where id = p_address;
  -- Off means it stops reading: the drafts it had waiting on this address's threads go too.
  if not p_on then
    update app.conversations set ai_draft = null
    where workspace_id = v_ws and email_address_id = p_address and ai_draft is not null;
  end if;
  return true;
end $$;

revoke all on function private.set_email_address_ai_reads(uuid, boolean) from public;
grant execute on function private.set_email_address_ai_reads(uuid, boolean) to authenticated;

-- ---------- the draft ----------
alter table app.conversations add column ai_draft jsonb;

comment on column app.conversations.ai_draft is
  'The answer the AI teammate drafted for the newest mail in a person''s own thread: {body, forMessageId, at}. '
  'Only ever on a private thread, so only its person reads it. Cleared when they answer, dismiss it, or new mail comes.';

alter table app.conversations add constraint conversations_ai_draft_private
  check (ai_draft is null
    or (private_to is not null and jsonb_typeof(ai_draft) = 'object' and pg_column_size(ai_draft) <= 65536));

-- A draft is its person's: a thread shared with the team, or given to someone else, loses it.
create or replace function private.conversation_ai_draft_follows()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.ai_draft := null;
  return new;
end $$;

create trigger conversations_ai_draft_follows before update on app.conversations
  for each row when (old.private_to is distinct from new.private_to and new.ai_draft is not null)
  execute function private.conversation_ai_draft_follows();

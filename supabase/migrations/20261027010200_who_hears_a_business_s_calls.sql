-- =============================================================================
-- Who hears a business's callers, picked by support.
--
--        The AI teammate hears a live call with Deepgram's Nova-3, or Flux when
--        the worker's VOICE_LISTENER says so, and changing that meant a
--        restart for every business at once. Support can now pick the
--        listener for one business from /admin, to hear how Flux does on
--        that business's calls and in its test console, and put it back just
--        as fast. Null is the worker's own choice.
--
--        The twin of the phone model (20261010000800): only support sets it,
--        so it isn't in the settings a business edits. A person's own update
--        may not touch it; `private.set_phone_listener` checks the staff
--        permission itself and writes past the policies.
--
-- Only widens: a column the running code doesn't read yet.
-- =============================================================================

alter table app.workspaces
  add column phone_listener text
    constraint workspaces_phone_listener_check check (phone_listener in ('nova-3', 'flux'));

comment on column app.workspaces.phone_listener is
  'Who hears the caller on this business''s calls (nova-3 or flux), picked by support in /admin. Null is the worker''s VOICE_LISTENER.';

create or replace function private.guard_phone_listener()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.phone_listener is distinct from old.phone_listener then
    raise exception 'Only HandsFreeOS support picks who hears a business''s calls'
      using errcode = '42501', detail = 'phone_listener_is_ours';
  end if;
  return new;
end $$;

create trigger workspaces_phone_listener before update on app.workspaces
  for each row execute function private.guard_phone_listener();

-- Staff-only, one business at a time, and it says what it was so an accidental repeat is visibly a no-op.
create or replace function private.set_phone_listener(p_workspace uuid, p_listener text)
returns table (was text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was text;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'You cannot change who hears a business''s calls'
      using errcode = '42501', detail = 'phone_listener_is_ours';
  end if;
  select w.phone_listener into v_was from app.workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  update app.workspaces set phone_listener = p_listener where id = p_workspace;
  return query select v_was, v_was is distinct from p_listener;
end $$;

revoke execute on function private.set_phone_listener(uuid, text) from public;
grant execute on function private.set_phone_listener(uuid, text) to authenticated;

-- =============================================================================
-- Settings behind their own permission stay behind it.
--
--        The workspaces update policy asks for workspace.update, and a
--        person's own write of app.workspaces.settings could change any key
--        in it. Three keys belong to another permission: `inbox` (who sees
--        which conversations, 0083) and `telephony` (quiet hours) to
--        channels.manage, and `money` (tax, numbering, bank transfer) to
--        money.manage. A business that took channels.manage away from an
--        admin but left them workspace.update had not taken away the switch
--        that shows every member every conversation.
--
--        `workspace.update` now refuses those keys in its settings (the
--        commands that own them do the checks); this is the same rule in the
--        database, for a person's own write, whatever path it came by. The
--        worker and the SECURITY DEFINER functions are not a person's write.
-- =============================================================================

-- Not security definer: it asks who is writing (current_user), which a definer function would always answer
-- with its own owner. private.has_permission() is one, and every person may call it.
create or replace function private.guard_owned_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if ((new.settings -> 'inbox') is distinct from (old.settings -> 'inbox')
      or (new.settings -> 'telephony') is distinct from (old.settings -> 'telephony'))
     and not private.has_permission(new.id, 'channels.manage') then
    raise exception 'Only someone who manages channels changes this'
      using errcode = '42501', detail = 'setting_needs_channels_manage';
  end if;
  if (new.settings -> 'money') is distinct from (old.settings -> 'money')
     and not private.has_permission(new.id, 'money.manage') then
    raise exception 'Only someone who manages money changes this'
      using errcode = '42501', detail = 'setting_needs_money_manage';
  end if;
  return new;
end $$;

drop trigger if exists workspaces_owned_settings on app.workspaces;
create trigger workspaces_owned_settings before update of settings on app.workspaces
  for each row execute function private.guard_owned_settings();

revoke all on function private.guard_owned_settings() from public;
grant execute on function private.guard_owned_settings() to authenticated, service_actor;

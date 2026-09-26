-- =============================================================================
-- The model a business's calls think with, picked by support.
--
--        The AI teammate thinks on a live call with the worker's VOICE_MODEL
--        (or the usual model), and changing that meant a redeploy. Support
--        can now pick another model for one business from /admin, to hear
--        how it sounds on that business's calls and in its test console,
--        and put it back just as fast. Null is the worker's own choice.
--
--        Only support sets it: it spends HandsFreeOS's AI budget and changes
--        how every call sounds, so it isn't in the settings a business edits.
--        A person's own update, through the update policy an admin passes,
--        may not touch it; `private.set_phone_model` checks the staff
--        permission itself and writes past the policies.
-- =============================================================================

alter table app.workspaces
  add column phone_model text
    constraint workspaces_phone_model_check check (phone_model in ('claude-haiku-4-5'));

comment on column app.workspaces.phone_model is
  'The model the AI teammate thinks with on this business''s calls, picked by support in /admin. Null is the worker''s VOICE_MODEL.';

create or replace function private.guard_phone_model()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.phone_model is distinct from old.phone_model then
    raise exception 'Only HandsFreeOS support picks the model a business''s calls use'
      using errcode = '42501', detail = 'phone_model_is_ours';
  end if;
  return new;
end $$;

create trigger workspaces_phone_model before update on app.workspaces
  for each row execute function private.guard_phone_model();

-- Staff-only, one business at a time, and it says what it was so an accidental repeat is visibly a no-op.
create or replace function private.set_phone_model(p_workspace uuid, p_model text)
returns table (was text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was text;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'You cannot change the model a business''s calls use'
      using errcode = '42501', detail = 'phone_model_is_ours';
  end if;
  select w.phone_model into v_was from app.workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  update app.workspaces set phone_model = p_model where id = p_workspace;
  return query select v_was, v_was is distinct from p_model;
end $$;

revoke execute on function private.set_phone_model(uuid, text) from public;
grant execute on function private.set_phone_model(uuid, text) to authenticated;

-- Admins only, like the rates: it's HandsFreeOS's AI spend. Mirrored in core's ROLE_PERMISSIONS.
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.ai.manage');

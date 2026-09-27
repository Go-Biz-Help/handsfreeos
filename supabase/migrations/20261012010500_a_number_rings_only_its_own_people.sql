-- =============================================================================
-- Who a number rings is written in the number's own business.
--
--        `app.phone_number_members` carries `workspace_id` so its policies ask
--        one question, but nothing checked that the number was in that
--        workspace. With `channels.manage` in one business, a row naming
--        another business's number could be written under your own, and
--        `private.phone_route()` — which reads members by number alone —
--        would then ring only the people on that row instead of everybody.
--        `phone_number.set_members` never does this (it loads the number in
--        the business first), so this is the backstop.
--
--        Two halves: the row's number must be in the row's workspace, and
--        phone_route reads only rows written in the number's workspace.
--        Who is on it stays checked at call time, as before: somebody without
--        the inbox there never rings.
-- =============================================================================

create or replace function private.check_phone_number_member_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.phone_numbers n
                 where n.id = new.phone_number_id and n.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
drop trigger if exists phone_number_members_check_refs on app.phone_number_members;
create trigger phone_number_members_check_refs before insert on app.phone_number_members
  for each row execute function private.check_phone_number_member_refs();

revoke all on function private.check_phone_number_member_refs() from public;

-- 0106's version, with `m.workspace_id = pn.workspace_id` on the member arm.
create or replace function private.phone_route(p_to_e164 text)
returns table (phone_number_id uuid, workspace_id uuid, organization_id uuid, account_id uuid, e164 text,
  routing jsonb, timezone text, workspace_name text, client_identities text[])
language sql stable security definer set search_path = '' as $$
  select pn.id, pn.workspace_id, w.organization_id, pn.account_id, pn.e164, pn.routing, w.timezone, w.name,
    coalesce(
      nullif((
        select array_agg('u' || replace(m.user_id::text, '-', '') order by m.user_id)
        from app.phone_number_members m
        where m.phone_number_id = pn.id and m.workspace_id = pn.workspace_id
          and private.user_has_permission(m.user_id, pn.workspace_id, 'inbox.use')
      ), '{}'),
      (
        select array_agg('u' || replace(wa.user_id::text, '-', '') order by wa.user_id)
        from app.workspace_access wa
        where wa.workspace_id = pn.workspace_id and 'inbox.use' = any (wa.permissions)
      ),
      '{}')
  from app.phone_numbers pn
  join app.workspaces w on w.id = pn.workspace_id
  where pn.e164 = p_to_e164 and pn.status = 'active'
$$;

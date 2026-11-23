-- Settings → Email, after the guided setup (owner, 2026-11-22: "after setup also need to be able to change
-- the email, add more, change who can see it"). Two things an address could not do while its person still
-- worked here, or at all:
--
--   1. Its own person hands it back to the team. Until now an address given to one person stayed theirs until
--      they left (private.guard_email_address_owner), so a wrong pick could not be undone. Their old mail stays
--      theirs: its threads keep private_to. Mail that comes after is the team's.
--   2. One address is removed on its own. Until now an address only went with its whole domain, or with the mail
--      of someone who had left (private.reassign_email_address). The mail it already carried stays where it is
--      (conversations and messages set email_address_id null); mail that comes after goes to the domain's
--      catch-all, the business's default address (private.email_receiving_route), so nothing is lost.
--
-- Both run as the person asking, and check for themselves who that is.

-- ---------- hand an address back to the team ----------
create or replace function private.hand_back_email_address(p_address uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_owner uuid;
begin
  select a.workspace_id, a.owner_user_id into v_ws, v_owner
  from app.email_addresses a where a.id = p_address for update;
  if not found or v_ws not in (select private.accessible_workspace_ids()) then
    raise exception 'No address with that id' using errcode = 'P0002', detail = 'no_email_address';
  end if;
  if not private.has_permission(v_ws, 'channels.manage') then
    raise exception 'Changing an address takes channels.manage' using errcode = '42501';
  end if;
  if v_owner is null then
    raise exception 'That address is the team''s already' using errcode = '23514', detail = 'email_address_not_owned';
  end if;
  -- Someone who has left can't hand it back, and nobody else may while they are here: an owner decides then.
  if v_owner is distinct from (select auth.uid()) then
    raise exception 'Only its own person hands an address back'
      using errcode = '42501', detail = 'email_address_owner_is_theirs';
  end if;
  update app.email_addresses set owner_user_id = null where id = p_address;
end $$;

-- ---------- remove one address ----------
-- Returns whose it was and how many threads it carried, for the history.
create or replace function private.remove_email_address(p_address uuid)
returns table (was uuid, threads integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_owner uuid;
  v_default boolean;
  v_domain uuid;
  v_threads integer := 0;
begin
  select a.workspace_id, a.owner_user_id, a.is_default, a.email_domain_id
    into v_ws, v_owner, v_default, v_domain
  from app.email_addresses a where a.id = p_address for update;
  if not found or v_ws not in (select private.accessible_workspace_ids()) then
    raise exception 'No address with that id' using errcode = 'P0002', detail = 'no_email_address';
  end if;
  if not private.has_permission(v_ws, 'channels.manage') then
    raise exception 'Removing an address takes channels.manage' using errcode = '42501';
  end if;
  -- The business always has an address its emails go out from.
  if v_default then
    raise exception 'The default address stays until another one is the default'
      using errcode = '23514', detail = 'email_default_required';
  end if;
  -- The free address is the backup when a domain stops verifying, so the last one stays.
  if v_domain is null and not exists (
      select 1 from app.email_addresses o
      where o.workspace_id = v_ws and o.email_domain_id is null and o.id <> p_address) then
    raise exception 'The free address stays as the backup' using errcode = '23514', detail = 'email_address_backup_stays';
  end if;
  if v_owner is not null then
    -- The mail of someone who has left is sealed: an owner decides what becomes of it and the address together.
    if not private.works_in(v_owner, v_ws) then
      raise exception 'An owner decides what becomes of the address of someone who has left'
        using errcode = '23514', detail = 'email_address_owner_left';
    end if;
    if v_owner is distinct from (select auth.uid()) then
      raise exception 'Only its own person removes an address'
        using errcode = '42501', detail = 'email_address_owner_is_theirs';
    end if;
  end if;
  -- Counted as the function's owner, so a person's own threads count too; only the number leaves here.
  select count(*)::int into v_threads from app.conversations c where c.email_address_id = p_address;
  delete from app.email_addresses where id = p_address;
  return query select v_owner, v_threads;
end $$;

revoke all on function private.hand_back_email_address(uuid), private.remove_email_address(uuid) from public;
grant execute on function private.hand_back_email_address(uuid), private.remove_email_address(uuid) to authenticated;

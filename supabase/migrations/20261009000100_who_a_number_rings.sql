-- =============================================================================
-- 0110 · Choosing who a number rings (M3, 0103).
--
--        Settings → Texting & calls' "who does this ring" checks that each
--        person chosen works the inbox, with private.user_has_permission().
--        0045 gave that function to the worker alone, and the command runs as
--        the person saving, so choosing anybody at all was refused with "You
--        do not have permission to do that." Only clearing the list (everyone
--        with the inbox) worked.
--
--        Giving user_has_permission() to `authenticated` would let anyone
--        signed in ask what anyone may do in any business. This asks the one
--        question the screen needs, and only of someone who may set this
--        business's numbers up: does this person work the inbox here?
-- =============================================================================

create or replace function private.works_the_inbox(p_user uuid, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- The worker has no auth.uid() and may already ask anything; a person must manage the channels here.
  select (auth.uid() is null or private.has_permission(p_ws, 'channels.manage'))
     and private.user_has_permission(p_user, p_ws, 'inbox.use')
$$;

revoke all on function private.works_the_inbox(uuid, uuid) from public;
grant execute on function private.works_the_inbox(uuid, uuid) to authenticated, service_actor;

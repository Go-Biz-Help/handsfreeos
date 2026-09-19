-- =============================================================================
-- 0071 · The way back into the support desk, done in the database.
--
--        0070 left this to the worker: read the addresses in PLATFORM_OWNER_EMAILS,
--        find those people, make them support admins. Two things were wrong with
--        that, and neither showed up locally because the setting is empty here.
--
--        The first was a plain mistake — a list passed where an array was wanted.
--        The second is the interesting one: the worker holds no business in scope
--        while it starts, and `app.users` is readable by the service actor only
--        for the people inside its current scope. So the look-up was never going
--        to find anybody, however the addresses were passed.
--
--        Which is the database saying something true: "every user on the
--        platform" is not a question a tenant-scoped reader gets to ask. So it is
--        asked here instead, by a function that says plainly what it may do, in
--        the same shape as every other helper this milestone added.
-- =============================================================================

create or replace function private.confirm_platform_owners(p_emails text[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_made integer;
begin
  with named as (
    select u.id from app.users u
    where lower(u.email::text) in (select lower(btrim(e)) from unnest(p_emails) as e)
  ), made as (
    insert into platform.staff (user_id, role, status)
    select n.id, 'admin', 'active' from named n
    on conflict (user_id) do update set role = 'admin', status = 'active', updated_at = now()
    returning user_id
  )
  select count(*) into v_made from made;
  return v_made;
end $$;

comment on function private.confirm_platform_owners(text[]) is
  'Makes the people named in the worker''s PLATFORM_OWNER_EMAILS support admins, and returns how many. '
  'Adds and promotes; never takes anything away.';

revoke all on function private.confirm_platform_owners(text[]) from public;
grant execute on function private.confirm_platform_owners(text[]) to service_actor;

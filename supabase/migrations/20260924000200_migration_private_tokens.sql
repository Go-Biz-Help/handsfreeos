-- =============================================================================
-- 0069 · A second door onto the old CRM: a private token the business pastes.
--
--        Signing in is the door we built first, and it stays the recommended
--        one: the person approves what we may reach, GoHighLevel tells us what
--        was granted, and nobody handles a credential. But it depends on a
--        marketplace app, and a marketplace app depends on GoHighLevel
--        approving it. Chris's app is not approved yet (2026-09-18), and there
--        will always be an account that cannot install an app at all —
--        an agency that will not add one to a client's sub-account, a business
--        on a plan without the marketplace.
--
--        GoHighLevel's own answer to that is a **private integration token**:
--        made inside one sub-account, under Settings → Private Integrations,
--        with its read access ticked there, and used as an ordinary bearer
--        token against the same v2 API. So the second door is: paste the token
--        and the sub-account's Location ID.
--
--        Three things follow, and they are why this is a column rather than a
--        convention:
--
--        1. **A private token reaches one sub-account.** GoHighLevel will not
--           list an agency's locations for one, and will not mint a per-location
--           token from one, so `install_kind` is always `location` here. The
--           check below holds that line in the database rather than in a screen.
--        2. **Nobody can say what it was granted.** An OAuth sign-in hands back
--           the scopes it was given; a private token hands back nothing at all.
--           So `scopes` stays empty for this door and the adapter probes each
--           category instead — "we asked and were refused" rather than a list
--           we made up. A screen reading `scopes` has to know which door it is
--           looking at, which is the second reason the kind is stored.
--        3. **It never expires and cannot be refreshed.** There is nothing to
--           refresh with, so `token_expires_at` stays null and the worker never
--           tries. A token that stops working is replaced, not renewed.
--
--        What does not change: the token is sealed by the worker before it
--        touches this table, exactly like an OAuth one, and it is never
--        selectable by `authenticated`. The one-time state still governs who
--        may finish a connection, so pasting a token goes through the same
--        ten-minute, single-use door as a sign-in does.
-- =============================================================================

create type app.migration_auth_kind as enum ('oauth', 'private_token');

alter table app.migration_connections
  add column auth_kind app.migration_auth_kind not null default 'oauth';

-- A private token reaches exactly one sub-account. See (1) above.
alter table app.migration_connections
  add constraint migration_connections_private_token_is_one_location
  check (auth_kind <> 'private_token' or install_kind = 'location');

comment on column app.migration_connections.auth_kind is
  'oauth: the person signed in and GoHighLevel said what was granted. private_token: a private integration '
  'token was pasted for one sub-account, so scopes are unknown and each category is probed instead.';

-- The kind is fixed when the connection is made. Changing it afterwards would mean a row whose token and
-- whose rules no longer agree, so it joins the columns that cannot be edited at all.
drop trigger if exists migration_connections_immutable on app.migration_connections;
create trigger migration_connections_immutable before update on app.migration_connections
  for each row execute function private.forbid_tenant_column_change(
    'organization_id', 'source_system', 'created_by', 'auth_kind');

-- ---------- what a person may read ----------
-- The kind, so a screen can say "signed in" or "private token" and word its own help accordingly. The token
-- itself stays out of reach, as it always was.
grant select (auth_kind) on app.migration_connections to authenticated;

-- ---------- the sign-in's one-time state ----------
-- Now carries the kind, so the worker can refuse a token pasted into a sign-in's state and a sign-in
-- returning into a token's. Both doors are single use and both expire in ten minutes; what they may not do
-- is stand in for each other.
-- A returned column is part of the signature, so this is dropped and made again rather than replaced.
drop function if exists private.migration_connection_by_state(text);
create function private.migration_connection_by_state(p_state_hash text)
returns table (connection_id uuid, organization_id uuid, source_system text, install_kind text,
  auth_kind text, status text, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select mc.id, mc.organization_id, mc.source_system::text, mc.install_kind::text, mc.auth_kind::text,
    mc.status::text, mc.oauth_state_expires_at
  from app.migration_connections mc
  where mc.oauth_state_hash = p_state_hash
$$;

revoke all on function private.migration_connection_by_state(text) from public;
grant execute on function private.migration_connection_by_state(text) to service_actor;

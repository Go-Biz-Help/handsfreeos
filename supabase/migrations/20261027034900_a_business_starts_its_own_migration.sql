-- =============================================================================
-- A business could connect its own CRM and then not start a migration on it.
--
--        0068 moved the line a migration has to hold from the organization to
--        the business: an owner or admin of a business may move it in, even
--        when they are not a member of the organization above it. Its insert
--        policy says so (`migrations_insert`: the connection's own business,
--        managed by the asker), and 0070 let that business read and scan what
--        it started. Two things behind that insert were never told, and every
--        such person got "References must belong to the same organization", or
--        "You don't have permission to do that", the moment they pressed Look
--        at GoHighLevel:
--          - an owner of a business that belongs to an agency's organization;
--          - somebody on a business's team as a teammate rather than through
--            its organization;
--          - the founder working in a customer's business as its owner
--            (20261013002100), who is never in that organization.
--        Connecting worked, so the source showed as Connected and then refused
--        to be looked at. The owner hit it on 2026-11-23, moving the same
--        GoHighLevel sub-account into a second business. The tests had only
--        ever walked this door as the organization's own founder, who passes
--        every organization check, so neither showed.
--
--        1. `check_migration_refs` still asked that whoever started a migration
--           be a member of the organization. They now pass when they are, as
--           before, or when they are the person asking and manage migrations in
--           the business that made the connection — the clause the insert
--           policy already holds.
--
--        2. A new migration could not be read back by the statement that made
--           it. `migrations_select` asks `migration_reaches_my_workspace(id)`,
--           which looks the migration up by id, and a row being inserted is not
--           there yet for that lookup. So `insert … returning` failed its read
--           for anybody without the organization permission. The policy now
--           also judges the row by its own `connection_id`, through a helper
--           that asks the same question about the connection directly.
--
--        Nothing widens past the insert policy: a connection an agency made has
--        no business on it, so only the agency's own people can start a
--        migration on it, and a business still reads only migrations on its own
--        connection or holding its own sub-account.
-- =============================================================================

-- ---------- 1. who may start one ----------
create or replace function private.check_migration_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.migration_connections c
                 where c.id = new.connection_id and c.organization_id = new.organization_id) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.created_by is not null
     and not exists (
       select 1 from app.organization_memberships m
       where m.organization_id = new.organization_id and m.user_id = new.created_by)
     and not (
       new.created_by = auth.uid()
       and private.migration_connection_is_my_business(new.connection_id)) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;

-- ---------- 2. reading back what was just started ----------
-- Whether a connection was made by a business whose migrations I manage. A security definer function rather
-- than a subquery in the policy, so that the two tables' policies never ask each other.
create or replace function private.migration_connection_is_my_business(p_connection uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.migration_connections c
    where c.id = p_connection and c.workspace_id is not null
      and private.has_permission(c.workspace_id, 'migrations.manage'))
$$;
comment on function private.migration_connection_is_my_business(uuid) is
  'Whether a migration connection was made by a business whose migrations I manage. Judges a migration by its '
  'own connection_id, so a row being inserted can be read back by the statement that made it.';

alter policy migrations_select on app.migrations
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_reaches_my_workspace(id)
    or private.migration_connection_is_my_business(connection_id));

-- ---------- function privileges ----------
revoke all on function private.migration_connection_is_my_business(uuid) from public;
grant execute on function private.migration_connection_is_my_business(uuid) to authenticated, service_actor;

comment on function private.check_migration_refs() is
  'A migration''s connection is in its organization, and whoever started it is a member of that organization '
  'or manages migrations in the business that made the connection (the same rule as migrations_insert).';

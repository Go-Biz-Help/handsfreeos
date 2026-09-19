-- =============================================================================
-- 0070 · A business could connect its own CRM and then not look at it.
--
--        0068 gave a business its own door onto a migration, and answered
--        "is this migration mine?" the way the hard case needs: through
--        `app.migration_scopes` — the sub-account rows — because twenty clients
--        can share one agency migration and each must see only its own line.
--
--        That answer is right, and it is empty at exactly the wrong moment.
--        The scope rows are written by the **discovery pass**, which is the
--        first thing a scan does. So the very first scan of a business's own
--        connection asked a question that could only be answered by work the
--        scan had not done yet:
--
--          connect  →  start a migration  →  scan  ✗ "That migration isn't
--                                                     there."
--
--        Nothing was broken and nothing was refused out loud. The migration sat
--        at `connected`, no job was queued, no scan row was written, and the
--        screen went on saying it had started looking — because the browser did
--        not check the answer to that call either (fixed beside this, in
--        `connect.tsx`). Chris hit it on the first real GoHighLevel account
--        through the pasted-token door (2026-09-18); it was never about the
--        token — an agency owner opening a business's own **Settings →
--        Migrations** page hits the identical wall, because naming a workspace
--        is what chooses the door.
--
--        The fix is to finish the thought 0068 started. It already knew about
--        this case in one place: `migration_jobs_insert` lets a business queue
--        "the discovery pass of a connection it made (which has no sub-account
--        yet to name)". That clause belongs in the question itself rather than
--        in one policy, so it moves here, where `migrations_select`,
--        `migrations_update`, `migration_scans_insert`, `migration_jobs_*` and
--        `migration_verifications_select` all ask it.
--
--        **A business reaches a migration when it holds a sub-account of it, or
--        when the migration runs on a connection that business itself made.**
--        Nothing widens: a connection an agency made still has no workspace on
--        it, so a client reaches an agency's migration only through a
--        sub-account mapped to that client — which is the line 0068 drew and
--        this keeps.
-- =============================================================================

create or replace function private.migration_reaches_my_workspace(p_migration uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    -- A sub-account of this migration that landed in a business of mine.
    select 1 from app.migration_scopes s
    where s.migration_id = p_migration and s.workspace_id is not null
      and private.has_permission(s.workspace_id, 'migrations.manage'))
  or exists (
    -- Or: no sub-account of mine yet, because nothing has been discovered — but my own business connected
    -- the source this migration runs on, so looking at it is the next thing it is meant to do.
    select 1 from app.migrations m
    join app.migration_connections c on c.id = m.connection_id
    where m.id = p_migration and c.workspace_id is not null
      and private.has_permission(c.workspace_id, 'migrations.manage'))
$$;

comment on function private.migration_reaches_my_workspace(uuid) is
  'Whether a migration is one of mine: I hold a sub-account of it, or my own business made the connection it '
  'runs on. The second half is what lets a business scan its own source for the first time, before any '
  'sub-account has been discovered (0070).';

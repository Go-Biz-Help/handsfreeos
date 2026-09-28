-- =============================================================================
-- __NAME__ (__ID__): its permissions, and the schema its own tables live in.
--
--        Written by `pnpm addon:new __ID__` (docs/addon-architecture.md). The
--        permissions are its manifest's, and exist only while it runs in a
--        business; the parity test checks the two lists match. Its own tables
--        live in `addon___ID__`, each with `workspace_id ... on delete cascade`
--        and every tenant rule from one call (private.addon_table_policies):
--        the catalogue test refuses one without them. Core never points at
--        them; to attach to core's records, use a kind of record it manages.
-- =============================================================================

select private.register_addon_permissions('__ID__', '__PERMISSIONS_JSON__'::jsonb);

select private.create_addon_schema('__ID__');

-- An example table, to copy:
--
-- create table addon___ID__.items (
--   id uuid primary key default gen_random_uuid(),
--   workspace_id uuid not null references app.workspaces (id) on delete cascade,
--   name text not null check (length(btrim(name)) between 1 and 200),
--   created_at timestamptz not null default now(),
--   updated_at timestamptz not null default now()
-- );
-- create index items_workspace_idx on addon___ID__.items (workspace_id);
-- select private.addon_table_policies('addon___ID__.items', '__ID__.use', '__ID__.use', '__ID__.use');

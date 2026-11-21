-- =============================================================================
-- 20261027032200 backup login
--   A read-only login for the nightly copy kept outside Supabase
--   (.github/workflows/backup.yml; "A copy outside Supabase" in
--   docs/operations.md). Supabase's own backups are deleted with the project,
--   so this copy is what survives a lost account or a deleted project.
--   - hfos_backup reads every table in every schema, rows included past RLS,
--     so pg_dump can copy the whole database: app, private, platform, portal,
--     the add-ons' schemas, auth and storage.
--   - It changes nothing. pg_read_all_data grants SELECT and schema USAGE only,
--     and its sessions start read-only besides.
--   - At most two connections, so a stuck copy can't crowd out the apps.
--   - No password: nothing can sign in as it until the owner sets one (step 4
--     of "A copy outside Supabase").
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hfos_backup') then
    create role hfos_backup with login bypassrls nosuperuser nocreatedb nocreaterole noreplication inherit connection limit 2;
  end if;
end
$$;
comment on role hfos_backup is
  'The nightly copy outside Supabase: reads every table, writes nothing. No password until the owner sets one.';

grant pg_read_all_data to hfos_backup;
alter role hfos_backup set default_transaction_read_only = on;

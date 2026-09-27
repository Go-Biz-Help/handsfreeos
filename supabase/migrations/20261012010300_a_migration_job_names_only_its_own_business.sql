-- =============================================================================
-- A migration row's business is the migration's organization's, and a job
-- with no sub-account names no business at all.
--
--        `private.check_migration_engine_refs` only compared `workspace_id`
--        with the sub-account's when there was one. A job with `scope_id`
--        null could carry any workspace, and the worker takes its scope from
--        the job: its errors, and whatever else it writes, would land in that
--        other business. Nothing the app does writes one (a whole-migration
--        job — discover, verify, rollback — leaves both null), so this is the
--        backstop saying the same thing.
--
--        The organization check applies to every table this trigger guards.
--        The no-sub-account rule is for jobs alone: a setup step
--        (`migration_reconnect_tasks`) is written per business with no
--        sub-account, on purpose.
-- =============================================================================

create or replace function private.check_migration_engine_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_ws uuid; v_mig uuid;
begin
  select m.organization_id into v_org from app.migrations m where m.id = new.migration_id;
  if v_org is null or v_org is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.workspace_id is not null
     and private.workspace_organization(new.workspace_id) is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.scope_id is not null then
    select s.workspace_id, s.migration_id into v_ws, v_mig
      from app.migration_scopes s where s.id = new.scope_id;
    if v_mig is distinct from new.migration_id then
      raise exception 'References must belong to the same migration'
        using errcode = '23514', detail = 'record_migration_mismatch';
    end if;
    if new.workspace_id is not null and v_ws is distinct from new.workspace_id then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'migration_jobs' and new.workspace_id is not null then
    raise exception 'A job with no sub-account names no business'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

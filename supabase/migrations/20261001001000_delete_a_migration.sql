-- =============================================================================
-- 0086 · Taking a move off the list, so it can be run again (M17).
--
--        **Rolling back and deleting are two different acts, and this is the
--        second one.** `migration.rollback` already exists and already does
--        the hard part: it puts back the fields it changed where nobody has
--        changed them since, **archives** the customers and companies it made,
--        and drops the mappings that said where each one came from. Archiving
--        rather than destroying is right for a rollback — somebody who rolled
--        one back by mistake gets everything back in a click.
--
--        But it leaves the move on the list for good, and it leaves an
--        archived copy of everybody. Run the import again and the business has
--        two of each. So: roll it back, look at what came back, and *then*
--        delete it, which is this.
--
--        **What it will not do.** A customer who has been texted, booked or
--        invoiced since is kept, archived, however plainly the import made
--        them — a record with history is not the import's to destroy, and the
--        count of those comes back so the screen can say so. Tags are left
--        alone for the reason the rollback leaves them alone: a tag is the
--        business's label, not the import's record.
--
--        **A number that really moved carrier is not undone by this.**
--        app.migration_port_requests cascades away with the migration, and its
--        `number_port_id` (0080) is only a pointer: app.number_ports keeps its
--        own life. Deleting an import must never hand a business's phone
--        number back to its old carrier.
-- =============================================================================

create or replace function private.delete_migration(p_migration uuid)
returns table (removed integer, kept integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_org uuid;
  v_removed integer := 0;
  v_kept integer := 0;
  v_row record;
  v_busy boolean;
begin
  select m.status::text, m.organization_id into v_status, v_org
  from app.migrations m where m.id = p_migration;
  if v_status is null then
    raise exception 'No migration with that id' using errcode = 'P0002';
  end if;
  -- **Checked here, not taken on trust from the caller.** This is `security definer`, so it reads and writes
  -- past every policy; a function like that asks the question itself or it is a hole. Deleting the record of
  -- a move is the agency's call even where the move itself reached one business, which is why this is the
  -- organization's permission and not a workspace's.
  if not private.has_org_permission(v_org, 'org.migrations.manage') then
    raise exception 'Only people who manage migrations can delete one'
      using errcode = '42501', detail = 'migration_delete_forbidden';
  end if;
  -- The order is the whole safety story: nothing is deleted until a rollback has put back what it could and
  -- said what it could not. A move still holding live records is not something to delete out from under.
  if v_status <> 'rolled_back' then
    raise exception 'Take the migration back before deleting it (it is %)', v_status
      using errcode = '55000', detail = 'migration_not_rolled_back';
  end if;

  for v_row in
    select distinct j.target_type, j.target_id, j.workspace_id
    from app.migration_change_journal j
    where j.migration_id = p_migration and j.action = 'create'
      and j.target_type in ('person', 'company')
  loop
    -- Still archived means the rollback put it away and nobody has wanted it since. Anything else is
    -- somebody's work now.
    if v_row.target_type = 'person' then
      select not exists (
        select 1 from app.people p where p.id = v_row.target_id and p.archived_at is not null
      ) into v_busy;
      if not v_busy then
        -- History outranks the import that made it. A customer who has been talked to, booked or billed
        -- since stays, archived, and the caller is told how many.
        select exists (select 1 from app.conversations c where c.person_id = v_row.target_id)
            or exists (select 1 from app.appointment_attendees a where a.person_id = v_row.target_id)
            or exists (select 1 from app.invoices i where i.person_id = v_row.target_id)
            or exists (select 1 from app.estimates e where e.person_id = v_row.target_id)
          into v_busy;
      end if;
      if v_busy then
        v_kept := v_kept + 1;
      else
        delete from app.people p where p.id = v_row.target_id;
        v_removed := v_removed + 1;
      end if;
    else
      select not exists (
        select 1 from app.companies c where c.id = v_row.target_id and c.archived_at is not null
      ) into v_busy;
      if not v_busy then
        select exists (select 1 from app.people p where p.company_id = v_row.target_id)
          into v_busy;
      end if;
      if v_busy then
        v_kept := v_kept + 1;
      else
        delete from app.companies c where c.id = v_row.target_id;
        v_removed := v_removed + 1;
      end if;
    end if;
  end loop;

  -- Last, because every migration_* table hangs off this row and the journal above is one of them.
  delete from app.migrations m where m.id = p_migration;
  removed := v_removed;
  kept := v_kept;
  return next;
end $$;

revoke all on function private.delete_migration(uuid) from public;
grant execute on function private.delete_migration(uuid) to authenticated, service_actor;

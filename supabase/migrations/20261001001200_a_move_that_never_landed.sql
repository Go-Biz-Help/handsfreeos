-- =============================================================================
-- 0088 · Taking a move off the list when it never put anything here (M17).
--
--        **0086 answered half the question.** It made deleting the second half
--        of undoing a finished import: roll it back, look at what came back,
--        then delete. That order is right when there is something to put back,
--        and it is the only order the business should get.
--
--        But it was also the *only* way in, and most moves people want rid of
--        never got that far. A source is connected, a move is created, the
--        scan runs, and then somebody thinks better of it — wrong sub-account,
--        wrong system, a second go at the same one. That move sits at `draft`,
--        `scanned` or `ready` forever: `migration.rollback` will not take it
--        (there is nothing imported to take back) and this function would not
--        take it either (it was never rolled back). No way out, and the list
--        fills up with moves nobody can clear.
--
--        **The real question is not what step it is on, it is whether it put
--        anything here.** The journal is what the rollback reads to put things
--        back, so an empty journal means the same thing to both of us: this
--        move changed nothing in the business's own records, and deleting it
--        takes nothing away from anybody. That holds at `draft` and it holds
--        at `failed` — a move that fell over before its first write is as
--        empty as one that never started, and neither should need a rollback
--        it has no work for.
--
--        So: nothing written, delete it. Anything written, the 0086 order
--        stands, unchanged and for the same reasons.
--
--        **A run in flight is stopped first, not yanked.** While the engine
--        holds a lease it is still writing, and a journal read a moment ago is
--        not an answer about a move that is still going. Those are refused
--        here, so the screen can say "pause it first" — and pausing is a
--        button, not a support ticket.
--
--        Which is asked two ways, because the status alone is not enough.
--        Pausing stops the *next* batch, not the one running (that is what it
--        says it does), so a move can read `paused` a moment after somebody
--        pressed it while a lease is still live — and pressing Pause and then
--        Delete is what a person in a hurry does. And private.claim_migration_jobs
--        takes work at `verifying`, `transition` and `finalizing` too, which
--        are not obviously "running" from the outside. A live lease is the one
--        fact that covers all of it, so it is asked for directly rather than
--        inferred from a list of steps.
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
  v_wrote boolean;
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

  -- Still going. Whatever the journal says right now, the engine may write again before this commits, so the
  -- honest answer is to stop it first rather than to race it. A live lease counts as going whatever the
  -- status says: pausing stops the next batch, not the one already running.
  if v_status in ('scanning', 'importing', 'rolling_back', 'cancelling')
     or exists (
       select 1 from app.migration_jobs j
       where j.migration_id = p_migration and j.state = 'leased' and j.leased_until > now()
     )
  then
    raise exception 'Stop the migration before deleting it (it is %)', v_status
      using errcode = '55000', detail = 'migration_still_running';
  end if;

  -- The journal is the whole of what this move did to the business's own records — it is what the rollback
  -- reads to put things back. Empty means there is nothing to put back and nothing to finish off, at any
  -- step. That is the one question worth asking; the status is not it.
  select exists (
    select 1 from app.migration_change_journal j where j.migration_id = p_migration
  ) into v_wrote;

  if v_wrote then
    -- Unchanged from 0086, and for its reasons: nothing is deleted until a rollback has put back what it
    -- could and said what it could not. A move still holding live records is not something to delete out
    -- from under.
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
  end if;

  -- Last, because every migration_* table hangs off this row and the journal above is one of them. The jobs
  -- that were queued for a move that never ran go with it, which is the point of deleting it.
  --
  -- **A number that really moved carrier is not undone by this.** app.migration_port_requests cascades away
  -- with the migration, and its `number_port_id` (0080) is only a pointer: app.number_ports keeps its own
  -- life. Deleting an import must never hand a business's phone number back to its old carrier.
  delete from app.migrations m where m.id = p_migration;
  removed := v_removed;
  kept := v_kept;
  return next;
end $$;

revoke all on function private.delete_migration(uuid) from public;
grant execute on function private.delete_migration(uuid) to authenticated, service_actor;

-- =============================================================================
-- 0092 · Taking a move back takes back everything it made (M17).
--
--        **The rollback only ever undid two of the twenty kinds of record an
--        import makes.** It put merged fields back, archived the customers and
--        companies it created, and then dropped every mapping it had — for the
--        texts, the calls, the bookings, the invoices, the estimates, the
--        tasks, the notes, the deals, the boards, the forms, the answers, the
--        templates, the products, the subscriptions and the custom fields too,
--        none of which it had touched. A business that took its import back
--        got its customer list back and kept five years of somebody else's
--        inbox, calendar and billing history, with nothing left to say which
--        rows those were, because the mappings that said had just been
--        deleted. Running the import again then made a second copy of all of
--        it.
--
--        The engine is where that is fixed (migrations/engine/run.ts): the
--        plan there names every kind of record, dependents before the records
--        they point at, and takes each one back the way its table allows —
--        archived where there is somewhere to put it, deleted where there is
--        not. This file is the three parts of that which live in the database:
--        the privileges the worker needs, the delete that finishes what a
--        rollback puts away, and the moves already taken back the half-way way,
--        which are finished off now rather than left sitting in a business.
--
--        **One: the worker may delete what it may write.** service_actor's
--        grants are written one table at a time, and four of the tables the
--        rollback now clears were never granted a delete: a text, a call, a
--        booking and a note. app.activities is also the one table whose
--        service policies are written per command rather than `for all`, so it
--        needs the policy as well as the grant.
--
--        **Two: deleting a move finishes what the rollback put away.** 0086
--        deletes the archived customers a rollback leaves; now that a rollback
--        also leaves archived threads, deals, boards, forms, products,
--        templates, fields and calendars, they are deleted with it, in
--        dependency order, and a record somebody has since taken back out of
--        the archive is left exactly where it is.
--
--        And its "has this customer been talked to since?" test asks the
--        question it meant to ask. It looked for any conversation, booking,
--        invoice or estimate on the customer — every one of which the import
--        had just made itself, which is why an imported customer with an
--        imported text counted as one with history and stayed archived for
--        good. Those records are now gone by the time this runs, and the
--        three kinds that hold a customer in place through a foreign key
--        (a deal, a subscription, a place on a waitlist) are asked about too,
--        so the delete cannot fail on one.
-- =============================================================================

-- ---------- one: the worker may delete what it may write ----------
create policy activities_service_delete on app.activities for delete to service_actor
  using (workspace_id = private.system_scope_workspace());

grant delete on app.messages, app.calls, app.appointments, app.activities to service_actor;

-- ---------- two: deleting a move finishes what the rollback put away ----------
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
  v_count integer;
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

    -- What the rollback put away, finished off. Dependents first, and in each case only while the record is
    -- still put away and was not one the rollback kept: `depended_on` means the business has made it its own,
    -- and somebody who has taken a record back out of the archive has said the same thing in fewer words.
    --
    -- Threads go before the customers they are about (a message goes with its thread), deals before the
    -- boards they sit on (a board will not go while a deal is on it) and bookings before their calendars.
    delete from app.conversations c
     where c.archived_at is not null
       and c.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'conversation'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.forms f
     where f.archived_at is not null
       and f.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'form'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.leads l
     where l.archived_at is not null
       and l.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'lead'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.pipelines p
     where p.archived_at is not null
       and not exists (select 1 from app.leads l where l.pipeline_id = p.id)
       and p.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'pipeline'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.products pr
     where pr.archived_at is not null
       and pr.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'product'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.message_templates mt
     where mt.archived_at is not null
       and mt.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create'
           and j.target_type = 'message_template'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from app.custom_fields cf
     where cf.archived_at is not null
       and cf.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'custom_field'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    -- A calendar holds recurring bookings and a waitlist in place through foreign keys that do not cascade,
    -- so it goes only once there is nothing left on it at all.
    delete from app.calendars cal
     where cal.status = 'archived'
       and not exists (select 1 from app.appointments a where a.calendar_id = cal.id)
       and not exists (select 1 from app.appointment_series s where s.calendar_id = cal.id)
       and not exists (select 1 from app.waitlist_entries w where w.calendar_id = cal.id)
       and cal.id in (
         select j.target_id from app.migration_change_journal j
         where j.migration_id = p_migration and j.action = 'create' and j.target_type = 'calendar'
           and j.revert_skipped_reason is distinct from 'depended_on');
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

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
          -- since stays, archived, and the caller is told how many. Everything the import itself made is
          -- already gone by here, so what is left is the business's own — including the three kinds of
          -- record that hold a customer in place through a foreign key, which would otherwise turn a
          -- delete this function cannot see coming into a failure.
          select exists (select 1 from app.conversations c where c.person_id = v_row.target_id)
              or exists (select 1 from app.appointment_attendees a where a.person_id = v_row.target_id)
              or exists (select 1 from app.invoices i where i.person_id = v_row.target_id)
              or exists (select 1 from app.estimates e where e.person_id = v_row.target_id)
              or exists (select 1 from app.leads l where l.person_id = v_row.target_id)
              or exists (select 1 from app.subscriptions s where s.person_id = v_row.target_id)
              or exists (select 1 from app.waitlist_entries w where w.person_id = v_row.target_id)
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
              or exists (select 1 from app.leads l where l.company_id = v_row.target_id)
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

-- ---------- three: the moves already taken back, finished off properly ----------
--
-- A business that took its import back before today has the leftovers in it right now, and nothing it can
-- press: `migration.rollback` answers "already taken back" and stops. The records are still findable, though,
-- because the change journal is never deleted — every row the import created is still named there, and the old
-- rollback left `reverted_at` null on all the kinds it did not know about.
--
-- So those moves are put back to `rolling_back` with a rollback job each, and the engine finishes the job it
-- only half did. It is the same code path a person's own press takes, with the same two rules: nothing that was
-- already here is deleted, and nothing the business has made its own since is touched. The engine reads the
-- journal rather than the mappings for exactly this reason — the old rollback deleted the mappings on its way
-- past, so the journal is all that is left to go on.
--
-- Migrations with nothing unaccounted for are not touched, and a move that is genuinely rolling back right now
-- keeps the job it already has.
with stale as (
  select m.id, m.organization_id
  from app.migrations m
  where m.status = 'rolled_back'
    and exists (
      select 1 from app.migration_change_journal j
      where j.migration_id = m.id and j.action = 'create' and j.reverted_at is null
        and j.target_type <> all (array['tag', 'user', 'pipeline_stage'])
    )
), woken as (
  update app.migrations m
     set status = 'rolling_back', last_error = null
    from stale s where m.id = s.id
  returning m.id, m.organization_id
)
insert into app.migration_jobs (migration_id, organization_id, kind, category, pass, input)
select w.id, w.organization_id, 'rollback'::app.migration_job_kind, 'locations', 0, '{}'::jsonb
from woken w
where not exists (
  select 1 from app.migration_jobs jb
  where jb.migration_id = w.id and jb.kind = 'rollback'
    and jb.state in ('pending', 'retry', 'leased')
);

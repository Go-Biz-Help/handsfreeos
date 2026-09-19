-- =============================================================================
-- A lead brought from another CRM keeps the dates it really had.
--
--        `private.sync_lead_status` decides a lead's status from the kind of stage
--        it sits in, and stamps the moment: `stage_entered_at` on every insert and
--        stage move, `won_at` or `lost_at` when it lands in a won or lost stage.
--        0062 made those stamps the *change's* moment rather than the database's
--        clock, so a stage moved on a phone that was offline is recorded when the
--        person moved it. Both of those are right, and neither is settable from a
--        browser — whatever a caller writes into them is replaced.
--
--        That is exactly wrong for a lead that is five years old. A deal won in
--        March 2021 would arrive saying it was won the afternoon of the import,
--        and `coalesce(old.won_at, …)` means a later update cannot put it right
--        either. Every report on when work was won would be wrong, and the
--        migration's own history check exists to catch this class of mistake.
--
--        So the worker — and only the worker, acting for the business it is
--        importing into — may provide those moments, and they are kept when it
--        does. `private.system_scope_workspace()` is the same test the rest of the
--        schema uses for "the system acting for that business, not a person in a
--        browser", and a person's own writes are untouched: still stamped for
--        them, still not theirs to set.
--
--        Written against 0062's version of the function rather than the original,
--        which is the whole lesson of the first attempt: replacing a function
--        means replacing the newest one, and the change-moment tests are what
--        caught it.
-- =============================================================================

create or replace function private.sync_lead_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind app.stage_kind;
  v_stage_pipeline uuid;
  v_stage_workspace uuid;
  v_at timestamptz;
  -- The system acting for this business: the import, and nothing a person can reach.
  v_imported boolean := coalesce(private.system_scope_workspace() = new.workspace_id, false);
begin
  select s.kind, s.pipeline_id, s.workspace_id into v_kind, v_stage_pipeline, v_stage_workspace
  from app.pipeline_stages s where s.id = new.stage_id;
  if v_kind is null then
    raise exception 'Stage not found' using errcode = '23503', detail = 'stage_not_found';
  end if;
  if v_stage_pipeline <> new.pipeline_id or v_stage_workspace <> new.workspace_id then
    raise exception 'Stage belongs to a different pipeline' using errcode = '23514', detail = 'stage_pipeline_mismatch';
  end if;
  if (new.person_id is not null and not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.company_id is not null and not exists (select 1 from app.companies c where c.id = new.company_id and c.workspace_id = new.workspace_id)) then
    raise exception 'Lead must belong to a person or company of the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  if v_kind = 'lost' and coalesce(btrim(new.lost_reason), '') = '' then
    raise exception 'A reason is required to mark a lead lost' using errcode = '23514', detail = 'lost_reason_required';
  end if;
  new.status := v_kind::text::app.lead_status;
  if tg_op = 'INSERT' then
    -- Imported: when it really entered that stage, when the import says so. Otherwise the change's moment.
    new.stage_entered_at := case
      when v_imported and new.stage_entered_at is not null then new.stage_entered_at
      else private.change_moment() end;
  elsif old.stage_id <> new.stage_id then
    v_at := private.change_moment();
    -- Made before the lead's latest stage change: it moves the lead now, from the stage it's in now.
    new.stage_entered_at := case when v_at >= old.stage_entered_at then v_at else now() end;
  end if;
  if v_kind = 'won' then
    new.won_at := case
      when v_imported and tg_op = 'INSERT' and new.won_at is not null then new.won_at
      else coalesce(case when tg_op = 'UPDATE' and old.status = 'won' then old.won_at end, new.stage_entered_at) end;
    new.lost_at := null;
  elsif v_kind = 'lost' then
    new.lost_at := case
      when v_imported and tg_op = 'INSERT' and new.lost_at is not null then new.lost_at
      else coalesce(case when tg_op = 'UPDATE' and old.status = 'lost' then old.lost_at end, new.stage_entered_at) end;
    new.won_at := null;
  else
    new.won_at := null;
    new.lost_at := null;
    new.lost_reason := null;
  end if;
  return new;
end $$;

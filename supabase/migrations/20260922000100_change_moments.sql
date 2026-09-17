-- =============================================================================
-- 0062 · When a change was really made. A change made on a phone with no
--        signal reaches the server minutes or hours later, and the times the
--        database stamps itself came from its own clock: a lead moved to Won
--        at 6:27 said it entered the stage when the move arrived, so on the
--        customer's timeline the move sorted after things done later.
--        private.change_moment() is the moment the person made the change.
--        The kernel names it for every command from the phone (app.occurred_at,
--        already corrected for the phone's clock); for everything else, the web
--        and the worker, it is now. It is never later than now. The stamps for
--        a person's own act use it:
--          - a lead's stage entry, and when it was won or lost. A move made
--            before the lead's latest stage change (someone else moved it in the
--            meantime) counts from when it arrived: that is when it took the lead
--            out of the stage it was in, so the stage's time never starts before
--            the lead got there;
--          - when an attention item was snoozed, dismissed or handled, or its
--            automatic message cancelled;
--          - when someone on the team marked a booking confirmed.
--        A time written into these columns is still replaced, as before, and
--        the checks around them are unchanged. What happens only when a change
--        arrives keeps now (a document's sent_at, an invoice's paid_at).
-- =============================================================================

create or replace function private.change_moment()
returns timestamptz language sql stable set search_path = '' as $$
  select least(coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz, now()), now())
$$;
comment on function private.change_moment() is
  'When the person made the change: the phone''s moment the kernel set for this transaction (app.occurred_at), never later than now; otherwise now.';

-- ---------- a lead's stage ----------
-- 0006's rules, with the stage entry (and won or lost) stamped at the change's moment.
create or replace function private.sync_lead_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind app.stage_kind;
  v_stage_pipeline uuid;
  v_stage_workspace uuid;
  v_at timestamptz;
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
    new.stage_entered_at := private.change_moment();
  elsif old.stage_id <> new.stage_id then
    v_at := private.change_moment();
    -- Made before the lead's latest stage change: it moves the lead now, from the stage it's in now.
    new.stage_entered_at := case when v_at >= old.stage_entered_at then v_at else now() end;
  end if;
  if v_kind = 'won' then
    new.won_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'won' then old.won_at end, new.stage_entered_at);
    new.lost_at := null;
  elsif v_kind = 'lost' then
    new.lost_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'lost' then old.lost_at end, new.stage_entered_at);
    new.won_at := null;
  else
    new.won_at := null;
    new.lost_at := null;
    new.lost_reason := null;
  end if;
  return new;
end $$;

-- ---------- what people change on an attention item ----------
-- 0039's rules, with each *_at stamp at the change's moment. The stamps are still the database's: whatever the
-- caller writes into them is replaced. The test is on current_user, which no role can fake, so this function must
-- stay SECURITY INVOKER.
create or replace function private.guard_attention_item()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_uid uuid;
  v_theirs constant text[] := array[
    'state', 'assignee_user_id', 'snoozed_until', 'snoozed_at', 'snoozed_by', 'dismissed_at', 'dismissed_by',
    'dismiss_reason', 'handled_at', 'handled_by', 'handled_via', 'auto_state', 'auto_done_at', 'auto_cancelled_by',
    'updated_at'];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Only people get this far: the worker has no JWT and no access to the auth schema.
  v_uid := auth.uid();
  if (to_jsonb(new) - v_theirs) is distinct from (to_jsonb(old) - v_theirs) then
    raise exception 'Only HandsFreeOS changes what an attention item says'
      using errcode = '42501', detail = 'attention_item_protected';
  end if;

  if new.state is distinct from old.state
     and (old.state = 'resolved' or new.state = 'resolved' or old.handled_via is not distinct from 'auto') then
    raise exception 'An attention item can''t be moved from % to % by hand', old.state, new.state
      using errcode = '42501', detail = 'attention_state_transition';
  end if;

  if new.snoozed_until is not null
     and (new.snoozed_until, new.snoozed_by) is distinct from (old.snoozed_until, old.snoozed_by) then
    if new.snoozed_by is distinct from v_uid then
      raise exception 'People snooze in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
    end if;
    if new.snoozed_until <= now() or new.snoozed_until > now() + interval '31 days' then
      raise exception 'Snooze until a time in the next 30 days' using errcode = '22023', detail = 'attention_snooze_range';
    end if;
    new.snoozed_at := private.change_moment();
  elsif new.snoozed_until is not null then
    new.snoozed_at := old.snoozed_at;
  end if;

  if new.dismissed_at is not null
     and (old.dismissed_at is null
       or (new.dismissed_by, new.dismiss_reason) is distinct from (old.dismissed_by, old.dismiss_reason)) then
    if new.dismissed_by is distinct from v_uid then
      raise exception 'People dismiss in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
    end if;
    new.dismissed_at := private.change_moment();
  elsif new.dismissed_at is not null then
    new.dismissed_at := old.dismissed_at;
  end if;

  if new.handled_via = 'auto' and new.handled_via is distinct from old.handled_via then
    raise exception 'Only HandsFreeOS handles an item on its own' using errcode = '42501', detail = 'attention_handled_via';
  end if;
  if (new.handled_at, new.handled_by, new.handled_via) is distinct from (old.handled_at, old.handled_by, old.handled_via) then
    if new.handled_at is not null and old.handled_at is not null then
      if (new.handled_by, new.handled_via) is distinct from (old.handled_by, old.handled_via) then
        raise exception 'Nobody rewrites who handled an item' using errcode = '42501', detail = 'attention_handled_protected';
      end if;
      new.handled_at := old.handled_at;
    elsif new.handled_at is not null then
      if new.handled_by is distinct from v_uid then
        raise exception 'People handle in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
      end if;
      new.handled_at := private.change_moment();
    end if;
  end if;
  -- Leaving handled takes the worker's "until" along.
  if new.handled_at is null then
    new.handled_until := null;
  end if;

  if (new.auto_state, new.auto_done_at, new.auto_cancelled_by)
     is distinct from (old.auto_state, old.auto_done_at, old.auto_cancelled_by) then
    if not coalesce(old.auto_state = 'scheduled' and new.auto_state = 'cancelled' and new.auto_cancelled_by = v_uid, false) then
      raise exception 'People can only cancel an automatic action that is waiting, in their own name'
        using errcode = '42501', detail = 'attention_auto_protected';
    end if;
    new.auto_done_at := private.change_moment();
  end if;
  return new;
end $$;

-- ---------- a staff confirmation ----------
-- 0041's rules, with a staff mark stamped at the change's moment rather than whatever the caller wrote. The test is
-- on current_user, which no role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_attendee_confirmation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.confirmed_at is not null or new.confirmed_via is not null or new.confirmed_by is not null
       or new.confirm_asked_at is not null then
      raise exception 'A new booking starts unconfirmed' using errcode = '42501', detail = 'attendee_confirmation_protected';
    end if;
    return new;
  end if;
  if (new.confirmed_at, new.confirmed_via, new.confirmed_by) is not distinct from
     (old.confirmed_at, old.confirmed_via, old.confirmed_by) then
    return new;
  end if;
  if old.confirmed_at is null and new.confirmed_via = 'staff' and new.confirmed_by = auth.uid() then
    new.confirmed_at := private.change_moment();
    return new;
  end if;
  if old.confirmed_via = 'staff' and new.confirmed_at is null and new.confirmed_via is null and new.confirmed_by is null then
    return new;
  end if;
  raise exception 'People confirm a booking only as staff, in their own name'
    using errcode = '42501', detail = 'attendee_confirmation_protected';
end $$;

-- ---------- function privileges ----------
-- `create or replace` keeps the earlier grants; they are restated so this file says who may run what on its own.
-- People's guards run as the person, so the person needs change_moment too.
revoke all on function
  private.change_moment(), private.sync_lead_status(), private.guard_attention_item(),
  private.guard_attendee_confirmation()
  from public;
grant execute on function
  private.change_moment(), private.sync_lead_status(), private.guard_attention_item(),
  private.guard_attendee_confirmation()
  to authenticated, service_actor;

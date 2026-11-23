-- =============================================================================
-- A merged customer brings their documents, form links, funnel places and calls.
--
--        Merging two customers (private.merge_people, 12 Oct, last written 25
--        Oct) moves what names the duplicate onto the record kept. The tables
--        added since were never added to it, so a merge left these on the
--        archived duplicate:
--
--        - documents out for signing and their signers: a signature then
--          landed on the duplicate's timeline, and the signed PDF in the
--          duplicate's files;
--        - personal form links: answers sent through one kept filing leads and
--          bills on the duplicate;
--        - funnel places, video calls and their webinar leads, the Zoom and
--          Meet claims, caller codes, and the partner and who-referred-them
--          rows.
--
--        The owner chose this fix on 23 Nov 2026 ("Yes, fix it").
--
--        **When.** As orders do (20261027034500), the move hangs off the
--        moment merge_people marks the duplicate merged. Everything else has
--        moved by then, so a funnel place's lead is already the kept
--        record's, and private.person_merges still holds the pair, so each
--        table's rule that keeps who a row is for fixed lets this one change
--        through. The deleted bin's own use of the pair (moving bills to a
--        record of the name alone) never marks anybody merged, so it never
--        reaches here.
--
--        **The merge's own rules hold.** A row that can only be one per
--        customer stays with the duplicate when the kept record has its own:
--        a seat on the same video call, a lead from the same webinar, being a
--        partner, who referred them. The kept record's own funnel place
--        stands and the duplicate's running one ends; a second suggestion of
--        a funnel they're already suggested for, or in, is plainly the same
--        thing twice and goes. A call or a meeting that a teammate who has
--        since left the business ran stays with the duplicate, as it was,
--        rather than stopping the merge.
--
--        Two guards that refuse every other change to a row (a document's
--        state, a meeting claim's) now let the merge's move through, and
--        nothing else.
--
-- No table or column changes, so there is nothing to mirror in Drizzle and
-- PowerSync copies nothing again.
-- =============================================================================

-- ---------- the merge's move, and nothing else ----------
-- True when a row's only change is the merge moving p_column from the duplicate to the customer kept (the row's
-- updated_at aside). private.merging_person holds only inside private.merge_people's own transaction.
create or replace function private.only_merge_move(p_old jsonb, p_new jsonb, p_column text)
returns boolean language sql stable set search_path = '' as $$
  select (p_new - array[p_column, 'updated_at']) = (p_old - array[p_column, 'updated_at'])
     and coalesce(private.merging_person(p_old ->> p_column, p_new ->> p_column), false)
$$;
revoke all on function private.only_merge_move(jsonb, jsonb, text) from public;

-- 20261027015200's guard, as it was, plus the merge moving the document to the customer kept.
create or replace function private.guard_document_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if private.only_merge_move(to_jsonb(old), to_jsonb(new), 'person_id') then
    return new;
  end if;
  if not (old.status = 'out' and new.status = 'voided' and new.voided_by = (select auth.uid())
          and new.voided_at is not null
          and new.name = old.name and new.expires_at = old.expires_at
          and new.all_signed_at is not distinct from old.all_signed_at
          and new.completed_at is null and new.signed_file_id is null
          and new.declined_at is null and new.expired_at is null) then
    raise exception 'A document is only voided by a person, while it''s out for signing'
      using errcode = '42501', detail = 'document_state_transition';
  end if;
  return new;
end $$;

-- 20261027007700's guard, as it was, plus the merge moving the meeting to the customer kept.
create or replace function private.guard_live_meeting_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if private.only_merge_move(to_jsonb(old), to_jsonb(new), 'person_id') then
    return new;
  end if;
  if old.state = 'live' and new.state = 'live' then
    if new.stream_id is distinct from old.stream_id or new.started_at is distinct from old.started_at
       or new.ended_at is distinct from old.ended_at then
      raise exception 'The stream is the worker''s' using errcode = '42501', detail = 'live_meeting_state_transition';
    end if;
    return new;
  end if;
  if old.state <> 'waiting' and not (old.state = 'live' and new.state = 'ended') then
    raise exception 'Only a waiting claim on a meeting can change' using errcode = '42501', detail = 'live_meeting_state_transition';
  end if;
  if new.state not in ('waiting', 'ended') or new.stream_id is distinct from old.stream_id
     or new.started_at is distinct from old.started_at then
    raise exception 'The stream is the worker''s' using errcode = '42501', detail = 'live_meeting_state_transition';
  end if;
  if new.state = 'ended' and old.state <> 'ended' then
    new.ended_at := now();
  end if;
  return new;
end $$;

-- ---------- the move ----------
create or replace function private.merge_brings_later_records()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws constant uuid := new.workspace_id;
  v_from constant uuid := new.id;
  v_into constant uuid := new.merged_into_id;
  v_running uuid;
  v_id uuid;
begin
  -- Documents, and who signs them.
  update app.documents d set person_id = v_into where d.workspace_id = v_ws and d.person_id = v_from;
  update app.document_signers s set person_id = v_into where s.workspace_id = v_ws and s.person_id = v_from;

  -- Personal form links, and the codes a caller proves who they are with.
  update app.form_links l set person_id = v_into where l.workspace_id = v_ws and l.person_id = v_from;
  update app.call_verification_codes c set person_id = v_into where c.workspace_id = v_ws and c.person_id = v_from;

  -- Funnel places. A customer is in one funnel at a time: the kept record's place stands, and the duplicate's
  -- running one ends (in the same funnel, as taken out; in another, as having joined another funnel). It moves in
  -- the same change, since a place's lead must be its customer's and the leads have moved already.
  select f.funnel_id into v_running from app.funnel_people f
   where f.person_id = v_into and f.status in ('active', 'paused');
  delete from app.funnel_people f
   where f.workspace_id = v_ws and f.person_id = v_from and f.status = 'suggested'
     and exists (select 1 from app.funnel_people o
                 where o.person_id = v_into and o.funnel_id = f.funnel_id
                   and o.status in ('suggested', 'active', 'paused'));
  update app.funnel_people f set
    person_id = v_into,
    status = case when v_running is not null and f.status in ('active', 'paused') then 'left' else f.status end,
    left_reason = case when v_running is not null and f.status in ('active', 'paused')
      then case when f.funnel_id = v_running then 'removed' else 'other_funnel' end
      else f.left_reason end,
    left_at = case when v_running is not null and f.status in ('active', 'paused') then now() else f.left_at end,
    paused_reason = case when v_running is not null and f.status in ('active', 'paused') then null
      else f.paused_reason end
  where f.workspace_id = v_ws and f.person_id = v_from;

  -- Video calls, then the people in them (a customer in a call without a booking must be the one it's with). Each
  -- on its own, so one a former teammate hosted stays with the duplicate instead of stopping the merge.
  for v_id in select c.id from app.video_calls c where c.workspace_id = v_ws and c.person_id = v_from loop
    begin
      update app.video_calls c set person_id = v_into where c.id = v_id;
    exception when check_violation then
      null;
    end;
  end loop;
  for v_id in select p.id from app.video_call_people p where p.workspace_id = v_ws and p.person_id = v_from loop
    begin
      update app.video_call_people p set person_id = v_into where p.id = v_id;
    exception when check_violation or unique_violation then
      null;
    end;
  end loop;
  update app.video_call_leads l set person_id = v_into
   where l.workspace_id = v_ws and l.person_id = v_from
     and not exists (select 1 from app.video_call_leads o where o.video_call_id = l.video_call_id and o.person_id = v_into);

  -- Zoom and Meet claims: the same, for a teammate who has since left.
  for v_id in select m.id from app.live_meetings m where m.workspace_id = v_ws and m.person_id = v_from loop
    begin
      update app.live_meetings m set person_id = v_into where m.id = v_id;
    exception when check_violation then
      null;
    end;
  end loop;

  -- Partners, and who referred them: one each per customer.
  update app.partners p set person_id = v_into
   where p.workspace_id = v_ws and p.person_id = v_from
     and not exists (select 1 from app.partners o where o.workspace_id = v_ws and o.person_id = v_into);
  update app.partner_referrals r set person_id = v_into
   where r.workspace_id = v_ws and r.person_id = v_from
     and not exists (select 1 from app.partner_referrals o where o.workspace_id = v_ws and o.person_id = v_into);

  return null;
end $$;
revoke execute on function private.merge_brings_later_records() from public;

create trigger people_records_follow_merge after update of merged_into_id on app.people
  for each row when (old.merged_into_id is null and new.merged_into_id is not null)
  execute function private.merge_brings_later_records();

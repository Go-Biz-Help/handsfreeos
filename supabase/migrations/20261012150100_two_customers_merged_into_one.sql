-- =============================================================================
-- Two records for the same customer, merged into one.
--
--        Duplicates happen: a phone with no signal adds somebody who was
--        already here (0059 flags it "Possible duplicate"), an import brings
--        a name across twice, a customer calls from a new number and gets a
--        new record. Until now the only way out was to archive one of them
--        and lose everything that hung off it. `person.merge` joins the
--        duplicate into the record being kept:
--
--        1. The command fills in what the kept record is missing from the
--           duplicate (its name, email, number, address, company, notes),
--           in an ordinary update, and folds the duplicate's email, number
--           and address into the other ones when the kept record has its own.
--        2. `private.merge_people` below moves everything that names the
--           duplicate onto the kept record — leads, tasks, the timeline,
--           conversations, calls, bookings, bills, quotes, plans, files,
--           tags, relationships and the rest — and archives the duplicate,
--           marked with who it was merged into so an old link can say so.
--
--        **History moves with the customer.** Many tables keep who a row is
--        for fixed on purpose (a sent invoice, a booking, a system timeline
--        entry), and nothing else may change that. Those rules let a change
--        through only while `private.person_merges` holds the pair, and only
--        a change from the duplicate to the record kept. merge_people writes
--        that row and removes it inside its own transaction, as 0093's purge
--        does with its own, so no other transaction can ever see it.
--
--        **What stays with the duplicate.** Its events and audit rows (they
--        are history as it was written), the Contact AI's reviews of it
--        (append-only), and a row that the kept record already has its own
--        of and that can only be one per customer: a seat on the same
--        booking, an answer to the same one-per-customer form, a place in the
--        same campaign. Nothing is deleted except what is plainly the same
--        thing twice: the duplicate's own reminder schedule for a service the
--        kept record has one for, a maintenance reminder for the same visit,
--        an attention item the kept record already has, and a relationship
--        between the two records themselves.
-- =============================================================================

-- ---------- the mark ----------
alter table app.people
  add column merged_into_id uuid references app.people (id) on delete set null,
  add column merged_at timestamptz,
  add constraint people_merged_into_other check (merged_into_id is distinct from id),
  add constraint people_merged_when check (merged_into_id is null or merged_at is not null);

comment on column app.people.merged_into_id is
  'This record was a duplicate and was merged into that one (person.merge). It stays archived.';
comment on column app.people.merged_at is 'When it was merged.';

create index people_merged_into_idx on app.people (merged_into_id) where merged_into_id is not null;

-- Only a merge sets the mark, and a merged record stays archived: bringing it back would split one customer's
-- history in two again. A person's own update, through the people_update policy, may not touch either column.
create or replace function private.guard_person_merge_mark()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'service_actor') then
    if tg_op = 'INSERT' and (new.merged_into_id is not null or new.merged_at is not null) then
      raise exception 'Only a merge marks a customer merged' using errcode = '42501', detail = 'person_merge_mark';
    end if;
    if tg_op = 'UPDATE'
       and (new.merged_into_id is distinct from old.merged_into_id or new.merged_at is distinct from old.merged_at) then
      raise exception 'Only a merge marks a customer merged' using errcode = '42501', detail = 'person_merge_mark';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.merged_into_id is not null and old.archived_at is not null and new.archived_at is null then
    raise exception 'This customer was merged into another one and can’t be brought back'
      using errcode = '55000', detail = 'person_merged';
  end if;
  return new;
end $$;

create trigger people_guard_merge_mark before insert or update of merged_into_id, merged_at, archived_at on app.people
  for each row execute function private.guard_person_merge_mark();

-- ---------- the pair being merged ----------
create table private.person_merges (
  from_person_id uuid primary key,
  into_person_id uuid not null,
  workspace_id uuid not null
);
revoke all on private.person_merges from public;

-- True only inside private.merge_people's own transaction (the row is never committed), and only for a change from
-- the duplicate to the record kept. Asked with text because the rule that asks compares columns as text.
create or replace function private.merging_person(p_from text, p_into text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.person_merges m
    where m.from_person_id::text = p_from and m.into_person_id::text = p_into
  )
$$;
grant execute on function private.merging_person(text, text) to public;

-- 0001's rule, as it was, plus the merge: a column that names the duplicate may change to the record kept.
create or replace function private.forbid_tenant_column_change()
returns trigger language plpgsql set search_path = '' as $$
declare
  cols text[] := tg_argv;
  c text;
  old_v text;
  new_v text;
begin
  foreach c in array cols loop
    execute format('select ($1).%I::text, ($2).%I::text', c, c) into old_v, new_v using old, new;
    if old_v is distinct from new_v and not coalesce(private.merging_person(old_v, new_v), false) then
      raise exception '% is immutable on %.%', c, tg_table_schema, tg_table_name using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- A system timeline entry (0093's rule): the same, plus the merge moving it, and nothing else about it, to the
-- record kept.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace(old.workspace_id) then
    return old;
  end if;
  if old.kind = 'system' then
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at']) = (to_jsonb(old) - array['sync_window', 'updated_at']) then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'person_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'person_id'])
       and coalesce(private.merging_person(old.person_id::text, new.person_id::text), false) then
      return new;
    end if;
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- ---------- the merge ----------
-- Moves everything that names p_from onto p_into, in p_workspace, and archives p_from marked merged into p_into.
-- Answers how many rows of each kind moved (only the kinds that had any). The command has already filled in
-- p_into's own details; the owner, the team, custom fields and consent are settled here, where both rows are
-- locked.
create or replace function private.merge_people(p_workspace uuid, p_from uuid, p_into uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from app.people%rowtype;
  v_into app.people%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_n integer;
  v_ref text[];
  v_rel app.relationships%rowtype;
  v_assign boolean;
  -- Every table whose rows simply follow the customer: table, column, and the name its count goes by.
  v_simple constant text[][] := array[
    array['leads', 'person_id', 'leads'],
    array['tasks', 'person_id', 'tasks'],
    array['activities', 'person_id', 'timeline'],
    array['conversations', 'person_id', 'conversations'],
    array['calls', 'person_id', 'calls'],
    array['email_inbound_unmatched', 'resolved_person_id', 'emails'],
    array['workflow_runs', 'person_id', 'workflow_runs'],
    array['ai_teammate_runs', 'person_id', 'ai_runs'],
    array['ai_teammate_drafts', 'person_id', 'ai_drafts'],
    array['chat_visitors', 'person_id', 'chats'],
    array['chat_visitors', 'verified_person_id', 'chats_verified'],
    array['chat_verification_codes', 'person_id', 'chat_codes'],
    array['attention_items', 'person_id', 'attention'],
    array['estimates', 'person_id', 'estimates'],
    array['invoices', 'person_id', 'invoices'],
    array['subscriptions', 'person_id', 'plans'],
    array['intake_submissions', 'person_id', 'intake'],
    array['reviews', 'person_id', 'reviews'],
    array['thank_yous', 'person_id', 'thank_yous'],
    array['referrals', 'person_id', 'referrals'],
    array['referrals', 'referrer_person_id', 'referred'],
    array['jobs', 'person_id', 'jobs'],
    array['promises', 'person_id', 'promises'],
    array['ai_calls', 'person_id', 'ai_calls']
  ];
begin
  -- Asked here, not taken on trust: this writes past every policy.
  if not (coalesce(private.has_permission(p_workspace, 'records.archive'), false)
          or coalesce(private.system_scope_workspace() = p_workspace, false)) then
    raise exception 'Merging customers needs the records.archive permission'
      using errcode = '42501', detail = 'person_merge_forbidden';
  end if;
  if p_from = p_into then
    raise exception 'A customer can’t be merged into themselves' using errcode = '22023', detail = 'person_merge_self';
  end if;

  -- Both rows, locked in the same order whichever way round they come, so two merges of the same pair wait.
  perform 1 from app.people p where p.id in (p_from, p_into) and p.workspace_id = p_workspace
    order by p.id for update;
  select * into v_from from app.people p where p.id = p_from and p.workspace_id = p_workspace;
  if not found then
    raise exception 'Person not found' using errcode = 'P0002', detail = 'person_missing';
  end if;
  select * into v_into from app.people p where p.id = p_into and p.workspace_id = p_workspace;
  if not found then
    raise exception 'Person not found' using errcode = 'P0002', detail = 'person_missing';
  end if;
  if v_from.merged_into_id is not null then
    raise exception 'That customer was already merged into another one' using errcode = '55000', detail = 'person_already_merged';
  end if;
  if v_into.merged_into_id is not null or v_into.archived_at is not null then
    raise exception 'Bring the customer you’re keeping back before merging into them'
      using errcode = '55000', detail = 'person_merge_into_archived';
  end if;

  insert into private.person_merges (from_person_id, into_person_id, workspace_id) values (p_from, p_into, p_workspace);

  foreach v_ref slice 1 in array v_simple loop
    execute format('update app.%I set %I = $1 where workspace_id = $2 and %I = $3', v_ref[1], v_ref[2], v_ref[2])
      using p_into, p_workspace, p_from;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_moved := jsonb_set(v_moved, array[v_ref[3]], to_jsonb(coalesce((v_moved ->> v_ref[3])::int, 0) + v_n));
    end if;
  end loop;

  -- One per customer, so a row the kept record already has its own of stays with the duplicate.
  update app.appointment_attendees a set person_id = p_into
   where a.workspace_id = p_workspace and a.person_id = p_from
     and not exists (select 1 from app.appointment_attendees o where o.appointment_id = a.appointment_id and o.person_id = p_into);
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('appointments', v_n); end if;

  update app.form_responses r set person_id = p_into
   where r.workspace_id = p_workspace and r.person_id = p_from
     and not (r.one_per_person and r.status = 'completed' and exists (
       select 1 from app.form_responses o
       where o.form_id = r.form_id and o.person_id = p_into and o.one_per_person and o.status = 'completed'));
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('forms', v_n); end if;

  update app.campaign_recipients r set person_id = p_into
   where r.workspace_id = p_workspace and r.person_id = p_from
     and not exists (select 1 from app.campaign_recipients o where o.campaign_id = r.campaign_id and o.person_id = p_into);
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('campaigns', v_n); end if;

  -- A place on the waitlist for a time the kept record is already waiting for is let go; the rest move.
  update app.waitlist_entries w set status = 'removed'
   where w.workspace_id = p_workspace and w.person_id = p_from and w.appointment_id is not null
     and w.status in ('waiting', 'offered')
     and exists (select 1 from app.waitlist_entries o
                 where o.appointment_id = w.appointment_id and o.person_id = p_into and o.status in ('waiting', 'offered'));
  update app.waitlist_entries w set person_id = p_into where w.workspace_id = p_workspace and w.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('waitlist', v_n); end if;

  -- The same thing twice: the kept record's own schedule and reminders stand.
  delete from app.service_schedules s
   where s.workspace_id = p_workspace and s.person_id = p_from
     and exists (select 1 from app.service_schedules o where o.person_id = p_into and o.service_id = s.service_id);
  update app.service_schedules s set person_id = p_into where s.workspace_id = p_workspace and s.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('service_schedules', v_n); end if;

  delete from app.maintenance_reminders m
   where m.workspace_id = p_workspace and m.person_id = p_from
     and exists (select 1 from app.maintenance_reminders o
                 where o.person_id = p_into and o.service_id = m.service_id and o.due_on = m.due_on);
  update app.maintenance_reminders m set person_id = p_into where m.workspace_id = p_workspace and m.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('maintenance_reminders', v_n); end if;

  -- An attention item about the duplicate itself: the kept record's own item of the same kind stands.
  delete from app.attention_items i
   where i.workspace_id = p_workspace and i.subject_type = 'person' and i.subject_id = p_from
     and exists (select 1 from app.attention_items o
                 where o.workspace_id = p_workspace and o.kind = i.kind and o.subject_type = 'person' and o.subject_id = p_into);
  update app.attention_items i set subject_id = p_into
   where i.workspace_id = p_workspace and i.subject_type = 'person' and i.subject_id = p_from;

  -- Files kept on the customer's page.
  update app.files f set record_id = p_into
   where f.workspace_id = p_workspace and f.record_type = 'person' and f.record_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('files', v_n); end if;

  -- Tags: the kept record gets every tag either had. The duplicate keeps its own, as it was.
  insert into app.record_tags (workspace_id, tag_id, record_type, record_id, created_by, created_at)
  select t.workspace_id, t.tag_id, t.record_type, p_into, t.created_by, t.created_at
    from app.record_tags t
   where t.workspace_id = p_workspace and t.record_type = 'person' and t.record_id = p_from
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('tags', v_n); end if;

  -- Relationships: one between the two records goes; the rest are written again on the kept record, through
  -- 0101's own check (which orders a mutual pair and holds a one-to-one to one). One the kept record already has,
  -- or can't take, stays with the duplicate.
  delete from app.relationships r
   where r.workspace_id = p_workspace
     and ((r.a_person_id = p_from and r.b_person_id = p_into) or (r.a_person_id = p_into and r.b_person_id = p_from));
  v_n := 0;
  for v_rel in
    select * from app.relationships r
     where r.workspace_id = p_workspace and (r.a_person_id = p_from or r.b_person_id = p_from)
  loop
    begin
      delete from app.relationships r where r.id = v_rel.id;
      insert into app.relationships (id, workspace_id, type_id, a_person_id, a_company_id, a_custom_record_id,
                                     b_person_id, b_company_id, b_custom_record_id, note, created_by, created_at)
      values (v_rel.id, v_rel.workspace_id, v_rel.type_id,
              case when v_rel.a_person_id = p_from then p_into else v_rel.a_person_id end,
              v_rel.a_company_id, v_rel.a_custom_record_id,
              case when v_rel.b_person_id = p_from then p_into else v_rel.b_person_id end,
              v_rel.b_company_id, v_rel.b_custom_record_id, v_rel.note, v_rel.created_by, v_rel.created_at);
      v_n := v_n + 1;
    exception when unique_violation or check_violation then
      null; -- stays with the duplicate, as it was
    end;
  end loop;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('relationships', v_n); end if;

  -- Anybody flagged as maybe the duplicate is now maybe the kept record; the kept record's own flag, if it
  -- pointed at the duplicate, is settled.
  update app.people p set possible_duplicate_of = case when p.id = p_into then null else p_into end
   where p.workspace_id = p_workspace and p.possible_duplicate_of = p_from;

  -- Who the customer is assigned to (0104) is the managers' call, as on the screen: settled only for someone
  -- who may assign. The kept record's owner stands; the duplicate's owner and team join its team, those of them
  -- still in the business.
  v_assign := coalesce(private.has_permission(p_workspace, 'records.assign'), false)
    or coalesce(private.system_scope_workspace() = p_workspace, false);
  update app.people p set
    owner_user_id = case when v_assign and p.owner_user_id is null
        and private.workspace_has_user(p_workspace, v_from.owner_user_id)
      then v_from.owner_user_id else p.owner_user_id end,
    team_user_ids = case when v_assign then p.team_user_ids || array(
        select t.u from unnest(array[v_from.owner_user_id] || v_from.team_user_ids) with ordinality as t(u, n)
        where t.u is not null and private.workspace_has_user(p_workspace, t.u)
        order by t.n)
      else p.team_user_ids end,
    -- Custom fields: the kept record's answers stand; the duplicate fills in the ones it left blank, for the
    -- fields the business still has (0076's check refuses a new answer to an archived one).
    custom = coalesce((
        select jsonb_object_agg(e.key, e.value) from jsonb_each(v_from.custom) as e
        where exists (
          select 1 from app.custom_fields f
          where f.workspace_id = p_workspace and f.entity = 'person' and f.archived_at is null
            and f.record_type_id is null and f.id::text = e.key)
      ), '{}'::jsonb) || jsonb_strip_nulls(p.custom),
    -- Never text someone who said stop: a STOP on either record holds. A yes carries over only for the very
    -- number the kept record now has, when it had no answer of its own.
    sms_consent = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent
      else p.sms_consent end,
    sms_consent_at = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent_at
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent_at
      else p.sms_consent_at end,
    sms_consent_source = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent_source
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent_source
      else p.sms_consent_source end,
    call_consent = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent
      else p.call_consent end,
    call_consent_at = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent_at
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent_at
      else p.call_consent_at end,
    call_consent_source = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent_source
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent_source
      else p.call_consent_source end
  where p.id = p_into;

  -- The duplicate: archived (0006's guard asks for records.archive again and says by whom), and marked.
  update app.people p set
    archived_at = coalesce(p.archived_at, private.change_moment()),
    merged_into_id = p_into,
    merged_at = now(),
    possible_duplicate_of = null
  where p.id = p_from;

  delete from private.person_merges m where m.from_person_id = p_from;
  return v_moved;
end $$;

revoke all on function private.merge_people(uuid, uuid, uuid) from public;
grant execute on function private.merge_people(uuid, uuid, uuid) to authenticated, service_actor;

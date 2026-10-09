-- =============================================================================
-- Deleting for good, round two: a lead, a company, or a record of one of the
-- business's own kinds goes in the Deleted bin too (the last step of the plan
-- Chris accepted on 2026-10-08; docs/deleting.md).
--
--        Each takes what's only about it, and what was put on it on purpose:
--
--          A lead: its tasks, its files, and the lines that tell its own
--            story (made, moved, won, lost). Its customer stays, with their
--            notes, calls, bookings, bills and form answers, no longer tied
--            to it.
--          A company: its notes, tasks and files, the leads that are only the
--            company's, and its relationships. Its people stay, no longer at
--            it, and so do their leads.
--          A record of the business's own kind: its notes, tasks and files,
--            and its relationships. Bookings and conversations on it stay. A
--            record of an add-on's kind stays archive-only, as Real Estate's
--            deals do (2026-10-03).
--
--        A line on a customer's timeline that's also about one of these stays
--        with the customer: notes made on a customer default to their open
--        lead, so a lead on a note doesn't make it the lead's. The system's
--        own lines about what goes (its event is about it, or about a task,
--        a file or a relationship going with it) go too.
--
--        What an add-on keeps that needs it (Real Estate's vendors need their
--        company) stops it going, as a legal or retention hold does.
--
--        Companies and records hide in the bin as round one's rows do, by
--        row-level security on `bin_item_id`. A company is archived too, so
--        phones put it away with what they already hide.
--
--        Found on the way, and fixed here:
--          - A referral that made a lead had to keep naming it, so emptying
--            the bin of that lead, or of its customer, failed.
--          - Emptying a customer took a lead of theirs that was already in
--            the bin on its own and left its bin item empty. That item now
--            goes with them, and a lead isn't brought back while its
--            customer (or, for a company's own lead, its company) is in the
--            bin.
--          - A stage couldn't be deleted while a lead in the bin was in it.
--            Those leads move to another stage of its kind, as stage.delete
--            moves the ones it can see.
--
--        It drops and remakes two check constraints (the bin's kinds, and the
--        referral's), so push it with the Supabase CLI ("Push with the
--        Supabase CLI" in docs/operations.md).
-- =============================================================================

-- ---------- the kinds ----------
alter table app.bin_items drop constraint bin_items_kind_check;
alter table app.bin_items add constraint bin_items_kind_check
  check (kind in ('person', 'conversation', 'appointment', 'lead', 'company', 'custom_record'));
comment on table app.bin_items is
  'The Deleted bin (2026-10-08): a customer, conversation, booking, lead, company or record deleted, and everything that went with it, kept 30 days and then emptied by the worker.';

-- ---------- the marks ----------
alter table app.companies add column bin_item_id uuid references app.bin_items (id);
alter table app.custom_records add column bin_item_id uuid references app.bin_items (id);
create index companies_bin_idx on app.companies (bin_item_id) where bin_item_id is not null;
create index custom_records_bin_idx on app.custom_records (bin_item_id) where bin_item_id is not null;
-- A company's and a record's files, whatever state they're in (files_record_idx only has the ready ones).
create index files_company_record_idx on app.files (record_id) where record_type in ('company', 'custom_record');

comment on column app.companies.bin_item_id is
  'In the Deleted bin, with what was only the company''s: hidden, archived, and emptied after 30 days.';
comment on column app.custom_records.bin_item_id is
  'In the Deleted bin, with what was only the record''s: hidden, and emptied after 30 days.';

-- ---------- hidden ----------
create policy companies_not_binned on app.companies as restrictive for all
  to authenticated, portal_actor, service_actor using (bin_item_id is null) with check (bin_item_id is null);
create policy custom_records_not_binned on app.custom_records as restrictive for all
  to authenticated, portal_actor, service_actor using (bin_item_id is null) with check (bin_item_id is null);

-- ---------- what goes ----------
alter type private.bin_rows add attribute companies uuid[], add attribute records uuid[];

-- A system timeline line: as 20261027000400 wrote it, plus letting go of a lead, a company or a record emptied from
-- the bin. The line stays (it's about a customer too), and only the link goes.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (private.purging_workspace(old.workspace_id) or private.bin_working(old.workspace_id)) then
    return old;
  end if;
  if old.kind = 'system' then
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids', 'bin_item_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids', 'bin_item_id']) then
      return new;
    end if;
    if tg_op = 'UPDATE' and private.bin_working(old.workspace_id)
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'sealed', 'seal_scope', 'seal_viewer_ids', 'lead_id',
              'company_id', 'custom_record_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'sealed', 'seal_scope', 'seal_viewer_ids', 'lead_id',
              'company_id', 'custom_record_id'])
       and (new.lead_id is null or new.lead_id = old.lead_id)
       and (new.company_id is null or new.company_id = old.company_id)
       and (new.custom_record_id is null or new.custom_record_id = old.custom_record_id) then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'person_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'person_id'])
       and coalesce(private.merging_person(old.person_id::text, new.person_id::text), false) then
      return new;
    end if;
    -- An add-on's own line, losing its words while that add-on's data is deleted.
    if tg_op = 'UPDATE' and old.subtype = 'addon_line'
       and (to_jsonb(new) - array['body', 'meta', 'updated_at']) = (to_jsonb(old) - array['body', 'meta', 'updated_at'])
       and new.meta -> 'addon' = old.meta -> 'addon' and new.body is null
       and coalesce(private.purging_addon(old.workspace_id, old.meta -> 'addon' ->> 'id'), false) then
      return new;
    end if;
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Everything not yet in the bin that goes with one customer, conversation, booking, lead, company or record.
create or replace function private.bin_rows_of(p_kind text, p_record uuid)
returns private.bin_rows language plpgsql stable security definer set search_path = '' as $$
declare
  r private.bin_rows;
  v_ws uuid;
begin
  r := row('{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}')::private.bin_rows;
  if p_kind = 'person' then
    select p.workspace_id into v_ws from app.people p where p.id = p_record;
    -- The customer, and the duplicates merged into them (empty shells that still carry their details).
    r.people := array(select p.id from app.people p
                      where (p.id = p_record or p.merged_into_id = p_record) and p.bin_item_id is null);
    r.leads := array(select l.id from app.leads l where l.person_id = any (r.people) and l.bin_item_id is null);
    r.conversations := array(select c.id from app.conversations c
                             where c.person_id = any (r.people) and c.bin_item_id is null);
    r.calls := array(
      select k.id from app.calls k where k.person_id = any (r.people) and k.bin_item_id is null
      union
      select k.id from app.calls k where k.conversation_id = any (r.conversations) and k.bin_item_id is null);
    -- Their bookings: the ones nobody else is on (with what hangs off them), and their own seat on the others.
    -- A class time (a session) is the business's schedule, so only their seat on it goes, even when they were alone.
    r.appointments := array(
      select x.id from (
        select t.appointment_id as id from app.appointment_attendees t where t.person_id = any (r.people)
        union
        select a.id from app.appointments a where a.lead_id = any (r.leads)
      ) x
      join app.appointments a on a.id = x.id and a.bin_item_id is null and a.kind = 'booking'
      where not exists (select 1 from app.appointment_attendees o
                        where o.appointment_id = x.id and not (o.person_id = any (r.people))));
    r.attendees := array(select t.id from app.appointment_attendees t
                         where (t.person_id = any (r.people) or t.appointment_id = any (r.appointments))
                           and t.bin_item_id is null);
    r.tasks := array(
      select t.id from app.tasks t where t.person_id = any (r.people) and t.bin_item_id is null
      union
      select t.id from app.tasks t where t.lead_id = any (r.leads) and t.bin_item_id is null);
    r.files := array(select f.id from app.files f
                     where ((f.record_type = 'person' and f.record_id = any (r.people))
                         or (f.record_type = 'lead' and f.record_id = any (r.leads)))
                       and f.bin_item_id is null);
    r.relationships := array(select x.id from app.relationships x
                             where (x.a_person_id = any (r.people) or x.b_person_id = any (r.people))
                               and x.bin_item_id is null);
    r.responses := array(
      select f.id from app.form_responses f where f.person_id = any (r.people) and f.bin_item_id is null
      union
      select f.id from app.form_responses f where f.lead_id = any (r.leads) and f.bin_item_id is null);
  elsif p_kind = 'conversation' then
    select c.workspace_id into v_ws from app.conversations c where c.id = p_record and c.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.conversations := array[p_record];
    r.calls := array(select k.id from app.calls k where k.conversation_id = p_record and k.bin_item_id is null);
  elsif p_kind = 'appointment' then
    select a.workspace_id into v_ws from app.appointments a where a.id = p_record and a.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.appointments := array[p_record];
    r.attendees := array(select t.id from app.appointment_attendees t
                         where t.appointment_id = p_record and t.bin_item_id is null);
  elsif p_kind = 'lead' then
    select l.workspace_id into v_ws from app.leads l where l.id = p_record and l.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.leads := array[p_record];
    -- A task is put on a lead on purpose, so its tasks go with it.
    r.tasks := array(select t.id from app.tasks t where t.lead_id = p_record and t.bin_item_id is null);
    r.files := array(select f.id from app.files f
                     where f.record_type = 'lead' and f.record_id = p_record and f.bin_item_id is null);
  elsif p_kind = 'company' then
    select c.workspace_id into v_ws from app.companies c where c.id = p_record and c.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.companies := array[p_record];
    -- The leads that are only the company's. A lead with a customer stays theirs.
    r.leads := array(select l.id from app.leads l
                     where l.company_id = p_record and l.person_id is null and l.bin_item_id is null);
    -- Those leads' tasks, and the company's own: not a customer's, a record's or a lead that stays.
    r.tasks := array(
      select t.id from app.tasks t where t.lead_id = any (r.leads) and t.bin_item_id is null
      union
      select t.id from app.tasks t
      where t.company_id = p_record and t.bin_item_id is null and t.person_id is null
        and t.custom_record_id is null and (t.lead_id is null or t.lead_id = any (r.leads)));
    r.files := array(select f.id from app.files f
                     where ((f.record_type = 'company' and f.record_id = p_record)
                         or (f.record_type = 'lead' and f.record_id = any (r.leads)))
                       and f.bin_item_id is null);
    r.relationships := array(select x.id from app.relationships x
                             where (x.a_company_id = p_record or x.b_company_id = p_record)
                               and x.bin_item_id is null);
  elsif p_kind = 'custom_record' then
    select k.workspace_id into v_ws from app.custom_records k where k.id = p_record and k.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.records := array[p_record];
    -- A task is put on a record on purpose, so its tasks go with it.
    r.tasks := array(select t.id from app.tasks t where t.custom_record_id = p_record and t.bin_item_id is null);
    r.files := array(select f.id from app.files f
                     where f.record_type = 'custom_record' and f.record_id = p_record and f.bin_item_id is null);
    r.relationships := array(select x.id from app.relationships x
                             where (x.a_custom_record_id = p_record or x.b_custom_record_id = p_record)
                               and x.bin_item_id is null);
  else
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;

  r.messages := array(select m.id from app.messages m
                      where m.conversation_id = any (r.conversations) and m.bin_item_id is null);
  -- Timeline lines. A customer's: theirs and their leads', each message's and call's, and each booking's. A lead's,
  -- a company's or a record's: the ones about nothing else that stays, and the system's lines whose event is about
  -- what goes (it, or a task, a file or a relationship going with it).
  r.activities := array(
    select a.id from app.activities a
    where a.workspace_id = v_ws and a.person_id = any (r.people) and a.bin_item_id is null
    union
    select a.id from app.activities a
    where p_kind = 'person' and a.workspace_id = v_ws and a.lead_id = any (r.leads) and a.bin_item_id is null
    union
    select a.id from app.activities a
    where p_kind in ('lead', 'company', 'custom_record') and a.workspace_id = v_ws and a.bin_item_id is null
      and (a.lead_id = any (r.leads) or a.company_id = any (r.companies) or a.custom_record_id = any (r.records))
      and ((a.person_id is null
            and (a.lead_id is null or a.lead_id = any (r.leads))
            and (a.company_id is null or a.company_id = any (r.companies))
            and (a.custom_record_id is null or a.custom_record_id = any (r.records)))
           or (a.kind = 'system' and exists (
             select 1 from app.events e
             where e.id = a.event_id
               and ((e.entity_type = 'lead' and e.entity_id = any (r.leads))
                 or (e.entity_type = 'company' and e.entity_id = any (r.companies))
                 or (e.entity_type = 'custom_record' and e.entity_id = any (r.records))
                 or (e.entity_type = 'task' and e.entity_id = any (r.tasks))
                 or (e.entity_type = 'file' and e.entity_id = any (r.files))
                 or (e.entity_type = 'relationship' and e.entity_id = any (r.relationships))))))
    union
    select a.id from app.messages m join app.activities a on a.id = m.activity_id
    where m.id = any (r.messages) and a.bin_item_id is null
    union
    select a.id from app.calls k join app.activities a on a.id = k.activity_id
    where k.id = any (r.calls) and a.bin_item_id is null
    union
    select a.id from app.appointment_attendees t
    join app.activities a on a.workspace_id = v_ws and a.person_id = t.person_id
    where t.id = any (r.attendees) and a.bin_item_id is null
      and a.meta ->> 'appointmentId' = t.appointment_id::text);
  return r;
end $$;

-- Whether an add-on keeps rows that need this one: a key from one of its own tables (schema addon_<id>) that would
-- take them with it, or stop it going. Answers the add-on's id, or nothing. A key that lets go (set null) is the
-- add-on saying it can do without it.
create or replace function private.bin_addon_using(p_table regclass, p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_key record;
  v_used boolean;
begin
  for v_key in
    select n.nspname as schema_name, c.relname as table_name, a.attname as column_name
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f' and k.confrelid = p_table and cardinality(k.conkey) = 1
      and k.confdeltype in ('a', 'r', 'c') and n.nspname like 'addon\_%'
    order by n.nspname, c.relname, a.attname
  loop
    execute format('select exists (select 1 from %I.%I x where x.%I = $1)', v_key.schema_name, v_key.table_name,
      v_key.column_name) into v_used using p_id;
    if v_used then
      return substr(v_key.schema_name, 7);
    end if;
  end loop;
  return null;
end $$;
revoke all on function private.bin_addon_using(regclass, uuid) from public;

-- Why these rows can't go, in words for the person deleting, or nothing. p_name names what's deleted. An add-on is
-- named {addon:<id>}, which core puts in its own words.
create or replace function private.bin_blocker(p_kind text, p_name text, r private.bin_rows,
  out rule text, out message text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_record uuid;
  v_record_name text;
  v_kept text;
  v_file text;
  v_at timestamptz;
  v_tz text;
  v_when text;
  v_addon text;
  v_private boolean;
begin
  if p_kind = 'person' and exists (
    select 1 from app.subscriptions s
    where s.person_id = any (r.people) and s.status in ('active', 'past_due', 'paused')) then
    rule := 'bin_plan_running';
    message := format('%s has a plan that’s still billing. Cancel it on their Money tab first, then delete them.',
      p_name);
    return;
  end if;

  if p_kind = 'custom_record' then
    -- An add-on's records are the add-on's to keep (Real Estate's deals stay archive-only, 2026-10-03).
    select t.addon_id, k.kept_to_team into v_addon, v_private
    from app.custom_records k join app.custom_record_types t on t.id = k.type_id
    where k.id = any (r.records);
    if v_addon is not null then
      rule := 'bin_record_addon';
      message := format('%s belongs to the {addon:%s} add-on, so it can only be archived.', p_name, v_addon);
      return;
    end if;
    -- What a private record seals would show to everyone once it was gone (only add-ons' kinds are private yet).
    if v_private then
      rule := 'bin_record_private';
      message := format('%s is kept to the people on it, so it can only be archived.', p_name);
      return;
    end if;
    v_kept := private.record_kept(r.records[1]);
    if v_kept is not null then
      rule := 'bin_record_kept';
      message := format('%s is %s, so it has to stay. Archive it instead.', p_name, v_kept);
      return;
    end if;
  end if;

  -- What an add-on keeps that needs it (Real Estate's vendors need their company).
  if p_kind in ('lead', 'company', 'custom_record') then
    select x.addon into v_addon from (
      select private.bin_addon_using('app.leads'::regclass, l) as addon from unnest(r.leads) l
      union all
      select private.bin_addon_using('app.companies'::regclass, c) from unnest(r.companies) c
      union all
      select private.bin_addon_using('app.custom_records'::regclass, k) from unnest(r.records) k
    ) x
    where x.addon is not null
    limit 1;
    if v_addon is not null then
      rule := 'bin_addon_uses';
      message := format('%s is used by the {addon:%s} add-on, so it has to stay. Archive it instead.', p_name, v_addon);
      return;
    end if;
  end if;

  select f.name into v_file from app.files f
  where f.id = any (r.files) and f.locked_at is not null and f.deleted_at is null
  limit 1;
  if v_file is not null then
    rule := 'bin_signed_file';
    message := format('%s has a signed file, %s, and signed files are kept for good. Archive %s instead.',
      p_name, v_file, case when p_kind = 'person' then 'them' else 'it' end);
    return;
  end if;

  -- History on a record that's being kept (Real Estate: a deal still open, closed within its years, or on legal
  -- hold).
  select x.record_id into v_record from (
    select a.custom_record_id as record_id from app.activities a
    where a.id = any (r.activities) and a.custom_record_id is not null
    union all
    select t.custom_record_id from app.tasks t where t.id = any (r.tasks) and t.custom_record_id is not null
    union all
    select c.custom_record_id from app.conversations c
    where c.id = any (r.conversations) and c.custom_record_id is not null
    union all
    select a.custom_record_id from app.appointments a
    where (a.id = any (r.appointments)
           or a.id in (select t.appointment_id from app.appointment_attendees t where t.id = any (r.attendees)))
      and a.custom_record_id is not null
    union all
    select x.a_custom_record_id from app.relationships x
    where x.id = any (r.relationships) and x.a_custom_record_id is not null
    union all
    select x.b_custom_record_id from app.relationships x
    where x.id = any (r.relationships) and x.b_custom_record_id is not null
  ) x
  where not (x.record_id = any (r.records)) and private.record_kept(x.record_id) is not null
  limit 1;
  if v_record is not null then
    select cr.name into v_record_name from app.custom_records cr where cr.id = v_record;
    v_record_name := coalesce(v_record_name, 'a record');
    v_kept := private.record_kept(v_record);
    rule := 'bin_record_kept';
    message := case p_kind
      when 'person' then format('%s is on %s, which is %s, so their history there has to stay. Archive them instead.',
        p_name, v_record_name, v_kept)
      when 'conversation' then format('This conversation is part of %s, which is %s, so it has to stay. Archive it instead.',
        v_record_name, v_kept)
      when 'lead' then format('This lead is part of %s, which is %s, so it has to stay. Archive it instead.',
        v_record_name, v_kept)
      when 'company' then format('%s is on %s, which is %s, so its history there has to stay. Archive it instead.',
        p_name, v_record_name, v_kept)
      when 'custom_record' then format('%s is related to %s, which is %s, so it has to stay. Archive it instead.',
        p_name, v_record_name, v_kept)
      else format('This booking is part of %s, which is %s, so it has to stay.', v_record_name, v_kept) end;
    return;
  end if;

  if exists (select 1 from app.messages m
             where m.id = any (r.messages)
               and (m.status = 'sending' or (m.status = 'queued' and m.error_code is distinct from 'scheduled'))) then
    rule := 'bin_still_sending';
    message := case when p_kind = 'person'
      then format('A message to %s is still going out. Try again in a minute.', p_name)
      else 'A message in this conversation is still going out. Try again in a minute.' end;
    return;
  end if;

  if exists (select 1 from app.calls k
             where k.id = any (r.calls) and k.status in ('initiated', 'ringing', 'in_progress')) then
    rule := 'bin_call_live';
    message := case when p_kind = 'person'
      then format('A call with %s is still going on. Try again when it ends.', p_name)
      else 'A call in this conversation is still going on. Try again when it ends.' end;
    return;
  end if;

  -- A booking still to come is cancelled first: the command does it, and tells the customer if asked to.
  select a.starts_at, coalesce(w.timezone, 'UTC') into v_at, v_tz
  from app.appointments a join app.workspaces w on w.id = a.workspace_id
  where a.status = 'scheduled' and a.ends_at > now()
    and (a.id = any (r.appointments)
         or a.id in (select t.appointment_id from app.appointment_attendees t
                     where t.id = any (r.attendees) and t.status = 'booked'))
  order by a.starts_at
  limit 1;
  if v_at is not null then
    v_when := to_char(v_at at time zone v_tz, 'FMMonth FMDD');
    rule := 'bin_upcoming_booking';
    message := case when p_kind = 'person'
      then format('%s has a booking still to come, on %s. Cancel it first, then delete them.', p_name, v_when)
      else format('This booking is still to come, on %s. Cancel it first, then delete it.', v_when) end;
    return;
  end if;
end $$;

-- What it's called in the bin.
create or replace function private.bin_name(p_kind text, p_record uuid)
returns text language sql stable security definer set search_path = '' as $$
  select left(coalesce(case p_kind
    when 'person' then (
      select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') from app.people p where p.id = p_record)
    when 'conversation' then (
      select coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), mc.name,
        '@' || mc.username, nullif(btrim(v.name), ''), v.email, v.phone_e164,
        case when c.channel in ('sms', 'email') then c.counterpart end)
      from app.conversations c
      left join app.people p on p.id = c.person_id
      left join app.meta_contacts mc on mc.conversation_id = c.id
      left join app.chat_visitors v on v.conversation_id = c.id
      where c.id = p_record)
    when 'appointment' then (
      select coalesce(nullif(btrim(a.title), ''), s.name)
      from app.appointments a left join app.services s on s.id = a.service_id where a.id = p_record)
    when 'lead' then (select nullif(btrim(l.title), '') from app.leads l where l.id = p_record)
    when 'company' then (select nullif(btrim(c.name), '') from app.companies c where c.id = p_record)
    when 'custom_record' then (select nullif(btrim(k.name), '') from app.custom_records k where k.id = p_record)
  end, case p_kind
    when 'person' then 'A customer'
    when 'conversation' then 'A conversation'
    when 'lead' then 'A lead'
    when 'company' then 'A company'
    when 'custom_record' then 'A record'
    else 'A booking' end), 300)
$$;

-- How much goes with it, for the delete box and the bin's list. `bills` stay (the owner's decision 4), and
-- `upcoming` bookings are cancelled first. Nothing counts itself. A company's `people` stay, no longer at it; a
-- lead's `who` is whose it is, and a record's `type` its kind.
create or replace function private.bin_contents(p_kind text, p_record uuid, r private.bin_rows)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'upcoming', nullif((
      select count(*) from app.appointments a
      where a.status = 'scheduled' and a.ends_at > now()
        and (a.id = any (r.appointments)
             or a.id in (select t.appointment_id from app.appointment_attendees t
                         where t.id = any (r.attendees) and t.status = 'booked'))), 0),
    'conversations', case when p_kind = 'person' then nullif(cardinality(r.conversations), 0) end,
    'messages', nullif(cardinality(r.messages), 0),
    'calls', nullif(cardinality(r.calls), 0),
    'notes', nullif((select count(*) from app.activities a where a.id = any (r.activities) and a.kind = 'note'), 0),
    'tasks', nullif(cardinality(r.tasks), 0),
    'leads', case when p_kind <> 'lead' then nullif(cardinality(r.leads), 0) end,
    'bookings', case when p_kind = 'person' then nullif(cardinality(r.attendees), 0) end,
    'files', nullif((select count(*) from app.files f where f.id = any (r.files) and f.deleted_at is null), 0),
    'forms', nullif(cardinality(r.responses), 0),
    'relationships', case when p_kind in ('company', 'custom_record') then nullif(cardinality(r.relationships), 0) end,
    'bills', case when p_kind = 'person' then nullif(
      (select count(*) from app.invoices i where i.person_id = any (r.people))
      + (select count(*) from app.estimates e where e.person_id = any (r.people))
      + (select count(*) from app.subscriptions s where s.person_id = any (r.people)), 0) end,
    'people', case when p_kind = 'company' then nullif((
      select count(*) from app.people p
      where p.company_id = any (r.companies) and p.bin_item_id is null and p.erased_at is null
        and p.merged_into_id is null), 0) end,
    'channel', (select c.channel::text from app.conversations c where p_kind = 'conversation' and c.id = p_record),
    'startsAt', (select a.starts_at from app.appointments a where p_kind = 'appointment' and a.id = p_record),
    'who', case p_kind
      when 'appointment' then (
        select jsonb_agg(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') order by t.created_at)
        from app.appointment_attendees t join app.people p on p.id = t.person_id
        where t.appointment_id = p_record)
      when 'lead' then (
        select jsonb_build_array(coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), c.name))
        from app.leads l
        left join app.people p on p.id = l.person_id
        left join app.companies c on c.id = l.company_id
        where l.id = p_record) end,
    'type', (select t.singular from app.custom_records k join app.custom_record_types t on t.id = k.type_id
             where p_kind = 'custom_record' and k.id = p_record)
  ))
$$;

-- Marks the rows with the bin item and hides them from phones, and answers what bringing them back undoes.
create or replace function private.bin_mark(p_item uuid, r private.bin_rows)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_undo jsonb;
begin
  v_undo := jsonb_build_object(
    'people', to_jsonb(array(select p.id from app.people p where p.id = any (r.people) and p.archived_at is null)),
    'companies', to_jsonb(array(select c.id from app.companies c
                                where c.id = any (r.companies) and c.archived_at is null)),
    'leads', to_jsonb(array(select l.id from app.leads l where l.id = any (r.leads) and l.archived_at is null)),
    'conversations', to_jsonb(array(select c.id from app.conversations c
                                    where c.id = any (r.conversations) and c.archived_at is null)),
    'files', to_jsonb(array(select f.id from app.files f where f.id = any (r.files) and f.deleted_at is null)));

  -- Archived, so phones put them away with what they already hide. A business's own records never reach phones.
  update app.people p set bin_item_id = p_item, archived_at = coalesce(p.archived_at, now())
  where p.id = any (r.people);
  update app.companies c set bin_item_id = p_item, archived_at = coalesce(c.archived_at, now())
  where c.id = any (r.companies);
  update app.custom_records k set bin_item_id = p_item where k.id = any (r.records);
  update app.leads l set bin_item_id = p_item, archived_at = coalesce(l.archived_at, now())
  where l.id = any (r.leads);
  update app.conversations c set bin_item_id = p_item, archived_at = coalesce(c.archived_at, now())
  where c.id = any (r.conversations);
  update app.messages m set bin_item_id = p_item, sync_window = false where m.id = any (r.messages);
  update app.calls k set bin_item_id = p_item, sync_window = false where k.id = any (r.calls);
  update app.activities a set bin_item_id = p_item, sync_window = false where a.id = any (r.activities);
  -- Their triggers work the phone's flag out.
  update app.tasks t set bin_item_id = p_item where t.id = any (r.tasks);
  update app.appointments a set bin_item_id = p_item where a.id = any (r.appointments);
  update app.appointment_attendees t set bin_item_id = p_item, sync_window = false where t.id = any (r.attendees);
  update app.relationships x set bin_item_id = p_item where x.id = any (r.relationships);
  update app.form_responses f set bin_item_id = p_item where f.id = any (r.responses);
  -- Marked deleted, which is how phones leave a file out.
  update app.files f set bin_item_id = p_item, deleted_at = coalesce(f.deleted_at, now()) where f.id = any (r.files);
  return v_undo;
end $$;

-- What doesn't come back: workflows stop with their approvals, Home's cards and the AI's waiting drafts and calls
-- go, a place on a waitlist is given up, and the customer's portal signs out. A customer going takes every card and
-- draft that names their leads; a lead going alone takes only the cards about it, and a reply to its customer stays.
create or replace function private.bin_let_go(p_ws uuid, r private.bin_rows)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[] := r.people || r.leads || r.conversations || r.appointments || r.attendees || r.tasks
    || r.companies || r.records;
  v_customer constant boolean := cardinality(r.people) > 0;
  v_drafts uuid[];
begin
  -- A run's approvals still waiting go with it, as when a run is stopped by hand (the worker's cancelRunWork).
  with stopped as (
    update app.workflow_runs w set status = 'stopped', end_reason = 'deleted', ended_at = now()
    where w.workspace_id = p_ws and w.status in ('running', 'waiting', 'awaiting_approval', 'held')
      and (w.person_id = any (r.people) or w.lead_id = any (r.leads) or w.conversation_id = any (r.conversations)
           or w.appointment_id = any (r.appointments))
    returning w.id)
  update app.workflow_approvals a set status = 'cancelled', decided_at = now(), via = 'system'
  where a.run_id in (select s.id from stopped s) and a.status = 'pending';
  -- Calls the AI was still to make (waiting for an OK, or queued) aren't made, and their OKs aren't asked.
  with off as (
    update app.ai_calls k set status = 'cancelled', reason = 'deleted'
    where k.workspace_id = p_ws and k.status in ('awaiting_approval', 'queued')
      and (k.person_id = any (r.people) or k.attendee_id = any (r.attendees) or k.missed_call_id = any (r.calls))
    returning k.draft_id)
  select array(select o.draft_id from off o where o.draft_id is not null) into v_drafts;
  delete from app.ai_teammate_drafts d where d.id = any (v_drafts) and d.status = 'pending';
  delete from app.attention_items i
  where i.workspace_id = p_ws
    and (i.person_id = any (r.people) or (v_customer and i.lead_id = any (r.leads))
         or i.conversation_id = any (r.conversations) or i.subject_id = any (v_ids));
  delete from app.ai_teammate_drafts d
  where d.workspace_id = p_ws and d.status = 'pending'
    and (d.conversation_id = any (r.conversations) or d.person_id = any (r.people)
         or (v_customer and d.lead_id = any (r.leads)) or d.custom_record_id = any (r.records));
  update app.waitlist_entries e set status = 'removed'
  where e.workspace_id = p_ws and e.status in ('waiting', 'offered')
    and (e.person_id = any (r.people) or e.appointment_id = any (r.appointments));
  delete from app.portal_sessions s where s.person_id = any (r.people);
end $$;

-- Puts one thing in the bin, as the person deleting it; answers the bin item.
create or replace function private.bin_put(p_kind text, p_record uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_gone boolean;
  v_name text;
  v_rows private.bin_rows;
  v_block record;
  v_item uuid;
begin
  if p_kind = 'person' then
    select p.workspace_id, p.bin_item_id is not null or p.erased_at is not null
    into v_ws, v_gone from app.people p where p.id = p_record for update;
    if v_ws is not null and not v_gone and exists (
      select 1 from app.people p where p.id = p_record and p.merged_into_id is not null) then
      raise exception 'This customer was merged into another one. Delete the one they were merged into instead.'
        using errcode = '55000', detail = 'bin_person_merged';
    end if;
  elsif p_kind = 'conversation' then
    select c.workspace_id, c.bin_item_id is not null
                           or (c.private_to is not null and c.private_to is distinct from auth.uid())
    into v_ws, v_gone from app.conversations c where c.id = p_record for update;
  elsif p_kind = 'appointment' then
    select a.workspace_id, a.bin_item_id is not null
    into v_ws, v_gone from app.appointments a where a.id = p_record for update;
  elsif p_kind = 'lead' then
    select l.workspace_id, l.bin_item_id is not null
    into v_ws, v_gone from app.leads l where l.id = p_record for update;
  elsif p_kind = 'company' then
    select c.workspace_id, c.bin_item_id is not null
    into v_ws, v_gone from app.companies c where c.id = p_record for update;
  elsif p_kind = 'custom_record' then
    select k.workspace_id, k.bin_item_id is not null or k.purged_at is not null
                           or not private.custom_record_visible(k.id)
    into v_ws, v_gone from app.custom_records k where k.id = p_record for update;
  else
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;
  if v_ws is null or v_gone then
    raise exception 'That isn’t here any more. Someone may have deleted it already. Refresh to see what’s left.'
      using errcode = 'P0002', detail = 'bin_record_gone';
  end if;
  perform private.bin_assert_may_delete(v_ws);

  v_name := private.bin_name(p_kind, p_record);
  v_rows := private.bin_rows_of(p_kind, p_record);
  select * into v_block from private.bin_blocker(p_kind, v_name, v_rows);
  if v_block.rule is not null then
    raise exception '%', v_block.message using errcode = '55000', detail = v_block.rule;
  end if;

  insert into private.bin_work (workspace_id) values (v_ws) on conflict do nothing;
  insert into app.bin_items (workspace_id, kind, record_id, name, contents, deleted_by)
  values (v_ws, p_kind, p_record, v_name, private.bin_contents(p_kind, p_record, v_rows), auth.uid())
  returning id into v_item;
  update app.bin_items b set undo = private.bin_mark(v_item, v_rows) where b.id = v_item;
  perform private.bin_let_go(v_ws, v_rows);
  delete from private.bin_work w where w.workspace_id = v_ws;
  return v_item;
end $$;

-- What deleting these would take, or why it can't, for the delete box. Only what the caller may delete is
-- answered; anything else, or already gone, answers bin_record_gone.
create or replace function private.bin_preview(p_kind text, p_ids uuid[])
returns table (record_id uuid, name text, contents jsonb, rule text, message text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
  v_ws uuid;
  v_rows private.bin_rows;
  v_block record;
begin
  if p_kind not in ('person', 'conversation', 'appointment', 'lead', 'company', 'custom_record') then
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    v_ws := case p_kind
      when 'person' then (select p.workspace_id from app.people p
                          where p.id = v_id and p.bin_item_id is null and p.erased_at is null)
      when 'conversation' then (select c.workspace_id from app.conversations c
                                where c.id = v_id and c.bin_item_id is null
                                  and (c.private_to is null or c.private_to = auth.uid()))
      when 'lead' then (select l.workspace_id from app.leads l where l.id = v_id and l.bin_item_id is null)
      when 'company' then (select c.workspace_id from app.companies c where c.id = v_id and c.bin_item_id is null)
      when 'custom_record' then (select k.workspace_id from app.custom_records k
                                 where k.id = v_id and k.bin_item_id is null and k.purged_at is null
                                   and private.custom_record_visible(k.id))
      else (select a.workspace_id from app.appointments a where a.id = v_id and a.bin_item_id is null) end;
    record_id := v_id;
    if v_ws is null or not coalesce(private.has_permission(v_ws, 'records.delete'), false) then
      name := null;
      contents := '{}'::jsonb;
      rule := 'bin_record_gone';
      message := 'That isn’t here any more. Someone may have deleted it already. Refresh to see what’s left.';
      return next;
      continue;
    end if;
    name := private.bin_name(p_kind, v_id);
    v_rows := private.bin_rows_of(p_kind, v_id);
    contents := private.bin_contents(p_kind, v_id, v_rows);
    select * into v_block from private.bin_blocker(p_kind, name, v_rows);
    rule := v_block.rule;
    message := v_block.message;
    return next;
  end loop;
end $$;

-- ---------- back out ----------
-- Brings a bin item back, as the person doing it. A thread whose line has had a new thread since joins that one:
-- its messages and calls move there, and the new thread becomes the customer's if it had nobody. A lead comes back
-- only to a customer, or a company, that's here.
create or replace function private.restore_bin_item(p_item uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item app.bin_items%rowtype;
  v_conv app.conversations%rowtype;
  v_into uuid;
  v_folded integer := 0;
  v_whose text;
  v_whose_company text;
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  select * into v_item from app.bin_items b where b.id = p_item for update;
  if not found then
    raise exception 'That isn’t in the Deleted bin any more. Refresh to see what’s left.'
      using errcode = 'P0002', detail = 'bin_item_gone';
  end if;
  perform private.bin_assert_may_delete(v_item.workspace_id);
  if v_item.purging_since is not null then
    raise exception '% is already being deleted for good, so it can’t be brought back.', v_item.name
      using errcode = '55000', detail = 'bin_item_emptying';
  end if;
  if v_item.kind = 'lead' then
    select case when p.bin_item_id is not null
             then coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), 'Its customer') end,
           case when l.person_id is null and c.bin_item_id is not null then c.name end
    into v_whose, v_whose_company
    from app.leads l
    left join app.people p on p.id = l.person_id
    left join app.companies c on c.id = l.company_id
    where l.id = v_item.record_id;
    if v_whose is not null then
      raise exception 'This lead is for %, who’s in the Deleted bin too. Bring them back first.', v_whose
        using errcode = '55000', detail = 'bin_restore_parent';
    end if;
    if v_whose_company is not null then
      raise exception 'This lead is for %, which is in the Deleted bin too. Bring it back first.', v_whose_company
        using errcode = '55000', detail = 'bin_restore_parent';
    end if;
  end if;
  insert into private.bin_work (workspace_id) values (v_item.workspace_id) on conflict do nothing;

  for v_conv in select c.* from app.conversations c where c.bin_item_id = p_item loop
    select l.id into v_into from app.conversations l
    where l.workspace_id = v_conv.workspace_id and l.channel = v_conv.channel and l.counterpart = v_conv.counterpart
      and coalesce(case when l.channel = 'email' then l.email_address_id else l.phone_number_id end, v_nil)
        = coalesce(case when v_conv.channel = 'email' then v_conv.email_address_id else v_conv.phone_number_id end, v_nil)
      and l.bin_item_id is null and l.id <> v_conv.id;
    if v_into is not null then
      update app.messages m set conversation_id = v_into where m.conversation_id = v_conv.id;
      update app.calls k set conversation_id = v_into where k.conversation_id = v_conv.id;
      update app.conversations l set person_id = v_conv.person_id
      where l.id = v_into and l.person_id is null and l.private_to is null and v_conv.person_id is not null;
      delete from app.conversations c where c.id = v_conv.id;
      v_folded := v_folded + 1;
    end if;
  end loop;

  update app.people p set bin_item_id = null,
    archived_at = case when v_item.undo -> 'people' ? p.id::text then null else p.archived_at end
  where p.bin_item_id = p_item;
  update app.companies c set bin_item_id = null,
    archived_at = case when v_item.undo -> 'companies' ? c.id::text then null else c.archived_at end
  where c.bin_item_id = p_item;
  update app.custom_records k set bin_item_id = null where k.bin_item_id = p_item;
  update app.leads l set bin_item_id = null,
    archived_at = case when v_item.undo -> 'leads' ? l.id::text then null else l.archived_at end
  where l.bin_item_id = p_item;
  update app.conversations c set bin_item_id = null,
    archived_at = case when v_item.undo -> 'conversations' ? c.id::text then null else c.archived_at end
  where c.bin_item_id = p_item;
  -- Back on phones by 0056's rules: the last 12 months, or a thread still open.
  update app.messages m set bin_item_id = null,
    sync_window = m.occurred_at >= now() - interval '12 months'
      or exists (select 1 from app.conversations c where c.id = m.conversation_id and c.status <> 'closed')
  where m.bin_item_id = p_item;
  update app.calls k set bin_item_id = null,
    sync_window = k.started_at >= now() - interval '12 months'
      or exists (select 1 from app.conversations c where c.id = k.conversation_id and c.status <> 'closed')
  where k.bin_item_id = p_item;
  update app.activities a set bin_item_id = null, sync_window = a.occurred_at >= now() - interval '12 months'
  where a.bin_item_id = p_item;
  update app.tasks t set bin_item_id = null where t.bin_item_id = p_item;
  update app.appointments a set bin_item_id = null where a.bin_item_id = p_item;
  update app.appointment_attendees t set bin_item_id = null, sync_window = true where t.bin_item_id = p_item;
  update app.relationships x set bin_item_id = null where x.bin_item_id = p_item;
  update app.form_responses f set bin_item_id = null where f.bin_item_id = p_item;
  update app.files f set bin_item_id = null,
    deleted_at = case when v_item.undo -> 'files' ? f.id::text then null else f.deleted_at end
  where f.bin_item_id = p_item;

  delete from app.bin_items b where b.id = p_item;
  delete from private.bin_work w where w.workspace_id = v_item.workspace_id;
  return jsonb_build_object('kind', v_item.kind, 'recordId', v_item.record_id, 'name', v_item.name,
    'folded', v_folded);
end $$;

-- ---------- emptying ----------
-- History keeps its lines and drops their details (the owner's rule, 2026-09-28), except the lines that say what
-- was deleted, brought back or emptied, by whom and when.
create or replace function private.bin_redact(p_ws uuid, p_type text, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_kept constant text[] := array['person.deleted', 'conversation.deleted', 'appointment.deleted', 'lead.deleted',
    'company.deleted', 'custom_record.deleted', 'bin.restored', 'bin.emptied'];
begin
  update app.audit_logs a set before = null, after = null
  where a.entity_type = p_type and a.entity_id = any (p_ids) and a.workspace_id = p_ws
    and (a.before is not null or a.after is not null)
    and not exists (select 1 from app.events e where e.id = a.event_id and e.event_type = any (v_kept));
  update app.events e set payload = '{"_redacted": true}'::jsonb
  where e.entity_type = p_type and e.entity_id = any (p_ids) and e.workspace_id = p_ws
    and not (e.payload ? '_redacted') and not (e.event_type = any (v_kept));
end $$;

-- Everything in one bin item moves into another, and goes (or comes back) with it from then on.
create or replace function private.bin_absorb(p_from uuid, p_into uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_table text;
begin
  foreach v_table in array array['people', 'companies', 'custom_records', 'leads', 'conversations', 'messages',
    'calls', 'activities', 'tasks', 'appointments', 'appointment_attendees', 'files', 'relationships',
    'form_responses'] loop
    execute format('update app.%I x set bin_item_id = $2 where x.bin_item_id = $1', v_table) using p_from, p_into;
  end loop;
  delete from app.bin_items b where b.id = p_from;
end $$;
revoke all on function private.bin_absorb(uuid, uuid) from public;

-- Empties one bin item a batch at a time, as the worker in that business: answers whether there's more, and what
-- to remove from storage now that its rows are gone.
create or replace function private.purge_bin_batch(p_ws uuid, p_item uuid, p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item app.bin_items%rowtype;
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  -- Each table, the kind of thing its events are about, and how many go at once (a thread takes its events with
  -- it, so fewer).
  v_steps constant text[][] := array[
    array['messages', 'message', '1'],
    array['calls', 'call', '1'],
    array['activities', 'activity', '1'],
    array['tasks', 'task', '1'],
    array['form_responses', 'form_response', '1'],
    array['relationships', 'relationship', '1'],
    array['files', 'file', '1'],
    array['appointment_attendees', 'attendee', '1'],
    array['appointments', 'appointment', '20'],
    array['leads', 'lead', '20'],
    array['conversations', 'conversation', '50'],
    array['custom_records', 'custom_record', '20'],
    array['companies', 'company', '20']
  ];
  v_step text[];
  v_ids uuid[];
  v_objects jsonb;
  v_person app.people%rowtype;
  v_leads uuid[];
  v_keeper uuid;
  v_other uuid;
begin
  perform private.assert_worker_scope(p_ws);
  select * into v_item from app.bin_items b where b.id = p_item and b.workspace_id = p_ws for update;
  if not found then
    return jsonb_build_object('more', false, 'objects', '[]'::jsonb);
  end if;
  if v_item.purging_since is null then
    raise exception 'That isn’t being emptied from the bin' using errcode = '55000', detail = 'bin_not_emptying';
  end if;
  insert into private.bin_work (workspace_id) values (p_ws) on conflict do nothing;

  -- 0. A lead in the bin on its own goes with its customer, or with its company when it's only the company's: its
  --    bin item becomes part of this one.
  for v_other in
    select b.id from app.bin_items b join app.leads l on l.id = b.record_id
    where b.workspace_id = p_ws and b.kind = 'lead' and b.id <> p_item
      and (l.person_id in (select p.id from app.people p where p.bin_item_id = p_item)
           or (l.person_id is null
               and l.company_id in (select c.id from app.companies c where c.bin_item_id = p_item)))
  loop
    perform private.bin_absorb(v_other, p_item);
  end loop;

  -- 1. What went in with it, a batch at a time.
  foreach v_step slice 1 in array v_steps loop
    execute format('select array(select x.id from app.%I x where x.bin_item_id = $1 limit $2)', v_step[1])
      into v_ids using p_item, greatest(1, v_limit / v_step[3]::integer);
    if cardinality(v_ids) > 0 then
      v_objects := private.bin_objects(p_ws, v_step[1], v_ids);
      perform private.bin_redact(p_ws, v_step[2], v_ids);
      -- What else still names them (nothing much should): a task on a lead goes with it, as does a line about
      -- nothing else (a line has to be about something; a customer's lines all go with them), and their tags go.
      -- The rest lets go of them.
      if v_step[1] = 'leads' then
        delete from app.tasks t where t.lead_id = any (v_ids);
        delete from app.activities a where a.lead_id = any (v_ids)
          and (v_item.kind = 'person'
               or (a.person_id is null and a.company_id is null and a.custom_record_id is null));
        delete from app.record_tags t where t.record_type = 'lead' and t.record_id = any (v_ids);
      elsif v_step[1] = 'custom_records' then
        delete from app.activities a where a.custom_record_id = any (v_ids)
          and a.person_id is null and a.company_id is null and a.lead_id is null;
      elsif v_step[1] = 'companies' then
        -- A customer's lead stays theirs, no longer the company's.
        update app.leads l set company_id = null where l.company_id = any (v_ids) and l.person_id is not null;
        delete from app.activities a where a.company_id = any (v_ids)
          and a.person_id is null and a.lead_id is null and a.custom_record_id is null;
        delete from app.record_tags t where t.record_type = 'company' and t.record_id = any (v_ids);
      end if;
      execute format('delete from app.%I x where x.id = any ($1)', v_step[1]) using v_ids;
      delete from private.bin_work w where w.workspace_id = p_ws;
      return jsonb_build_object('more', true, 'objects', v_objects);
    end if;
  end loop;

  -- 2. A customer, and the duplicates merged into them: whatever else names them, one at a time.
  select * into v_person from app.people p where p.bin_item_id = p_item
  order by (p.id = v_item.record_id), p.id limit 1;
  if found then
    v_leads := array(select l.id from app.leads l where l.person_id = v_person.id);
    v_ids := array(select f.id from app.files f
                   where (f.record_type = 'person' and f.record_id = v_person.id)
                      or (f.record_type = 'lead' and f.record_id = any (v_leads)));
    v_objects := private.bin_objects(p_ws, 'files', v_ids);
    perform private.bin_redact(p_ws, 'file', v_ids);
    delete from app.files f where f.id = any (v_ids);
    -- Their seats and waits on bookings (in the bin with a booking, or a group session's).
    delete from app.appointment_attendees t where t.person_id = v_person.id;
    delete from app.waitlist_entries e where e.person_id = v_person.id;
    delete from app.activities a where a.person_id = v_person.id or a.lead_id = any (v_leads);
    delete from app.tasks t where t.person_id = v_person.id or t.lead_id = any (v_leads);
    delete from app.form_responses f where f.person_id = v_person.id or f.lead_id = any (v_leads);
    perform private.bin_redact(p_ws, 'lead', v_leads);
    delete from app.record_tags t where t.record_type = 'lead' and t.record_id = any (v_leads);
    delete from app.leads l where l.id = any (v_leads);
    -- What else holds their details: emails matched to them, what forms and chats took in, automations' and the
    -- AI's runs about them, where they came from, and their jobs.
    delete from app.email_inbound_unmatched u where u.resolved_person_id = v_person.id;
    delete from app.intake_submissions s where s.person_id = v_person.id;
    delete from app.chat_visitors v where v.person_id = v_person.id or v.verified_person_id = v_person.id;
    delete from app.attribution_touches t where t.person_id = v_person.id;
    delete from app.workflow_runs w where w.person_id = v_person.id;
    delete from app.ai_teammate_runs w where w.person_id = v_person.id;
    delete from app.ai_teammate_drafts d where d.person_id = v_person.id;
    delete from app.attention_items i where i.person_id = v_person.id;
    delete from app.jobs j where j.person_id = v_person.id;
    delete from app.record_tags t where t.record_type = 'person' and t.record_id = v_person.id;

    -- Their bills stay, with just their name (the owner's decision 4): on a record of their name alone.
    if exists (select 1 from app.invoices i where i.person_id = v_person.id)
       or exists (select 1 from app.estimates e where e.person_id = v_person.id)
       or exists (select 1 from app.subscriptions s where s.person_id = v_person.id) then
      insert into app.people (workspace_id, first_name, last_name, archived_at, erased_at)
      values (p_ws, v_person.first_name, v_person.last_name, now(), now())
      returning id into v_keeper;
      insert into private.person_merges (from_person_id, into_person_id, workspace_id)
      values (v_person.id, v_keeper, p_ws);
      update app.invoices i set person_id = v_keeper where i.person_id = v_person.id;
      update app.estimates e set person_id = v_keeper where e.person_id = v_person.id;
      update app.subscriptions s set person_id = v_keeper where s.person_id = v_person.id;
      delete from private.person_merges m where m.from_person_id = v_person.id;
    end if;

    perform private.bin_redact(p_ws, 'person', array[v_person.id]);
    -- The rest of what hangs off them (their portal, add-ons' rows about them, reminders, referrals they made)
    -- goes with them, and what only mentions them lets go.
    delete from app.people p where p.id = v_person.id;
    delete from private.bin_work w where w.workspace_id = p_ws;
    return jsonb_build_object('more', true, 'objects', v_objects);
  end if;

  -- 3. Done: the item itself.
  delete from app.bin_items b where b.id = p_item;
  delete from private.bin_work w where w.workspace_id = p_ws;
  return jsonb_build_object('more', false, 'objects', '[]'::jsonb);
end $$;

-- ---------- found on the way ----------
-- A referral that made a lead says so even once the lead is deleted for good (it lets go of the lead, as of the
-- customer it made).
alter table app.referrals drop constraint referrals_check1;

-- A stage deleted with leads in the bin in it: they move to the first other stage of its kind, as stage.delete moves
-- the ones it can see, so the stage can go. (Without another stage of its kind, the stage can't go anyway.)
create or replace function private.stage_takes_binned_leads()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_to uuid;
begin
  if private.purging_workspace(old.workspace_id) then
    return old;
  end if;
  select s.id into v_to from app.pipeline_stages s
  where s.pipeline_id = old.pipeline_id and s.kind = old.kind and s.id <> old.id
  order by s.position, s.id
  limit 1;
  if v_to is not null then
    update app.leads l set stage_id = v_to where l.stage_id = old.id and l.bin_item_id is not null;
  end if;
  return old;
end $$;
revoke all on function private.stage_takes_binned_leads() from public;
create trigger pipeline_stages_binned_leads before delete on app.pipeline_stages
  for each row execute function private.stage_takes_binned_leads();

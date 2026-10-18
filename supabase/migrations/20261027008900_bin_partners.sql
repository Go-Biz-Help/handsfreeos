-- =============================================================================
-- The Deleted bin says when a customer is a partner (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d).
--
--        Deleting a partner's contact for good takes their partner record
--        with it, and with that what they earned and which clients were
--        theirs (app.partners cascades from app.people). The delete box
--        says so before anything goes: `bin_contents` counts the partners
--        among what's deleted (`partners`), as it counts their bookings and
--        bills. A client a partner sent who's deleted for good only lets go
--        of their referral, so what they earned the partner stays; that
--        needs no line.
--
-- Only changes: private.bin_contents gains `partners`. Items already in the
-- bin keep the counts they were put there with.
-- =============================================================================

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
    'partners', case when p_kind = 'person' then nullif((
      select count(*) from app.partners pa where pa.person_id = any (r.people)), 0) end,
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

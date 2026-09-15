-- =============================================================================
-- 0040 · A lead's last contact. The Action Center judges a lead stale, or
--        not contacted yet, from two new columns a trigger on the timeline
--        keeps: last_contact_at (the latest real contact, either way) and
--        first_response_at (the business's first reach-out once the lead
--        existed, set once). Real contact is a text, an email, a chat, a call
--        that connected, a voicemail or a visit; a missed call, a note and a
--        system entry are not. Nobody writes the two columns directly, the
--        worker included. Existing leads are backfilled by the same rules,
--        and an index serves "open leads by last contact".
-- =============================================================================

alter table app.leads
  add column last_contact_at timestamptz,
  add column first_response_at timestamptz;

-- What a timeline entry says about contact:
--   'outreach'  the business reached the customer: an outbound text, email or chat, a call that connected (either
--               way: someone picked up), a visit, or a call a person logged by hand;
--   'contact'   the customer reached the business: an inbound text, email or chat, or a voicemail;
--   null        neither: a missed call either way, a note, a system entry.
-- Texts, emails and chats record inbound or outbound; calls record answered, missed, voicemail, outbound or
-- outbound_missed (core's settleCall); a call logged by hand has none.
create or replace function private.activity_contact(p_kind app.activity_kind, p_subtype text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind::text in ('sms', 'email', 'chat') then case when p_subtype = 'outbound' then 'outreach' else 'contact' end
    when p_kind::text = 'call' then case
      when p_subtype in ('missed', 'outbound_missed') then null
      when p_subtype = 'voicemail' then 'contact'
      else 'outreach'
    end
    when p_kind::text = 'visit' then 'outreach'
  end
$$;

-- An entry with a lead updates that lead; one with only a customer (or a company) updates their open leads.
-- last_contact_at only moves forward. first_response_at is set once, by the first reach-out recorded while the
-- lead existed, and never reads earlier than the lead itself: a call already under way when someone made the lead
-- counts from the moment the lead was made. It also runs when an entry's subtype changes, because a call's
-- voicemail can arrive after the call was recorded as missed. SECURITY DEFINER: it runs as the table's owner,
-- which is how it passes private.guard_lead_contact below.
create or replace function private.note_lead_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_touch text := private.activity_contact(new.kind, new.subtype);
begin
  if v_touch is null
     or (tg_op = 'UPDATE' and v_touch is not distinct from private.activity_contact(old.kind, old.subtype)) then
    return null;
  end if;
  if new.lead_id is not null then
    update app.leads l
    set last_contact_at = greatest(l.last_contact_at, new.occurred_at),
        first_response_at = case when v_touch = 'outreach'
          then coalesce(l.first_response_at, greatest(new.occurred_at, l.created_at)) else l.first_response_at end
    where l.id = new.lead_id and l.workspace_id = new.workspace_id
      and (l.last_contact_at is null or l.last_contact_at < new.occurred_at
        or (v_touch = 'outreach' and l.first_response_at is null));
  else
    update app.leads l
    set last_contact_at = greatest(l.last_contact_at, new.occurred_at),
        first_response_at = case when v_touch = 'outreach'
          then coalesce(l.first_response_at, greatest(new.occurred_at, l.created_at)) else l.first_response_at end
    where l.workspace_id = new.workspace_id and l.status = 'open'
      and (l.person_id = new.person_id or l.company_id = new.company_id)
      and (l.last_contact_at is null or l.last_contact_at < new.occurred_at
        or (v_touch = 'outreach' and l.first_response_at is null));
  end if;
  return null;
end $$;
create trigger activities_note_lead_contact after insert or update of subtype on app.activities
  for each row execute function private.note_lead_contact();

-- People and the worker never write the two columns: they follow the timeline. The trigger above and the backfill
-- run as the table's owner, and pass. The test is on current_user, which no role can fake, so this function must
-- stay SECURITY INVOKER.
create or replace function private.guard_lead_contact()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'service_actor') and (case
       when tg_op = 'INSERT' then new.last_contact_at is not null or new.first_response_at is not null
       else (old.last_contact_at, old.first_response_at) is distinct from (new.last_contact_at, new.first_response_at)
     end) then
    raise exception 'A lead''s last contact follows its timeline' using errcode = '42501', detail = 'lead_contact_protected';
  end if;
  return new;
end $$;
create trigger leads_guard_contact before insert or update on app.leads
  for each row execute function private.guard_lead_contact();

-- The same rules over the timeline already there: a lead's own entries, and its customer's (or company's) entries
-- recorded while it existed and, for a closed lead, before it closed (the trigger touches only open leads). It
-- recomputes, so a lead with no contact ends up with none. p_workspace null means every business. The owner's
-- alone: the migration runs it once below, and the DB tests (as the owner) check it agrees with the trigger.
create or replace function private.backfill_lead_contact(p_workspace uuid default null)
returns integer language plpgsql set search_path = '' as $$
declare
  v_count integer;
begin
  update app.leads l
  set last_contact_at = t.last_contact_at, first_response_at = t.first_response_at
  from (
    select l2.id,
      max(a.occurred_at) as last_contact_at,
      min(greatest(a.occurred_at, l2.created_at))
        filter (where private.activity_contact(a.kind, a.subtype) = 'outreach') as first_response_at
    from app.leads l2
    left join app.activities a on a.workspace_id = l2.workspace_id
      and private.activity_contact(a.kind, a.subtype) is not null
      and (a.lead_id = l2.id
        or (a.lead_id is null
          and (a.person_id = l2.person_id or a.company_id = l2.company_id)
          and a.created_at >= l2.created_at
          and a.created_at <= coalesce(l2.won_at, l2.lost_at, 'infinity'::timestamptz)))
    where p_workspace is null or l2.workspace_id = p_workspace
    group by l2.id
  ) t
  where t.id = l.id
    and (l.last_contact_at, l.first_response_at) is distinct from (t.last_contact_at, t.first_response_at);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Existing leads. Their updated_at stays as it was: filling in the history isn't an edit.
alter table app.leads disable trigger leads_updated_at;
select private.backfill_lead_contact();
alter table app.leads enable trigger leads_updated_at;

-- The stale sweep: a business's open leads by last contact.
create index leads_last_contact_idx on app.leads (workspace_id, status, last_contact_at);

-- ---------- function privileges ----------
revoke all on function
  private.activity_contact(app.activity_kind, text), private.note_lead_contact(), private.guard_lead_contact(),
  private.backfill_lead_contact(uuid)
  from public;
grant execute on function
  private.activity_contact(app.activity_kind, text), private.note_lead_contact(), private.guard_lead_contact()
  to authenticated, service_actor;

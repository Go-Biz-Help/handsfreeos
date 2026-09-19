-- A missed call, and the voicemail if one was left, now reach a phone.
--
-- Nothing told anybody about a missed call: `call.missed` wrote the timeline entry, the conversation's preview and
-- its unread count, and fed workflows, but no push and no email. Someone who wasn't watching the inbox found out
-- whenever they next looked (step 1, finding: "didn't get a push notification or anything about the missed call").
--
-- `missedCall` joins the switches, on unless the person turns it off, like every switch but `payment`. It is its own
-- switch rather than part of `urgent`: a missed call is worth hearing about at once, while `urgent` is the Action
-- Center's ranked list, and someone who silences one usually still wants the other.

create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned', 'payment') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment), each on unless false except payment: private.push_on.';

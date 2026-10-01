-- =============================================================================
-- New support tickets on the support people's phones.
--
--        Someone writes to HandsFreeOS support, in the app or by email, and
--        every active support person with the switch on hears about it on
--        their phone (apps/worker/src/push/README.md, `support_ticket`).
--
--        **The switch.** `supportTickets` in app.users.settings.push, on
--        unless turned off. Only support people ever get these, so only
--        they see it in Settings → Notifications. private.push_on learns
--        its name; a name it doesn't know is still an error.
--
--        **Who hears.** The worker sends a business's pushes holding that
--        business's scope, and sees the devices of the people in it and
--        nobody else's (push_devices_service_select). Support people are in
--        no business, and a ticket belongs to none, so it could never find
--        their phones. Two functions answer the only two questions it has,
--        rather than a policy that would show it every support person's
--        phones in every business's scope:
--
--          - staff_push_devices: the phones that are on, of the active
--            support people (not deleted) whose switch for a kind is on;
--          - turn_off_staff_push_devices: a support person's phone that
--            Expo says the app is gone from, off until it registers again,
--            exactly as the worker does for a business's people.
--
--        Both are the worker's alone.
--
--        **`addons` stays a switch.** The add-on alerts work (its own
--        branch, 20261013002500_add_on_alerts_on_home) put `addons` into
--        push_on on the hosted database before either change reached main.
--        This redefinition keeps it, and the column's comment keeps
--        `addonEmail`, so neither change drops the other's switch whichever
--        merges first.
-- =============================================================================

-- ---------- the switch ----------
-- `supportTickets` is on by default: a customer waiting on HandsFreeOS is the thing support is for.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons', 'supportTickets') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary, addonEmail), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections, addons, supportTickets), each on unless false except payment: private.push_on.';

-- ---------- the support people's phones ----------
-- The phones to tell about one kind of push: on, belonging to an active support person whose account is not
-- deleted and whose switch for the kind is on. Only these people when `p_users` names some (the job looks again at
-- the people it was queued for); every such support person when it is null.
create or replace function private.staff_push_devices(p_key text, p_users uuid[] default null)
returns table (device_id uuid, user_id uuid, platform text, token text)
language sql stable security definer set search_path = '' as $$
  select d.id, d.user_id, d.platform::text, d.expo_push_token
  from platform.staff s
  join app.users u on u.id = s.user_id
  join app.push_devices d on d.user_id = s.user_id
  where s.status = 'active'
    and u.deleted_at is null
    and d.disabled_at is null
    and private.push_on(u.settings, p_key)
    and (p_users is null or s.user_id = any (p_users))
  order by d.user_id, d.created_at, d.id
$$;

-- A support person's phone the app is gone from (Expo's DeviceNotRegistered): off, unless it registered again after
-- the push went. Only phones of people who are, or were, support people: nobody else's.
create or replace function private.turn_off_staff_push_devices(p_devices uuid[], p_sent_at timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update app.push_devices d set disabled_at = now(), disabled_reason = 'not_registered'
  where d.id = any (p_devices)
    and d.disabled_at is null
    and d.last_seen_at <= p_sent_at
    and exists (select 1 from platform.staff s where s.user_id = d.user_id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  private.staff_push_devices(text, uuid[]), private.turn_off_staff_push_devices(uuid[], timestamptz)
  from public;
grant execute on function
  private.staff_push_devices(text, uuid[]), private.turn_off_staff_push_devices(uuid[], timestamptz)
  to service_actor;

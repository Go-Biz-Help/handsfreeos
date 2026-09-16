-- =============================================================================
-- 0058 · Push notifications. app.push_devices is one app install a person
--        signed in on: its platform, its Expo push token, the app's version,
--        a name to recognise it by, when it was last seen, and when (and why)
--        it was turned off. A token belongs to one person at a time: signing
--        in as someone else on the same phone takes the token over
--        (private.release_push_token turns the other person's row off first),
--        so nobody's notifications reach a phone someone else is using. People
--        register, rename and turn off their own devices; the worker reads the
--        devices of the people it notifies and turns off the ones Expo says
--        are gone. Rows are turned off rather than deleted, so a retried alert
--        can still see where it went.
--
--        The switches are app.users.settings.push, a key of their own beside
--        the email switches in settings.notifications: user.update_profile
--        saves settings a whole top-level key at a time, and the web sends its
--        six email switches, and only those, on every change. Each is on unless
--        the person turned it off, except payments: customerWaiting (a customer
--        waiting on a reply), urgent (urgent Action Center items, the same
--        moments as the urgent email), approval (approvals and AI drafts),
--        booking (bookings and changes on your appointments), assigned (things
--        assigned to you) and payment (payments received; off until turned
--        on). private.push_on reads one with those defaults. Grants and indexes
--        are in 0060.
-- =============================================================================

create type app.push_platform as enum ('ios', 'android');

create table app.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  platform app.push_platform not null,
  -- ExponentPushToken[…] (or ExpoPushToken[…]). Pushes also need the worker's Expo access token (enhanced
  -- security), so a token alone can't send anything.
  expo_push_token text not null check (expo_push_token ~ '^Expo(nent)?PushToken\[[^][:space:]]{1,200}\]$'),
  app_version text not null check (length(btrim(app_version)) between 1 and 40),
  -- What the person calls it ("Dale's iPhone").
  device_name text check (device_name is null or length(btrim(device_name)) between 1 and 120),
  last_seen_at timestamptz not null default now(),
  -- person: turned off in settings; signed_out: the person signed out on it; not_registered: Expo says the
  -- install is gone (the worker's); replaced: someone else signed in on it.
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null
    or disabled_reason in ('person', 'signed_out', 'not_registered', 'replaced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((disabled_at is null) = (disabled_reason is null)),
  constraint push_devices_user_token_key unique (user_id, expo_push_token)
);
-- A token is live for one person at a time.
create unique index push_devices_live_token_key on app.push_devices (expo_push_token) where disabled_at is null;
create trigger push_devices_updated_at before update on app.push_devices
  for each row execute function private.set_updated_at();
create trigger push_devices_immutable before update on app.push_devices
  for each row execute function private.forbid_tenant_column_change('user_id', 'expo_push_token');

-- People turn their own devices off only as themselves ('person', 'signed_out'); Expo's answer and a takeover are
-- HandsFreeOS's. The database's clock stamps it. The test is on current_user, which no role can fake, so this
-- function must stay SECURITY INVOKER.
create or replace function private.guard_push_device()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.disabled_reason is not null and new.disabled_reason not in ('person', 'signed_out')
     and new.disabled_reason is distinct from (case when tg_op = 'UPDATE' then old.disabled_reason end) then
    raise exception 'People turn a device off only for themselves' using errcode = '42501', detail = 'push_device_reason';
  end if;
  if new.disabled_at is not null
     and (tg_op = 'INSERT' or old.disabled_at is null or new.disabled_reason is distinct from old.disabled_reason) then
    new.disabled_at := now();
  end if;
  return new;
end $$;
create trigger push_devices_guard before insert or update on app.push_devices
  for each row execute function private.guard_push_device();

-- Signing in on a phone someone else used: their row for this token is turned off, so the partial unique index
-- lets this person's go live. Only the signed-in person's own token is theirs to take.
create or replace function private.release_push_token(p_token text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  update app.push_devices d set disabled_at = now(), disabled_reason = 'replaced'
  where d.expo_push_token = p_token and d.disabled_at is null and d.user_id <> v_uid;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------- the switches ----------
-- Whether one of a person's push switches is on: the stored boolean when there is one, otherwise the default (on,
-- except payment). A name it doesn't know is an error, so a misspelt switch can't read as on.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'urgent', 'approval', 'booking', 'assigned', 'payment') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;
comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest), each on unless false; push, the phone''s switches (customerWaiting, urgent, approval, booking, assigned, payment), each on unless false except payment: private.push_on.';

-- ---------- RLS: a person's own devices; the worker, the devices of the people in its scope ----------
alter table app.push_devices enable row level security;

create policy push_devices_select on app.push_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy push_devices_insert on app.push_devices for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy push_devices_update on app.push_devices for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy push_devices_service_select on app.push_devices for select to service_actor
  using (user_id in (select private.system_scope_user_ids()));
create policy push_devices_service_update on app.push_devices for update to service_actor
  using (user_id in (select private.system_scope_user_ids()))
  with check (user_id in (select private.system_scope_user_ids()));

-- ---------- function privileges ----------
revoke all on function
  private.guard_push_device(), private.release_push_token(text), private.push_on(jsonb, text)
  from public;
grant execute on function private.guard_push_device() to authenticated, service_actor;
grant execute on function private.release_push_token(text) to authenticated;
grant execute on function private.push_on(jsonb, text) to authenticated, service_actor;

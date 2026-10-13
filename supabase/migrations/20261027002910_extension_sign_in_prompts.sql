-- =============================================================================
-- Approving an extension sign-in from the phone or the web, with a matching
-- number (apps/extension/README.md, "Signing in with a prompt").
--
--        The person types their email in the Social Outreach extension and
--        presses Send me a prompt. The extension shows a 2-digit number; their
--        phone gets a push and any open HandsFreeOS tab asks "Signing in to
--        the extension on Chrome? Pick the number you see." with three
--        numbers. The right one signs the extension in.
--
--        **The request.** One row per Send me a prompt. It lives two minutes
--        (`expires_at`), is answered once, and a wrong pick refuses it. The
--        extension holds a random secret for it; only its SHA-256 is kept, and
--        collecting the answer needs the secret. A request for an email with
--        no account is kept the same way (user_id null), so starting one says
--        nothing about whether the account exists; nobody can ever answer it.
--
--        **Who sees what.** A person reads their own requests, and only the
--        columns a prompt shows: never the number, the secret's hash or the
--        email. They answer through private.answer_extension_sign_in, as
--        themselves. Starting, collecting and the push's phones are the
--        worker's (service_actor), through the functions below; nothing else
--        writes the table.
--
--        **The sign-in.** Collecting an approved request marks it collected
--        (once); the worker then makes a one-time sign-in for the email with
--        Supabase's admin key and hands its hashed token to the extension,
--        which redeems it (verifyOtp). The token is never stored.
-- =============================================================================

create table app.extension_sign_ins (
  id uuid primary key default gen_random_uuid(),
  -- The account the email belongs to; null when there is none (the request is kept anyway, and simply expires).
  user_id uuid references app.users (id) on delete cascade,
  email extensions.citext not null check (length(email::text) between 3 and 320),
  -- Which browser asked ("Chrome"), shown in the prompt.
  browser text not null check (length(btrim(browser)) between 1 and 40),
  -- SHA-256 of the extension's secret for this request.
  secret_hash bytea not null check (length(secret_hash) = 32),
  -- The number the extension shows, and the three a prompt offers (it among them).
  number smallint not null check (number between 10 and 99),
  choices smallint[] not null check (cardinality(choices) = 3 and number = any (choices)),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'refused', 'collected', 'cancelled')),
  expires_at timestamptz not null default now() + interval '2 minutes',
  answered_at timestamptz,
  collected_at timestamptz,
  -- A hash of the address that asked, for the record; never the address itself.
  ip_hmac text check (ip_hmac is null or length(ip_hmac) <= 128),
  created_at timestamptz not null default now()
);
create index extension_sign_ins_pending_idx on app.extension_sign_ins (user_id, expires_at)
  where status = 'pending';
create index extension_sign_ins_created_idx on app.extension_sign_ins (created_at);

alter table app.extension_sign_ins enable row level security;

-- A person's own requests, while they can still be answered.
create policy extension_sign_ins_select on app.extension_sign_ins for select to authenticated
  using (user_id = (select auth.uid()));

grant select (id, user_id, browser, choices, status, expires_at, created_at)
  on app.extension_sign_ins to authenticated;
revoke all on app.extension_sign_ins from anon;

-- ---------- starting one (the worker) ----------
-- A new request for an email. Any earlier one still waiting for the same email is cancelled, so a prompt only ever
-- shows the latest. Answers the request and the account it is for (null: none).
create or replace function private.start_extension_sign_in(
  p_email text, p_secret_hash bytea, p_number smallint, p_choices smallint[], p_browser text, p_ip_hmac text
)
returns table (id uuid, user_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  -- Lower-cased first, as private.support_people does: with an empty search_path, citext's own case-blind `=` isn't
  -- the one found, and sign-ins keep their emails in lower case.
  select u.id into v_user from app.users u
  where u.email = lower(p_email)::extensions.citext and u.deleted_at is null;
  update app.extension_sign_ins s set status = 'cancelled'
  where s.email = lower(p_email)::extensions.citext and s.status = 'pending';
  -- Nothing about a request matters after a day: they are tidied away as new ones start.
  delete from app.extension_sign_ins s where s.created_at < now() - interval '1 day';
  return query
    insert into app.extension_sign_ins as s (user_id, email, browser, secret_hash, number, choices, ip_hmac)
    values (v_user, lower(p_email)::extensions.citext, p_browser, p_secret_hash, p_number, p_choices, p_ip_hmac)
    returning s.id, s.user_id, s.expires_at;
end $$;

-- ---------- answering one (the person, as themselves) ----------
-- 'approved' when the pick is the number, 'refused' when it isn't (one wrong pick ends it) or no pick was made
-- ("That wasn't me"); 'gone' when it isn't theirs, was answered already, or ran out.
create or replace function private.answer_extension_sign_in(p_id uuid, p_pick smallint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row app.extension_sign_ins%rowtype;
  v_status text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select * into v_row from app.extension_sign_ins s
  where s.id = p_id and s.user_id = v_uid
  for update;
  if not found or v_row.status <> 'pending' or v_row.expires_at <= now() then
    return 'gone';
  end if;
  v_status := case when p_pick is not null and p_pick = v_row.number then 'approved' else 'refused' end;
  update app.extension_sign_ins s set status = v_status, answered_at = now() where s.id = p_id;
  return v_status;
end $$;

-- ---------- collecting the answer (the worker, for whoever holds the secret) ----------
-- 'waiting' while nobody has answered, 'approved' exactly once (the request becomes 'collected' and its email is
-- returned for the sign-in), 'refused', or 'expired' (ran out, was replaced, was collected already, or the secret
-- doesn't match: a wrong secret learns nothing more).
create or replace function private.collect_extension_sign_in(p_id uuid, p_secret_hash bytea)
returns table (status text, email text, user_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_row app.extension_sign_ins%rowtype;
begin
  select * into v_row from app.extension_sign_ins s
  where s.id = p_id and s.secret_hash = p_secret_hash
  for update;
  if not found or v_row.status in ('collected', 'cancelled') then
    return query select 'expired'::text, null::text, null::uuid;
  elsif v_row.status = 'refused' then
    return query select 'refused'::text, null::text, null::uuid;
  elsif v_row.status = 'approved' then
    -- An approval is collected within a minute of the request running out, or not at all.
    if v_row.expires_at + interval '1 minute' <= now() then
      return query select 'expired'::text, null::text, null::uuid;
    else
      update app.extension_sign_ins s set status = 'collected', collected_at = now() where s.id = p_id;
      return query select 'approved'::text, v_row.email::text, v_row.user_id;
    end if;
  elsif v_row.expires_at <= now() then
    return query select 'expired'::text, null::text, null::uuid;
  else
    return query select 'waiting'::text, null::text, null::uuid;
  end if;
end $$;

-- A sign-in that couldn't be made after collecting: approved again, so the extension's next poll tries once more.
create or replace function private.uncollect_extension_sign_in(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update app.extension_sign_ins s set status = 'approved', collected_at = null
  where s.id = p_id and s.status = 'collected'
$$;

-- ---------- the push's phones (the worker) ----------
-- The phones that are on of these people (accounts not deleted). A sign-in prompt is no business's, so the worker
-- can't see them from any business's scope; it has no switch, since only the person asked for it.
create or replace function private.own_push_devices(p_users uuid[])
returns table (device_id uuid, user_id uuid, platform text, token text)
language sql stable security definer set search_path = '' as $$
  select d.id, d.user_id, d.platform::text, d.expo_push_token
  from app.push_devices d
  join app.users u on u.id = d.user_id
  where d.user_id = any (p_users)
    and d.disabled_at is null
    and u.deleted_at is null
  order by d.user_id, d.created_at, d.id
$$;

-- A phone Expo says the app is gone from, after a sign-in prompt: off, unless it registered again after the push.
create or replace function private.turn_off_own_push_devices(p_devices uuid[], p_sent_at timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update app.push_devices d set disabled_at = now(), disabled_reason = 'not_registered'
  where d.id = any (p_devices)
    and d.disabled_at is null
    and d.last_seen_at <= p_sent_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  private.start_extension_sign_in(text, bytea, smallint, smallint[], text, text),
  private.answer_extension_sign_in(uuid, smallint),
  private.collect_extension_sign_in(uuid, bytea),
  private.uncollect_extension_sign_in(uuid),
  private.own_push_devices(uuid[]),
  private.turn_off_own_push_devices(uuid[], timestamptz)
  from public;
grant execute on function private.answer_extension_sign_in(uuid, smallint) to authenticated;
grant execute on function
  private.start_extension_sign_in(text, bytea, smallint, smallint[], text, text),
  private.collect_extension_sign_in(uuid, bytea),
  private.uncollect_extension_sign_in(uuid),
  private.own_push_devices(uuid[]),
  private.turn_off_own_push_devices(uuid[], timestamptz)
  to service_actor;

-- =============================================================================
-- Affiliates, part 1 (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
--
--        People who sell HandsFreeOS itself for a share of what the businesses
--        they send pay for their plan. Not the Partners feature, where a
--        business pays its own partners: this is HandsFreeOS's own program,
--        kept in `platform` beside the founding spots, and run by staff from
--        the Admin area.
--
--        `affiliates` is one row a person: what they said when they applied,
--        the code their link carries (`handsfreeos.com/?ref=<code>`), their
--        own share when it isn't everyone's, and where they stand: applied,
--        approved, turned down, paused or ended. `affiliate_settings` is the
--        share everyone gets (40% to start, the owner's decision 1).
--        `affiliate_clicks` counts their link's clicks a day. And
--        `affiliate_referrals` is each business they sent: one affiliate a
--        business, set as the business is made (by their link or, later, a
--        code) or by staff by hand.
--
--        A person applies for themselves (`private.affiliate_apply`) and reads
--        their own row; everything else is staff's (`platform.affiliates.manage`,
--        support admins) and the worker's. A business is credited only as it's
--        made (`private.affiliate_note_signup`, from `organization.create`), so
--        a business that already had an account never counts, and nobody is
--        credited with their own. The link rides on the new account's sign-up
--        details until its first business is made.
--
-- Only adds: a staff permission, four tables and three functions.
-- =============================================================================

-- ---------- the staff permission ----------
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.affiliates.manage');

-- ---------- the share everyone gets ----------
create table platform.affiliate_settings (
  -- One row: the program's.
  id boolean primary key default true check (id),
  -- In basis points: 4000 is 40%.
  rate_bp integer not null default 4000 check (rate_bp between 1 and 10000),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into platform.affiliate_settings (id) values (true);

-- ---------- the affiliates ----------
create table platform.affiliates (
  id uuid primary key default gen_random_uuid(),
  -- One a person: their HandsFreeOS sign-in, whether or not they have a business.
  user_id uuid not null unique references app.users (id) on delete cascade,
  -- What their link carries, lowercase: 3 to 24 letters, digits and dashes, starting and ending with a letter or digit.
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$'),
  status text not null default 'applied'
    check (status in ('applied', 'approved', 'turned_down', 'paused', 'ended')),
  -- What they told us when they applied.
  name text not null check (length(btrim(name)) between 1 and 120),
  pitch text not null default '' check (length(pitch) <= 2000),
  links text not null default '' check (length(links) <= 1000),
  -- Their own share in basis points; null for everyone's (platform.affiliate_settings).
  rate_bp integer check (rate_bp is null or rate_bp between 1 and 10000),
  applied_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger affiliates_updated_at before update on platform.affiliates
  for each row execute function private.set_updated_at();
create index affiliates_status on platform.affiliates (status, applied_at desc);

-- ---------- their link's clicks, a day at a time (UTC) ----------
create table platform.affiliate_clicks (
  affiliate_id uuid not null references platform.affiliates (id) on delete cascade,
  day date not null,
  clicks integer not null default 0 check (clicks >= 0),
  primary key (affiliate_id, day)
);

-- ---------- the businesses they sent ----------
create table platform.affiliate_referrals (
  -- One affiliate a business. A business deleted for good lets go of it.
  organization_id uuid primary key references app.organizations (id) on delete cascade,
  affiliate_id uuid not null references platform.affiliates (id) on delete cascade,
  how text not null check (how in ('link', 'code', 'by_hand')),
  -- When they clicked the affiliate's link, for one sent by a link.
  clicked_at timestamptz,
  referred_at timestamptz not null default now(),
  -- Staff who set it by hand.
  marked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index affiliate_referrals_affiliate on platform.affiliate_referrals (affiliate_id, referred_at desc);

-- ---------- who sees what ----------
alter table platform.affiliate_settings enable row level security;
alter table platform.affiliates enable row level security;
alter table platform.affiliate_clicks enable row level security;
alter table platform.affiliate_referrals enable row level security;

-- Everyone's share is no secret: an affiliate's page says what they earn.
create policy affiliate_settings_read on platform.affiliate_settings for select to authenticated
  using (true);
create policy affiliate_settings_staff on platform.affiliate_settings for update to authenticated
  using (private.staff_can('platform.affiliates.manage'))
  with check (private.staff_can('platform.affiliates.manage'));
create policy affiliate_settings_service on platform.affiliate_settings for all to service_actor
  using (true) with check (true);

-- A person reads their own row; they write it only through private.affiliate_apply.
create policy affiliates_own on platform.affiliates for select to authenticated
  using (user_id = auth.uid());
create policy affiliates_staff on platform.affiliates for all to authenticated
  using (private.staff_can('platform.affiliates.manage'))
  with check (private.staff_can('platform.affiliates.manage'));
create policy affiliates_service on platform.affiliates for all to service_actor
  using (true) with check (true);

create policy affiliate_clicks_own on platform.affiliate_clicks for select to authenticated
  using (exists (select 1 from platform.affiliates a
                 where a.id = affiliate_id and a.user_id = auth.uid()));
create policy affiliate_clicks_staff on platform.affiliate_clicks for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy affiliate_clicks_service on platform.affiliate_clicks for all to service_actor
  using (true) with check (true);

-- Which businesses an affiliate sent is staff's; their own page reads it through a function of its own (part 3).
create policy affiliate_referrals_staff on platform.affiliate_referrals for all to authenticated
  using (private.staff_can('platform.affiliates.manage'))
  with check (private.staff_can('platform.affiliates.manage'));
create policy affiliate_referrals_service on platform.affiliate_referrals for all to service_actor
  using (true) with check (true);

grant select, update on platform.affiliate_settings to authenticated;
grant select, insert, update on platform.affiliates to authenticated;
grant select on platform.affiliate_clicks to authenticated;
grant select, insert, update, delete on platform.affiliate_referrals to authenticated;
grant select, insert, update, delete on platform.affiliate_settings, platform.affiliates,
  platform.affiliate_clicks, platform.affiliate_referrals to service_actor;
revoke all on platform.affiliate_settings, platform.affiliates, platform.affiliate_clicks,
  platform.affiliate_referrals from anon;

-- ---------- applying ----------
/**
 * The signed-in person applies to be an affiliate, or changes what they said while they wait.
 *
 * Their own row only, and only while nobody has decided: an approved, paused or ended affiliate is refused
 * (`affiliate_already`), and one turned down may apply again 30 days after (`affiliate_turned_down_recently`).
 * A code somebody else has is refused (`affiliate_code_taken`); the code's shape is the table's own check.
 */
create or replace function private.affiliate_apply(p_name text, p_code text, p_pitch text, p_links text)
returns table (affiliate_id uuid, created boolean, reapplied boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row platform.affiliates%rowtype;
  v_id uuid;
  v_code text := lower(btrim(p_code));
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if exists (select 1 from platform.affiliates a where a.code = v_code and a.user_id <> v_uid) then
    raise exception 'That code is taken' using errcode = '23505', detail = 'affiliate_code_taken';
  end if;

  select * into v_row from platform.affiliates a where a.user_id = v_uid for update;
  if not found then
    insert into platform.affiliates (user_id, code, name, pitch, links)
      values (v_uid, v_code, btrim(p_name), coalesce(p_pitch, ''), coalesce(p_links, ''))
      returning id into v_id;
    return query select v_id, true, false;
    return;
  end if;

  if v_row.status in ('approved', 'paused', 'ended') then
    raise exception 'Already an affiliate' using errcode = '23505', detail = 'affiliate_already';
  end if;
  if v_row.status = 'turned_down' and v_row.decided_at > now() - interval '30 days' then
    raise exception 'Turned down recently' using errcode = '23514', detail = 'affiliate_turned_down_recently';
  end if;

  update platform.affiliates a
    set code = v_code, name = btrim(p_name), pitch = coalesce(p_pitch, ''), links = coalesce(p_links, ''),
        status = 'applied',
        applied_at = case when a.status = 'turned_down' then now() else a.applied_at end,
        decided_at = null, decided_by = null
    where a.id = v_row.id;
  return query select v_row.id, false, v_row.status = 'turned_down';
end $$;

revoke all on function private.affiliate_apply(text, text, text, text) from public;
grant execute on function private.affiliate_apply(text, text, text, text) to authenticated;

-- ---------- a click on their link ----------
/**
 * The website saw somebody arrive on an affiliate's link: today's count goes up by one. Only an approved
 * affiliate's clicks are counted; any other code is answered false and counts nothing.
 */
create or replace function private.affiliate_click(p_code text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select a.id into v_id from platform.affiliates a
    where a.code = lower(btrim(p_code)) and a.status = 'approved';
  if v_id is null then
    return false;
  end if;
  insert into platform.affiliate_clicks (affiliate_id, day, clicks)
    values (v_id, (now() at time zone 'UTC')::date, 1)
    on conflict (affiliate_id, day) do update set clicks = platform.affiliate_clicks.clicks + 1;
  return true;
end $$;

revoke all on function private.affiliate_click(text) from public;
grant execute on function private.affiliate_click(text) to service_actor;

-- ---------- a business made through their link ----------
/**
 * Credit a business that was just made to the affiliate whose link (or code) brought its maker.
 *
 * Called by `organization.create` in the same transaction, as the person making it. Answers the affiliate's id,
 * or null when nothing was credited, and never refuses: a link that went wrong must never stop somebody signing up.
 * Credited only when:
 *
 * - the business is the caller's, made in the last ten minutes, and nobody has been credited with it yet (so a
 *   business that already had an account never counts);
 * - the code is an approved affiliate's, and not the caller's own;
 * - the link was clicked in the last 90 days (decision 4), when it says when.
 *
 * With no code handed in, the link the account was made through counts: the web's sign-up keeps it on the account
 * (`affiliate_ref` and `affiliate_ref_at` in its sign-up details), so the business is credited whichever device
 * makes it. That counts for the person's first business only.
 */
create or replace function private.affiliate_note_signup(
  p_org uuid, p_code text, p_how text, p_clicked_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_aff uuid;
  v_code text := p_code;
  v_how text := p_how;
  v_at timestamptz := p_clicked_at;
  v_meta jsonb;
  v_made timestamptz;
begin
  if v_uid is null then
    return null;
  end if;
  if v_code is null then
    if exists (select 1 from app.organizations o where o.created_by = v_uid and o.id <> p_org) then
      return null;
    end if;
    select u.raw_user_meta_data, u.created_at into v_meta, v_made from auth.users u where u.id = v_uid;
    v_code := v_meta ->> 'affiliate_ref';
    v_how := 'link';
    begin
      v_at := coalesce((v_meta ->> 'affiliate_ref_at')::timestamptz, v_made);
    exception when others then
      v_at := v_made;
    end;
  end if;
  if v_code is null or v_how is null or v_how not in ('link', 'code') then
    return null;
  end if;
  if v_at is not null
     and (v_at < now() - interval '90 days' or v_at > now() + interval '1 day') then
    return null;
  end if;
  if not exists (select 1 from app.organizations o
                 where o.id = p_org and o.created_by = v_uid and o.created_at > now() - interval '10 minutes') then
    return null;
  end if;
  select a.id into v_aff from platform.affiliates a
    where a.code = lower(btrim(v_code)) and a.status = 'approved' and a.user_id <> v_uid;
  if v_aff is null then
    return null;
  end if;
  insert into platform.affiliate_referrals (organization_id, affiliate_id, how, clicked_at)
    values (p_org, v_aff, v_how, v_at)
    on conflict (organization_id) do nothing;
  if not found then
    return null;
  end if;
  return v_aff;
end $$;

revoke all on function private.affiliate_note_signup(uuid, text, text, timestamptz) from public;
grant execute on function private.affiliate_note_signup(uuid, text, text, timestamptz) to authenticated;

-- ---------- who the worker tells ----------
/**
 * The person an affiliate row is, for the worker's emails about their application. The worker holds no business
 * when it handles the program's events, so it can't read app.users itself (as private.idea_author_to_tell).
 */
create or replace function private.affiliate_to_tell(p_affiliate uuid)
returns table (email text, first_name text, name text, code text, status text)
language sql stable security definer set search_path = '' as $$
  select u.email::text,
         split_part(btrim(coalesce(nullif(btrim(u.full_name), ''), a.name)), ' ', 1),
         a.name, a.code, a.status
  from platform.affiliates a join app.users u on u.id = a.user_id
  where a.id = p_affiliate
$$;

/** The staff who run the program, told of a new application. */
create or replace function private.affiliate_staff_to_tell()
returns table (email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select u.email::text, split_part(btrim(coalesce(nullif(btrim(s.display_name), ''), u.full_name, '')), ' ', 1)
  from platform.staff s join app.users u on u.id = s.user_id
  where s.status = 'active'
    and exists (select 1 from app.role_permissions rp
                where rp.role = 'staff_' || s.role::text and rp.permission = 'platform.affiliates.manage')
$$;

revoke all on function private.affiliate_to_tell(uuid), private.affiliate_staff_to_tell() from public;
grant execute on function private.affiliate_to_tell(uuid), private.affiliate_staff_to_tell() to service_actor;

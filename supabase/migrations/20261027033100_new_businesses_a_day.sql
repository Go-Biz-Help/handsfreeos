-- =============================================================================
-- At most three new businesses a person a day (the owner's decision of
-- 2026-11-22: "Max 3 new businesses per person a day").
--
--        Every new business comes with its own starting credit and a
--        sending address on HandsFreeOS's shared mail domain, and nothing
--        limited how many one account could make. So a script could make
--        them by the hundred.
--
--        `organization.create` and `workspace.create` ask this first, in
--        their own transaction: it counts the businesses this person made
--        in the last 24 hours, whoever owns them now, and refuses one past
--        the limit with the time they can add another. A lock per person
--        makes two made at once wait for each other, so both can't slip
--        under.
--
--        - **Staff aren't counted** (the founder too).
--        - **Practice businesses** (Admin → Try onboarding) are made by
--          staff through `private.start_practice`, so they never come here.
--        - **One person may be allowed more** (an agency setting up many
--          clients in a day): a row in `private.new_business_allowances`,
--          HandsFreeOS's alone to write. The tests' people get one too
--          (`createTestUser`), so suites that make many businesses aren't
--          about this limit.
--
-- Only adds a table and a function.
-- =============================================================================

create table private.new_business_allowances (
  user_id uuid primary key references app.users (id) on delete cascade,
  -- New businesses this person may add in 24 hours, in place of the 3 everyone has.
  per_day integer not null check (per_day between 1 and 10000),
  -- Who asked and why, for whoever looks next.
  why text not null check (length(btrim(why)) between 1 and 500),
  created_at timestamptz not null default now()
);
revoke all on private.new_business_allowances from public;

comment on table private.new_business_allowances is
  'A person allowed more (or fewer) than 3 new businesses a day (20261027033100). HandsFreeOS writes it, nobody else.';

create or replace function private.check_new_business_room()
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer;
  v_oldest timestamptz;
  v_hours integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if private.is_staff() then
    return;
  end if;
  v_limit := coalesce((select a.per_day from private.new_business_allowances a where a.user_id = v_uid), 3);
  perform pg_advisory_xact_lock(hashtextextended('hfos:new_businesses:' || v_uid::text, 0));
  -- The oldest of the last `v_limit` made in the day: once it's a day old there's room again.
  select w.created_at into v_oldest
    from app.workspaces w
   where w.created_by = v_uid and w.created_at > now() - interval '1 day'
   order by w.created_at desc
   offset v_limit - 1 limit 1;
  if v_oldest is null then
    return;
  end if;
  v_hours := greatest(1, ceil(extract(epoch from (v_oldest + interval '1 day' - now())) / 3600)::integer);
  raise exception '%', format(
      'You’ve added %s in the last day, which is the most for one day. You can add another in %s.',
      case when v_limit = 1 then '1 business' else v_limit || ' businesses' end,
      case when v_hours = 1 then 'about an hour' else 'about ' || v_hours || ' hours' end)
    using errcode = 'P0001', detail = 'too_many_new_businesses';
end $$;

comment on function private.check_new_business_room() is
  'Refuses a new business past the person''s limit for 24 hours (3, or their allowance), staff aside (20261027033100).';

revoke all on function private.check_new_business_room() from public;
grant execute on function private.check_new_business_room() to authenticated;

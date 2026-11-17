-- =============================================================================
-- Add-on prices: a monthly charge for each paid add-on, a free trial, and gifts from HandsFreeOS that can end.
--
--        **The owner's picks (2026-11-17, "all a"):** Social Outreach $97 a month, Content Creator, AI Sales
--        Coach and Real Estate Agent $47, Contractor Operations $67 when it's offered, each for the whole
--        business. 14 days free the first time a business adds one. Charged monthly from the day it's added,
--        to the plan's cards in turn (the default, then each backup), yearly plans too. A failed payment is
--        tried again once a day for 14 days, then only that add-on turns off, with nothing deleted. Turned off
--        from the Add-ons page, it runs to the end of the trial or the month already paid; nothing is refunded
--        for part of a month. Staff give one free from Admin, until they take it back or until a date. Each
--        add-on goes on sale only when the owner says (its catalogue status, in code).
--
--        **The price is in code** (each manifest's `billing.monthlyCents`), and a business's row here keeps the
--        price it started at, so a later price change reaches new subscriptions only.
--
--        **`app.addon_subscriptions`**: one row per business and add-on, kept for good once made, so a business
--        has one free trial of each. Nobody in a business writes it: the lifecycle commands start and stop it
--        through the functions below, which check the person's permissions themselves, and the worker
--        charges it. `next_charge_at` is the start of the month to be paid next (owed, while past due);
--        `paid_through` the end of the last month paid. `stop_at` is set when it was turned off from the page:
--        it keeps running until then, and the worker turns it off.
--
--        **`app.addon_charges`**: each month paid, once (`unique` on its start), for Settings → Billing & Usage.
--
--        **Gifts** are `platform.addon_grants` (20261013002200), which made an add-on still being built
--        installable for one business. A grant now also means free, until `free_until` when there is one.
--        Giving one ends what the business was paying for that add-on. When a gift ends (taken back, or its
--        date passes) a paid add-on that is still running and isn't paid for is turned off by the worker
--        (`private.addon_unpaid_running`), unless the business chose to keep it paying after the gift.
--
--        **Only adds.** The running code reads nothing new; `private.give_addon_grant(uuid, text, text)` stays
--        for it, beside the new one with an end date. Nothing is charged until the new code is up, and the
--        add-ons on today are each a gift (checked on the live database 2026-11-17: four, all granted).
-- =============================================================================

-- ---------- gifts that can end ----------
alter table platform.addon_grants
  add column free_until timestamptz;
comment on column platform.addon_grants.free_until is
  'When the gift ends: free until then. Null: free until staff take it back.';
comment on table platform.addon_grants is
  'An add-on HandsFreeOS gives one business free (and lets it install one still being built), until staff take it back or until free_until. Written by staff with platform.addons.manage.';

-- ---------- what a business pays for each add-on ----------
create table app.addon_subscriptions (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  -- trial: free until trial_ends_at. active: paid by the month. past_due: the charge for next_charge_at failed and
  -- is retried daily. ended: not paying (turned off, stopped, unpaid, or given free).
  status text not null check (status in ('trial', 'active', 'past_due', 'ended')),
  price_cents integer not null check (price_cents between 50 and 100000),
  -- The business's one free trial of this add-on: set when it starts, never cleared.
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  -- The end of the last month paid for.
  paid_through timestamptz,
  -- The start of the month charged next (owed, while past due). Null while it isn't renewing.
  next_charge_at timestamptz,
  -- Turned off from the Add-ons page: it runs until then, then the worker turns it off.
  stop_at timestamptz,
  -- A failed charge: when, what the bank said, and its daily retries (the plan's, 20261027023600).
  failed_at timestamptz,
  problem text check (problem is null or length(problem) <= 500),
  retry_count integer not null default 0 check (retry_count >= 0),
  retry_from timestamptz,
  next_retry_at timestamptz,
  charge_count integer not null default 0 check (charge_count >= 0),
  started_by uuid references app.users (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('turned_off', 'stopped', 'unpaid', 'gift')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, addon_id),
  check (status <> 'trial' or trial_ends_at is not null),
  check (status <> 'past_due' or (failed_at is not null and next_charge_at is not null))
);
create index addon_subscriptions_org on app.addon_subscriptions (organization_id);
create index addon_subscriptions_started_by on app.addon_subscriptions (started_by);
create index addon_subscriptions_charge_due on app.addon_subscriptions (next_charge_at)
  where status in ('trial', 'active') and next_charge_at is not null;
create index addon_subscriptions_retry_due on app.addon_subscriptions (next_retry_at)
  where status = 'past_due';
create index addon_subscriptions_stop_due on app.addon_subscriptions (stop_at) where stop_at is not null;
create trigger addon_subscriptions_updated_at before update on app.addon_subscriptions
  for each row execute function private.set_updated_at();

comment on table app.addon_subscriptions is
  'What a business pays for one paid add-on (20261027028500): its trial, the month paid through, the next charge, and a failed charge''s retries. Written by the lifecycle''s functions and the worker.';

-- Anyone in the business reads where it stands (the Add-ons page says it), and staff. Nobody in a business writes it.
alter table app.addon_subscriptions enable row level security;
create policy addon_subscriptions_read on app.addon_subscriptions for select to authenticated
  using (private.has_permission(workspace_id, 'workspace.read')
         or private.staff_can('platform.businesses.read'));
create policy addon_subscriptions_service on app.addon_subscriptions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.addon_subscriptions to authenticated;
grant select, insert, update on app.addon_subscriptions to service_actor;
revoke all on app.addon_subscriptions from anon;

-- ---------- each month paid ----------
create table app.addon_charges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  amount_cents integer not null check (amount_cents >= 0),
  period_from timestamptz not null,
  period_to timestamptz not null check (period_to > period_from),
  payment_ref text check (payment_ref is null or length(payment_ref) <= 200),
  card_id uuid references app.plan_cards (id) on delete set null,
  charged_at timestamptz not null default now(),
  unique (workspace_id, addon_id, period_from)
);
create index addon_charges_org on app.addon_charges (organization_id);
create index addon_charges_card on app.addon_charges (card_id);
create index addon_charges_recent on app.addon_charges (workspace_id, charged_at desc);

comment on table app.addon_charges is
  'Each month a business paid for a paid add-on (20261027028500), once. Written by the worker.';

-- Whoever manages what the business pays us sees them (as its cards), and staff.
alter table app.addon_charges enable row level security;
create policy addon_charges_read on app.addon_charges for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage')
         or private.staff_can('platform.businesses.read'));
create policy addon_charges_service on app.addon_charges for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.addon_charges to authenticated;
grant select, insert on app.addon_charges to service_actor;
revoke all on app.addon_charges from anon;

-- ---------- a gift from HandsFreeOS ----------
/** Whether HandsFreeOS gives this business this add-on free now: a gift that hasn't ended, or a practice business. */
create or replace function private.addon_gifted(p_ws uuid, p_addon text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from platform.addon_grants g
                 where g.workspace_id = p_ws and g.addon_id = p_addon
                   and (g.free_until is null or g.free_until > now()))
      or private.is_practice_workspace(p_ws)
$$;

/**
 * Staff give a business an add-on free, until they take it back or until `p_free_until`. Giving it again changes the
 * date and the note. Whatever the business was paying for it ends: a gift is free.
 */
create or replace function private.give_addon_grant(
  p_workspace uuid, p_addon text, p_note text, p_free_until timestamptz)
returns table (changed boolean, organization_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_before platform.addon_grants%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff give an add-on'
      using errcode = '42501', detail = 'addon_grant_is_ours';
  end if;
  if not exists (select 1 from app.workspaces w where w.id = p_workspace) then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  if p_free_until is not null and p_free_until <= now() then
    raise exception 'A gift ends after today' using errcode = '22023', detail = 'addon_grant_past';
  end if;
  select * into v_before from platform.addon_grants g
  where g.workspace_id = p_workspace and g.addon_id = p_addon for update;
  insert into platform.addon_grants as g (workspace_id, addon_id, note, granted_by, free_until)
  values (p_workspace, p_addon, v_note, auth.uid(), p_free_until)
  on conflict (workspace_id, addon_id) do update
    set note = coalesce(excluded.note, g.note), free_until = excluded.free_until,
        granted_by = excluded.granted_by, granted_at = now();
  update app.addon_subscriptions s
     set status = 'ended', next_charge_at = null, stop_at = null, failed_at = null, problem = null,
         retry_count = 0, retry_from = null, next_retry_at = null, ended_at = now(), end_reason = 'gift'
   where s.workspace_id = p_workspace and s.addon_id = p_addon and s.status <> 'ended';
  return query select v_before.workspace_id is null
                   or v_before.free_until is distinct from p_free_until
                   or (v_note is not null and v_before.note is distinct from v_note),
                 (select w.organization_id from app.workspaces w where w.id = p_workspace);
end $$;

revoke all on function private.addon_gifted(uuid, text) from public;
grant execute on function private.addon_gifted(uuid, text) to authenticated, service_actor;
revoke all on function private.give_addon_grant(uuid, text, text, timestamptz) from public;
grant execute on function private.give_addon_grant(uuid, text, text, timestamptz) to authenticated;

-- ---------- starting and stopping, from the lifecycle ----------
/** Whether the business has a card to charge: one in its list, or the plan's from before the list. */
create or replace function private.addon_billing_has_card(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.plan_cards c where c.workspace_id = p_ws)
      or exists (select 1 from app.workspace_plans p
                 where p.workspace_id = p_ws and p.stripe_card_id is not null and p.stripe_customer_id is not null)
$$;

/**
 * A paid add-on is added or turned back on (inside `addon.install` / `addon.enable`): its trial starts the first time,
 * a month already paid carries on, and otherwise a month is due now. Needs `money.manage` and a card.
 * `charge_now` says the worker should charge it straight away.
 */
create or replace function private.addon_billing_start(
  p_ws uuid, p_addon text, p_price_cents integer, p_trial_days integer)
returns table (status text, trial_ends_at timestamptz, next_charge_at timestamptz, charge_now boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_row app.addon_subscriptions%rowtype;
  v_org uuid;
begin
  if v_user is null or not private.has_permission(p_ws, 'money.manage') then
    raise exception 'Only someone who manages money here can add a paid add-on'
      using errcode = '42501', detail = 'addon_billing_not_yours';
  end if;
  select * into v_row from app.addon_subscriptions s
  where s.workspace_id = p_ws and s.addon_id = p_addon for update;
  -- Turned off from the page and back on before it stopped: nothing changes but the stop.
  if found and v_row.status in ('trial', 'active', 'past_due') then
    update app.addon_subscriptions s
       set stop_at = null,
           next_charge_at = coalesce(s.next_charge_at, case when s.status = 'trial' then s.trial_ends_at
                                                            else s.paid_through end)
     where s.workspace_id = p_ws and s.addon_id = p_addon
    returning s.status, s.trial_ends_at, s.next_charge_at into v_row.status, v_row.trial_ends_at, v_row.next_charge_at;
    return query select v_row.status, v_row.trial_ends_at, v_row.next_charge_at, false;
    return;
  end if;
  if not private.addon_billing_has_card(p_ws) then
    raise exception 'Add a card first' using errcode = '23514', detail = 'addon_needs_card';
  end if;
  if not found then
    select w.organization_id into v_org from app.workspaces w where w.id = p_ws;
    insert into app.addon_subscriptions as s (workspace_id, organization_id, addon_id, status, price_cents,
      trial_started_at, trial_ends_at, next_charge_at, started_by)
    values (p_ws, v_org, p_addon, case when p_trial_days > 0 then 'trial' else 'active' end, p_price_cents,
      case when p_trial_days > 0 then now() end,
      case when p_trial_days > 0 then now() + make_interval(days => p_trial_days) end,
      case when p_trial_days > 0 then now() + make_interval(days => p_trial_days) else now() end,
      v_user)
    returning s.status, s.trial_ends_at, s.next_charge_at into v_row.status, v_row.trial_ends_at, v_row.next_charge_at;
    return query select v_row.status, v_row.trial_ends_at, v_row.next_charge_at, v_row.status = 'active';
    return;
  end if;
  -- Ended before. Its trial still running: it carries on. A month already paid: the next charge is when it runs out.
  -- A first trial never had: it starts now. Otherwise a month is due now, at today's price.
  if v_row.trial_ends_at is not null and v_row.trial_ends_at > now() and v_row.charge_count = 0 then
    update app.addon_subscriptions s
       set status = 'trial', next_charge_at = s.trial_ends_at, stop_at = null, ended_at = null, end_reason = null,
           started_by = v_user, started_at = now()
     where s.workspace_id = p_ws and s.addon_id = p_addon;
  elsif v_row.paid_through is not null and v_row.paid_through > now() then
    update app.addon_subscriptions s
       set status = 'active', next_charge_at = s.paid_through, stop_at = null, ended_at = null, end_reason = null,
           failed_at = null, problem = null, retry_count = 0, retry_from = null, next_retry_at = null,
           started_by = v_user, started_at = now()
     where s.workspace_id = p_ws and s.addon_id = p_addon;
  elsif v_row.trial_started_at is null and p_trial_days > 0 then
    update app.addon_subscriptions s
       set status = 'trial', price_cents = p_price_cents, trial_started_at = now(),
           trial_ends_at = now() + make_interval(days => p_trial_days),
           next_charge_at = now() + make_interval(days => p_trial_days), stop_at = null, ended_at = null,
           end_reason = null, started_by = v_user, started_at = now()
     where s.workspace_id = p_ws and s.addon_id = p_addon;
  else
    update app.addon_subscriptions s
       set status = 'active', price_cents = p_price_cents, next_charge_at = now(), stop_at = null,
           ended_at = null, end_reason = null, failed_at = null, problem = null, retry_count = 0,
           retry_from = null, next_retry_at = null, started_by = v_user, started_at = now()
     where s.workspace_id = p_ws and s.addon_id = p_addon;
  end if;
  return query select s.status, s.trial_ends_at, s.next_charge_at,
                      s.status = 'active' and s.next_charge_at <= now()
               from app.addon_subscriptions s where s.workspace_id = p_ws and s.addon_id = p_addon;
end $$;

/**
 * A paid add-on is turned off at once or uninstalled (inside `addon.disable` / `addon.uninstall`): nothing more is
 * charged. A month already paid, or a trial, is kept, for turning it back on before it runs out.
 */
create or replace function private.addon_billing_stop(p_ws uuid, p_addon text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (private.has_permission(p_ws, 'addons.manage')
                                or private.has_permission(p_ws, 'money.manage')) then
    raise exception 'You can''t change add-ons here' using errcode = '42501', detail = 'addon_needs_manage';
  end if;
  update app.addon_subscriptions s
     set status = 'ended', next_charge_at = null, stop_at = null, failed_at = null, problem = null,
         retry_count = 0, retry_from = null, next_retry_at = null, ended_at = now(), end_reason = 'turned_off'
   where s.workspace_id = p_ws and s.addon_id = p_addon and s.status <> 'ended';
end $$;

/**
 * Turned off from the Add-ons page (`addon_billing.stop`): it keeps running to the end of its trial or the month paid,
 * and nothing more is charged. Says when it stops.
 */
create or replace function private.addon_billing_schedule_stop(p_ws uuid, p_addon text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_row app.addon_subscriptions%rowtype;
  v_at timestamptz;
begin
  if auth.uid() is null or not (private.has_permission(p_ws, 'addons.manage')
                                or private.has_permission(p_ws, 'money.manage')) then
    raise exception 'You can''t change add-ons here' using errcode = '42501', detail = 'addon_needs_manage';
  end if;
  select * into v_row from app.addon_subscriptions s
  where s.workspace_id = p_ws and s.addon_id = p_addon for update;
  if not found or v_row.status = 'ended' then
    raise exception 'Nothing is paid for it' using errcode = '23514', detail = 'addon_billing_not_paying';
  end if;
  if v_row.status = 'past_due' then
    raise exception 'Its last payment didn''t go through' using errcode = '23514', detail = 'addon_billing_owing';
  end if;
  v_at := coalesce(v_row.stop_at, case when v_row.status = 'trial' then v_row.trial_ends_at else v_row.paid_through end);
  if v_at is null or v_at <= now() then
    raise exception 'Nothing is paid for it' using errcode = '23514', detail = 'addon_billing_not_paying';
  end if;
  update app.addon_subscriptions s set stop_at = v_at, next_charge_at = null
   where s.workspace_id = p_ws and s.addon_id = p_addon;
  return v_at;
end $$;

/**
 * Keep it (`addon_billing.keep`): undo a stop, so it renews; or, given free until a date, keep it paying after that,
 * with its first charge the day the gift ends. Needs `money.manage`, and a card for after a gift. Says when the next
 * charge is.
 */
create or replace function private.addon_billing_keep(p_ws uuid, p_addon text, p_price_cents integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_row app.addon_subscriptions%rowtype;
  v_until timestamptz;
  v_org uuid;
  v_next timestamptz;
begin
  if v_user is null or not private.has_permission(p_ws, 'money.manage') then
    raise exception 'Only someone who manages money here can keep a paid add-on'
      using errcode = '42501', detail = 'addon_billing_not_yours';
  end if;
  select g.free_until into v_until from platform.addon_grants g
  where g.workspace_id = p_ws and g.addon_id = p_addon and g.free_until > now();
  select * into v_row from app.addon_subscriptions s
  where s.workspace_id = p_ws and s.addon_id = p_addon for update;
  if v_until is not null then
    if not private.addon_billing_has_card(p_ws) then
      raise exception 'Add a card first' using errcode = '23514', detail = 'addon_needs_card';
    end if;
    if v_row.workspace_id is null then
      select w.organization_id into v_org from app.workspaces w where w.id = p_ws;
      insert into app.addon_subscriptions (workspace_id, organization_id, addon_id, status, price_cents,
        paid_through, next_charge_at, started_by)
      values (p_ws, v_org, p_addon, 'active', p_price_cents, v_until, v_until, v_user);
    else
      update app.addon_subscriptions s
         set status = 'active', price_cents = p_price_cents, paid_through = greatest(s.paid_through, v_until),
             next_charge_at = greatest(s.paid_through, v_until), stop_at = null, ended_at = null,
             end_reason = null, failed_at = null, problem = null, retry_count = 0, retry_from = null,
             next_retry_at = null, started_by = v_user, started_at = now()
       where s.workspace_id = p_ws and s.addon_id = p_addon;
    end if;
    select s.next_charge_at into v_next from app.addon_subscriptions s
    where s.workspace_id = p_ws and s.addon_id = p_addon;
    return v_next;
  end if;
  if v_row.workspace_id is null or v_row.status not in ('trial', 'active') or v_row.stop_at is null then
    raise exception 'It isn''t set to turn off' using errcode = '23514', detail = 'addon_billing_not_stopping';
  end if;
  update app.addon_subscriptions s set next_charge_at = s.stop_at, stop_at = null
   where s.workspace_id = p_ws and s.addon_id = p_addon
  returning s.next_charge_at into v_next;
  return v_next;
end $$;

revoke all on function private.addon_billing_has_card(uuid), private.addon_billing_start(uuid, text, integer, integer),
  private.addon_billing_stop(uuid, text), private.addon_billing_schedule_stop(uuid, text),
  private.addon_billing_keep(uuid, text, integer) from public;
grant execute on function private.addon_billing_has_card(uuid) to authenticated, service_actor;
grant execute on function private.addon_billing_start(uuid, text, integer, integer),
  private.addon_billing_stop(uuid, text), private.addon_billing_schedule_stop(uuid, text),
  private.addon_billing_keep(uuid, text, integer) to authenticated;

-- ---------- what the worker charges and turns off ----------
/**
 * Every paid add-on with money due: a month that has come (its trial ended, or the month paid ran out) while it runs,
 * and a failed charge whose next daily retry has come. `attempt` is 0 for the first try of a month and the retry's
 * number after that.
 */
create or replace function private.addon_charges_due(p_limit integer)
returns table (workspace_id uuid, organization_id uuid, addon_id text, due_at timestamptz, attempt integer)
language sql stable security definer set search_path = '' as $$
  select s.workspace_id, s.organization_id, s.addon_id, s.next_charge_at,
         case when s.status = 'past_due' then s.retry_count + 1 else 0 end
  from app.addon_subscriptions s
  join app.addon_installations i on i.workspace_id = s.workspace_id and i.addon_id = s.addon_id
    and i.state in ('installing', 'enabled')
  where s.next_charge_at is not null and s.stop_at is null
    and not private.addon_gifted(s.workspace_id, s.addon_id)
    and ((s.status in ('trial', 'active') and s.next_charge_at <= now())
         or (s.status = 'past_due' and s.next_retry_at is not null and s.next_retry_at <= now()))
  order by coalesce(s.next_retry_at, s.next_charge_at)
  limit greatest(1, least(p_limit, 500))
$$;

/**
 * Subscriptions whose time is up, ended: turned off from the page and their stop has come (`stopped`), and a failed
 * charge whose last retry was made a day ago without going through (`unpaid`). Says how many.
 */
create or replace function private.addon_end_lapsed()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_stopped integer;
  v_unpaid integer;
begin
  update app.addon_subscriptions s
     set status = 'ended', next_charge_at = null, stop_at = null, ended_at = now(), end_reason = 'stopped'
   where s.stop_at is not null and s.stop_at <= now() and s.status in ('trial', 'active');
  get diagnostics v_stopped = row_count;
  update app.addon_subscriptions s
     set status = 'ended', next_charge_at = null, next_retry_at = null, ended_at = now(), end_reason = 'unpaid'
   where s.status = 'past_due' and s.next_retry_at is null and s.failed_at <= now() - interval '15 days';
  get diagnostics v_unpaid = row_count;
  return v_stopped + v_unpaid;
end $$;

/**
 * Paid add-ons running in a business that isn't paying for them and wasn't given them: a gift that ended or was taken
 * back, a subscription that ended above. `p_paid` is the paid add-ons' ids, which only the code knows. `reason` says
 * why, for the email.
 */
create or replace function private.addon_unpaid_running(p_paid text[], p_limit integer)
returns table (workspace_id uuid, organization_id uuid, addon_id text, reason text)
language sql stable security definer set search_path = '' as $$
  select i.workspace_id, w.organization_id, i.addon_id,
         case when s.end_reason in ('stopped', 'unpaid') then s.end_reason else 'gift' end
  from app.addon_installations i
  join app.workspaces w on w.id = i.workspace_id
  left join app.addon_subscriptions s on s.workspace_id = i.workspace_id and s.addon_id = i.addon_id
  where i.state in ('installing', 'enabled')
    and i.addon_id = any (p_paid)
    and (s.workspace_id is null or s.status = 'ended')
    and not private.addon_gifted(i.workspace_id, i.addon_id)
  order by i.changed_at
  limit greatest(1, least(p_limit, 500))
$$;

/**
 * The worker turns a paid add-on off that isn't paid for (`addon_billing.turn_off`), checked again here: on or
 * arriving, not paid for, not given. Kept data and settings, as any add-on turned off. Says the move, or nothing when
 * there's nothing to do.
 */
create or replace function private.addon_billing_turn_off(p_ws uuid, p_addon text)
returns table (state text, generation integer, previous_state text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_row app.addon_installations%rowtype;
begin
  if p_ws is distinct from private.system_scope_workspace() then
    raise exception 'Only the worker turns off an unpaid add-on' using errcode = '42501',
      detail = 'addon_billing_is_ours';
  end if;
  select * into v_row from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon for update;
  if not found or v_row.state not in ('installing', 'enabled')
     or private.addon_gifted(p_ws, p_addon)
     or exists (select 1 from app.addon_subscriptions s
                where s.workspace_id = p_ws and s.addon_id = p_addon and s.status <> 'ended') then
    return;
  end if;
  update app.addon_installations i set state = 'disabled', changed_by = null, changed_at = now(), last_error = null
   where i.workspace_id = p_ws and i.addon_id = p_addon;
  return query select 'disabled'::text, v_row.generation, v_row.state;
end $$;

revoke all on function private.addon_charges_due(integer), private.addon_end_lapsed(),
  private.addon_unpaid_running(text[], integer), private.addon_billing_turn_off(uuid, text) from public;
grant execute on function private.addon_charges_due(integer), private.addon_end_lapsed(),
  private.addon_unpaid_running(text[], integer), private.addon_billing_turn_off(uuid, text) to service_actor;

-- =============================================================================
-- Phone numbers on the wallet, and a nightly check that can see the
-- businesses it checks.
--
--        **The nightly check found nobody.** The reconciliation's plan
--        (apps/worker/src/money/reconcile.ts) listed businesses by reading
--        app.telephony_accounts with no business in scope, and the worker's
--        policy there only shows rows of the business in scope. So it read
--        nothing and never checked anyone. This function answers its one
--        question, as private.workspace_timezones() does for other sweeps,
--        rather than a policy that would show the worker every account.
--
--        **Numbers were never charged.** A number's month was meant to be
--        charged by a sweep (core's numberMonthUsageKey) that was never
--        built, and the reconciliation that might have caught it couldn't
--        run. The worker now charges each number once per calendar month,
--        where the business is (apps/worker/src/money/number-months.ts).
--        This function says which businesses have a number to charge: one
--        we hold now, or released in the last month and a bit, so a number
--        bought and given back between two sweeps still pays for its month.
-- =============================================================================

create or replace function private.telephony_accounts_open()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select t.workspace_id, w.organization_id
  from app.telephony_accounts t
  join app.workspaces w on w.id = t.workspace_id
  where t.account_sid is not null and t.status <> 'closed'
  order by t.workspace_id
$$;

revoke all on function private.telephony_accounts_open() from public;
grant execute on function private.telephony_accounts_open() to service_actor;

create or replace function private.phone_numbers_held()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct n.workspace_id, w.organization_id
  from app.phone_numbers n
  join app.workspaces w on w.id = n.workspace_id
  where n.purchased_at is not null
    and n.status not in ('porting', 'failed')
    and (n.released_at is null or n.released_at > now() - interval '32 days')
$$;

revoke all on function private.phone_numbers_held() from public;
grant execute on function private.phone_numbers_held() to service_actor;

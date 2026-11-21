-- Texting registrations, checked again every few hours (the worker's registration.sweep).
--
-- The worker already asks Twilio every 15 minutes about each step in review, but that one job can stop for good:
-- five failed tries in a row (a short Twilio outage, a refused token) and it never runs again, so a campaign the
-- carriers approve sits on "In review" with nobody told. And an approved brand, campaign or toll-free verification
-- was never asked about again, so one the carriers suspend later went unnoticed.
--
-- The sweep runs with no business in scope, where row-level security shows it no registrations, so it asks this
-- function which businesses to look at. Each one then gets its own `registration.check` job, run inside that
-- business's scope: whatever is still in review (its check started again if it stopped), and the approved steps
-- texting stands on. A business that turned phone & texting off is left out: its subaccount is closed.

create or replace function private.registrations_to_check()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct r.workspace_id, w.organization_id
  from app.telephony_registrations r
  join app.workspaces w on w.id = r.workspace_id
  left join app.telephony_accounts a on a.workspace_id = r.workspace_id
  where (a.status is null or a.status <> 'closed')
    and (
      r.status in ('submitted', 'in_review')
      or (
        r.status = 'approved'
        and r.kind in ('a2p_brand', 'a2p_campaign', 'toll_free_verification')
        and r.provider_sid is not null
        and a.status is not null
      )
    )
$$;

revoke all on function private.registrations_to_check() from public;
grant execute on function private.registrations_to_check() to service_actor;

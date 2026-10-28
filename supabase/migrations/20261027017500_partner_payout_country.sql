-- Partners outside the US (docs/outreach.md decision 118; the partners plan's decision 18): the country of a
-- partner's Stripe Express account, which is where their bank is. Stripe pays a US platform's accounts in the US,
-- Canada, the UK, the EEA and Switzerland. Every account made before this was a US one.
alter table app.partner_payout_accounts
  add column country text not null default 'US' check (country ~ '^[A-Z]{2}$');

-- The country of their bank at Stripe, for their own page: which one they picked before Stripe's form opened. Its
-- own look-up, so portal.partner_payout_account() keeps its columns.
create or replace function portal.partner_payout_country()
returns text
language sql stable security definer set search_path = '' as $$
  select a.country
  from app.partner_payout_accounts a join app.partners pa on pa.id = a.partner_id
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person()
$$;

revoke all on function portal.partner_payout_country() from public;
grant execute on function portal.partner_payout_country() to portal_actor;

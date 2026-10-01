-- =============================================================================
-- Texting registration on the wallet: the carriers' fees for a local number
-- (A2P 10DLC), passed on to the business at cost.
--
--        Twilio charges us The Campaign Registry's and the carriers' fees
--        when a business registers to text from a local number. Until now
--        nothing passed them on: the nightly reconciliation saw Twilio's
--        `a2p-registration-fees` category, didn't know it, and only logged
--        it. Four new lines on the rate card, at markup 10000 (exactly what
--        they cost us, Chris's decision), charged by the worker when they
--        happen (apps/worker/src/money/registration-fees.ts):
--
--        - the brand, $4.50 once, when it's first sent;
--        - the brand's extra (secondary) check, $41.50 once, unless the
--          business sends under 1,000 texts a month;
--        - the campaign review, $15 each time a campaign is sent;
--        - the campaign, $10 a month from the day it's approved, for as
--          long as it stays registered.
--
--        The new lines join the live version of the card rather than
--        publishing a new one: nothing was ever priced at them before, so
--        there is no history for a new version to protect.
-- =============================================================================

-- ---------- the card ----------
-- Mirrors core's USAGE_KEYS; packages/db/test/parity.test.ts asserts the two lists are identical.
alter table platform.usage_rates drop constraint usage_rates_key_check;
alter table platform.usage_rates add constraint usage_rates_key_check check (key in (
  'number.local.month',
  'number.tollfree.month',
  'sms.outbound.segment',
  'sms.inbound.segment',
  'mms.outbound.message',
  'mms.inbound.message',
  'voice.outbound.minute',
  'voice.inbound.local.minute',
  'voice.inbound.tollfree.minute',
  'ai.input.mtok',
  'ai.output.mtok',
  'ai.cache_read.mtok',
  'ai.cache_write.mtok',
  'speech.live.minute',
  'speech.recording.minute',
  'speech.voice.kchar',
  'ai.unknown.mtok',
  'a2p.brand.registration',
  'a2p.brand.vetting',
  'a2p.campaign.vetting',
  'a2p.campaign.month'
));

-- Twilio's A2P 10DLC fees, read September 12, 2026, at exactly cost. Kept in step with core's SEED_RATES.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, v.key, v.unit::platform.usage_unit, v.cost_micros, 10000, 0, 'none', v.notes
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
cross join (values
  ('a2p.brand.registration', 'fee', 4500000,
    'A2P 10DLC brand registration, $4.50 once. Passed on at cost.'),
  ('a2p.brand.vetting', 'fee', 41500000,
    'A2P 10DLC secondary vetting, $41.50 once, over 1,000 texts a month. Passed on at cost.'),
  ('a2p.campaign.vetting', 'fee', 15000000,
    'A2P 10DLC campaign vetting, $15 each time a campaign is sent. Passed on at cost.'),
  ('a2p.campaign.month', 'month', 10000000,
    'A2P 10DLC campaign, $10 a month for a standard use case. Passed on at cost.')
) as v (key, unit, cost_micros, notes)
where not exists (select 1 from platform.usage_rates r where r.key = v.key and r.effective_to is null);

-- ---------- the monthly fee ----------
-- The worker's daily sweep runs for the whole server and then charges each business in its own scope. This is
-- how it finds which businesses have an approved campaign in an open account, without reading anybody's rows
-- outside their scope. A closed account's campaigns went with it, and Twilio stops charging for them.
create or replace function private.a2p_campaigns_live()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct r.workspace_id, w.organization_id
  from app.telephony_registrations r
  join app.workspaces w on w.id = r.workspace_id
  join app.telephony_accounts a on a.workspace_id = r.workspace_id
  where r.kind = 'a2p_campaign' and r.status = 'approved'
    and r.provider_sid is not null and r.approved_at is not null
    and a.status <> 'closed'
$$;

revoke all on function private.a2p_campaigns_live() from public;
grant execute on function private.a2p_campaigns_live() to service_actor;

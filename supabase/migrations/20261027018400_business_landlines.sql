-- AI calls, part 5 (Chris, 2026-10-28): business landlines, behind a switch.
--
-- With Settings → Automations → AI calls → Adjust → **Call business landlines without a yes** on (off to begin
-- with, `automations.calls.businessLandlines` in the business's settings), a campaign's or workflow's call may go to
-- someone with no written yes when their number is a business landline. Just before such a call the worker asks
-- Twilio Lookup what the number is: its line type, and for a landline that isn't a company's number here, who it's
-- registered to. Only a landline that's a business's is called; a mobile, a home line or an internet number still
-- needs the yes.

-- ---------- what the phone company said, kept for 90 days ----------
-- One row per number a business had checked. Only what Twilio said: whether it's a company's number is read fresh
-- each time. Asked again once it's 90 days old (core's LINE_CHECK_DAYS); older rows are cleared as the business's
-- next number is checked. Not about a customer, so it isn't in the Deleted bin; it goes with the business.
create table app.phone_line_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Core's LINE_TYPES: Twilio's line type in our words.
  line_type text not null check (line_type in ('landline', 'mobile', 'voip', 'toll_free', 'other', 'unknown')),
  -- Core's CALLER_TYPES, from the caller name record; null when it wasn't asked (not a landline, or a company's).
  caller_type text check (caller_type is null or caller_type in ('business', 'consumer', 'unknown')),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, phone_e164)
);
create index phone_line_checks_checked on app.phone_line_checks (workspace_id, checked_at);
create trigger phone_line_checks_updated_at before update on app.phone_line_checks
  for each row execute function private.set_updated_at();

-- The team reads them (a campaign's per-person reasons); only the worker writes.
alter table app.phone_line_checks enable row level security;
create policy phone_line_checks_select on app.phone_line_checks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy phone_line_checks_service_all on app.phone_line_checks for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.phone_line_checks to authenticated;
grant select, insert, update, delete on app.phone_line_checks to service_actor;
revoke all on app.phone_line_checks from anon;

-- ---------- why a call to a lead could go ----------
-- Set when a campaign's or workflow's call is placed: `written` (a yes on file) or `business_landline` (no yes, and
-- the phone company said it's a business's landline). Kept with the call, after the check itself is gone.
alter table app.ai_calls add column if not exists consent_basis text
  check (consent_basis is null or consent_basis in ('written', 'business_landline'));

-- ---------- the card: what a check costs ----------
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
  'ai.opus.input.mtok',
  'ai.opus.output.mtok',
  'ai.opus.cache_read.mtok',
  'ai.opus.cache_write.mtok',
  'speech.live.minute',
  'speech.recording.minute',
  'speech.voice.kchar',
  'speech.meeting.minute',
  'video.minute',
  'ai.unknown.mtok',
  'a2p.brand.registration',
  'a2p.brand.vetting',
  'a2p.campaign.vetting',
  'a2p.campaign.month',
  'lookup.line_type',
  'lookup.caller_name'
));

-- Kept in step with core's SEED_RATES: Twilio Lookup's prices, at 1.5×. Each request is billed, so each is charged.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, v.key, 'fee'::platform.usage_unit, v.cost_micros, 15000, v.min_charge_cents, 'none', v.notes
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live,
  (values
    -- 1.2c would round down to 1c, under 1.5x: one on its own is the floor's 2c.
    ('lookup.line_type', 8000, 2,
      'Asking the phone company what kind of line a number is (Twilio Lookup Line Type Intelligence, $0.008), before an AI call to someone with no yes. Charged 2c.'),
    ('lookup.caller_name', 10000, 1,
      'Asking the phone company who a landline is registered to (Twilio Lookup Caller Name, $0.01, US only), before an AI call to someone with no yes. Charged 2c.')
  ) as v (key, cost_micros, min_charge_cents, notes)
where not exists (
  select 1 from platform.usage_rates r where r.key = v.key and r.effective_to is null
);

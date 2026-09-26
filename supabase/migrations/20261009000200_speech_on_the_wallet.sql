-- =============================================================================
-- Speech on the wallet: the AI's hearing and voice (Deepgram), billed at 1.5×.
--
--        Three new lines on the rate card, and a running tally behind them.
--        Talking out loud to the Assistant or on a test call, the AI
--        teammate answering calls live, and call and voicemail transcripts
--        all use Deepgram, and all of it is now charged to the business.
--
--        **Why a tally and not a ledger row per use.** One sentence heard or
--        said costs a small fraction of a cent, and the ledger is in whole
--        cents, rounded once per event. A row per sentence would round every
--        one of them to nothing (or, with a floor, charge ten times the
--        promise). So each use is written here with its exact quantity, and
--        the worker's sweep (apps/worker/src/money/speech-usage.ts) claims a
--        business's unbilled rows as a batch and charges the batch as one
--        event per price line — at 1.5×, rounded once, the way everything
--        else is. Claiming comes first so a batch keeps its id across a
--        crash: charging it again lands on the same idempotency key.
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
  'ai.unknown.mtok'
));

-- Deepgram's pay-as-you-go list prices, September 2026, at exactly 1.5×. Kept in step with core's SEED_RATES.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, v.key, v.unit::platform.usage_unit, v.cost_micros, 15000, v.min_charge_cents, 'none', v.notes
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
cross join (values
  ('speech.live.minute', 'minute', 9200, 2,
    'Deepgram Nova-3 streaming, English and Spanish, $0.0092 a minute. Charged 1.38c, billed in running totals.'),
  ('speech.recording.minute', 'minute', 5200, 1,
    'Deepgram Nova-3 pre-recorded, English and Spanish, $0.0052 a minute. Charged 0.78c, billed in running totals.'),
  ('speech.voice.kchar', 'kchar', 30000, 1,
    'Deepgram Aura 2, $0.030 per 1,000 characters. Charged 4.5c, billed in running totals.')
) as v (key, unit, cost_micros, min_charge_cents, notes)
where not exists (select 1 from platform.usage_rates r where r.key = v.key and r.effective_to is null);

-- ---------- the tally ----------
create table app.speech_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  /** Which line of the card it's charged on. */
  rate_key text not null check (rate_key in
    ('speech.live.minute', 'speech.recording.minute', 'speech.voice.kchar')),
  /** In the line's own unit: minutes of audio, or thousands of characters. Exact, never rounded. */
  quantity numeric(18, 6) not null check (quantity > 0 and quantity <= 100000),
  /** What used it: talking out loud, a live call, or a transcript. */
  source text not null check (source in ('talk', 'call', 'transcript')),
  /** The call's sid or the recording's, when there is one. */
  ref text check (ref is null or length(btrim(ref)) between 1 and 200),
  /** Set when the sweep claims the row, before it charges; the batch is the charge's idempotency key. */
  batch_id uuid,
  charged_at timestamptz,
  created_at timestamptz not null default now(),
  check (charged_at is null or batch_id is not null)
);

create index speech_usage_unbilled_idx on app.speech_usage (workspace_id, rate_key, created_at)
  where charged_at is null;
create index speech_usage_batch_idx on app.speech_usage (batch_id) where batch_id is not null;

-- The worker's alone: it writes each use and bills it. A business reads what it was charged on its statement.
alter table app.speech_usage enable row level security;
create policy speech_usage_service on app.speech_usage for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update on app.speech_usage to service_actor;
revoke all on app.speech_usage from anon, authenticated;

-- The sweep runs for the whole server and then bills each business in its own scope: this is how it finds
-- which businesses have something waiting, without reading anybody's rows outside their scope.
create or replace function private.speech_usage_pending()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct u.workspace_id, u.organization_id from app.speech_usage u where u.charged_at is null
$$;

revoke all on function private.speech_usage_pending() from public;
grant execute on function private.speech_usage_pending() to service_actor;

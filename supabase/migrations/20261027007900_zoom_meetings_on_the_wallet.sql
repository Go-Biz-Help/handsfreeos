-- Coached Zoom meetings on the balance (AI Sales Coach, round three).
--
-- A Zoom meeting the coach hears is transcribed by Zoom (Realtime Media Streams), which draws on Go Biz Help's
-- Developer Pack credits, about 0.02 credits ($0.02) a minute with the transcript. It was counted as the AI listening
-- on a call (`speech.live.minute`, Deepgram's rate), which costs us less than Zoom does. It gets its own line,
-- `speech.meeting.minute`, at 1.5× like the rest of speech: 3¢ a minute, billed in the same running totals.

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
  'speech.meeting.minute',
  'ai.unknown.mtok',
  'a2p.brand.registration',
  'a2p.brand.vetting',
  'a2p.campaign.vetting',
  'a2p.campaign.month'
));

-- Kept in step with core's SEED_RATES.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, 'speech.meeting.minute', 'minute', 20000, 15000, 3, 'none',
  'Zoom Realtime Media Streams with the transcript, about 0.02 Developer Pack credits ($0.02) a minute. Charged 3c, billed in running totals.'
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
where not exists (
  select 1 from platform.usage_rates r where r.key = 'speech.meeting.minute' and r.effective_to is null
);

-- ---------- the tally ----------
alter table app.speech_usage drop constraint speech_usage_rate_key_check;
alter table app.speech_usage add constraint speech_usage_rate_key_check check (rate_key in
  ('speech.live.minute', 'speech.recording.minute', 'speech.voice.kchar', 'speech.meeting.minute'));

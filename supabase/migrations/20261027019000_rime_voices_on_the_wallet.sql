-- Rime's voices on the wallet (the owner's picks, 28 Oct 2026).
--
-- The AI teammate can speak in a Rime voice as well as Deepgram's: Coda, Rime's most natural, and Mist v3, its
-- fastest. Each model gets its own line on the card, at 1.5x what it costs us like the rest of speech, and joins
-- the running tally the worker bills from (apps/worker/src/money/speech-usage.ts):
--
--   speech.voice.coda.kchar   Rime Coda, $0.050 a minute pay as you go, metered at about 1,000 characters a minute
--   speech.voice.mist.kchar   Rime Mist v3, $0.030 a minute, the same as Deepgram's Aura 2
--
-- The new lines join the live version of the card rather than publishing a new one: nothing was ever priced at
-- them before, so there is no history for a new version to protect. Adding keys to the two checks is all the
-- running code needs; nothing is removed.

-- ---------- the card ----------
-- Mirrors core's USAGE_KEYS; packages/db/test/parity.test.ts asserts the two lists are identical. The two keys join
-- whatever the check allows now rather than a list written out here, so a migration from another branch that adds
-- keys of its own (the AI calls' phone line checks) keeps them, whichever of the two runs first.
do $$
declare
  allowed text;
begin
  select string_agg(quote_literal(k), ', ' order by k) into allowed
  from (
    select (regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_.]+)''::text', 'g'))[1] as k
    from pg_constraint c
    where c.conrelid = 'platform.usage_rates'::regclass and c.conname = 'usage_rates_key_check'
    union
    select unnest(array['speech.voice.coda.kchar', 'speech.voice.mist.kchar'])
  ) keys;
  alter table platform.usage_rates drop constraint usage_rates_key_check;
  -- As `key in (…)`, which Postgres keeps as 'key'::text one by one: how the parity test, and the next migration
  -- like this one, read the list.
  execute format(
    'alter table platform.usage_rates add constraint usage_rates_key_check check (key in (%s))',
    allowed
  );
end $$;

-- Rime's pay-as-you-go list prices, October 2026, at exactly 1.5x. Kept in step with core's SEED_RATES.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, v.key, 'kchar', v.cost_micros, 15000, 1, 'none', v.notes
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
cross join (values
  ('speech.voice.coda.kchar', 50000,
    'Rime Coda, $0.050 a minute pay as you go, metered at about 1,000 characters a minute. Charged 7.5c, billed in running totals.'),
  ('speech.voice.mist.kchar', 30000,
    'Rime Mist v3, $0.030 a minute pay as you go, metered at about 1,000 characters a minute. Charged 4.5c, billed in running totals.')
) as v (key, cost_micros, notes)
where not exists (select 1 from platform.usage_rates r where r.key = v.key and r.effective_to is null);

-- ---------- the tally ----------
alter table app.speech_usage drop constraint speech_usage_rate_key_check;
alter table app.speech_usage add constraint speech_usage_rate_key_check check (rate_key in
  ('speech.live.minute', 'speech.recording.minute', 'speech.voice.kchar', 'speech.voice.coda.kchar',
   'speech.voice.mist.kchar', 'speech.meeting.minute'));

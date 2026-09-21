-- =============================================================================
-- 0071 · The rate card: what a text, a minute or a million tokens costs.
--
--        The first half of the usage wallet (M16). Nothing here charges
--        anybody; it is the price list everything later reads.
--
--        It is a **table** and not a constant in code for three reasons Chris
--        and the plan both settled on: the carriers change their prices
--        without asking us, /admin has to be able to edit ours with an audit
--        trail, and the markup and version stamped on every ledger row are
--        what make a mid-month price change honest instead of retroactive. A
--        live row is never edited — a change publishes a new **version**, and
--        the old rows stay exactly as the events that were priced by them say
--        they were.
--
--        Costs are in **micro-dollars**. A text segment costs $0.0079 and an
--        AI input token $0.000003; cents cannot hold either, and a card that
--        rounds its own cost to a cent is wrong before it starts. What a
--        business is charged is in cents, rounded once per event, in
--        packages/core/src/money/rates.ts and nowhere else.
--
--        `markup_bp >= 10000` is the "never below cost" guarantee, in the
--        database rather than only in the code that writes it. The shape of
--        the card — which keys exist and what each one counts — lives in
--        core's USAGE_KEYS, and packages/db/test/parity.test.ts asserts this
--        check constraint allows exactly those keys.
--
--        It lives in `platform`, not `app`: the card is HandsFreeOS's, the
--        same as the support desk. No tenant policy mentions the schema, so
--        no business can reach another's anything through it. But every
--        business **reads** the card, because the usage page says "a text is
--        2¢" — so the read policy here is open to any signed-in person while
--        the write policy is staff-only. What it does not show is `cost_micros`
--        and `markup_bp`: what we pay is ours, and the query that feeds the
--        usage page selects the charged price and leaves those two behind.
-- =============================================================================

-- ---------- the card ----------
-- Matches core's USAGE_UNITS. A quantity is always in its key's own unit: segments, whole minutes, millions of
-- tokens. Passing minutes for an `mtok` key is a bug, not a conversion.
create type platform.usage_unit as enum ('month', 'segment', 'message', 'minute', 'mtok');

-- How a length is rounded up before it is priced. Twilio bills voice per whole minute, so a 20-second call is a
-- minute to us and has to be a minute to the business too.
create type platform.usage_rounding as enum ('none', 'minute', 'six_seconds');

create table platform.usage_rates (
  id uuid primary key default gen_random_uuid(),
  /** Bumped as a whole: one publish writes one version of every key, so a ledger row's version names a card. */
  version int not null,
  key text not null,
  unit platform.usage_unit not null,
  /** What one unit costs **us**, in micro-dollars. A millionth of a dollar; $0.0079 is 7900. */
  cost_micros bigint not null check (cost_micros >= 0),
  /**
   * What we add, in basis points: 15000 is 1.5×. The floor of 10000 is the promise that nothing is ever sold
   * below what it cost, and it is here rather than only in TypeScript because a wrong number typed into /admin
   * at two in the morning should bounce off the database.
   */
  markup_bp int not null default 15000 check (markup_bp >= 10000 and markup_bp <= 1000000),
  /**
   * The least one event may be charged. This is what keeps the promise on things costing less than a cent: an
   * inbound text costs 0.83¢, 1.5× of it is 1.2¢, and cents cannot hold 1.2 — so the floor decides.
   */
  min_charge_cents int not null default 0 check (min_charge_cents >= 0 and min_charge_cents <= 100000),
  round_up_to platform.usage_rounding not null default 'none',
  effective_from timestamptz not null default now(),
  /** Null while live. Set when a later version takes over, so what a row priced can still be read back. */
  effective_to timestamptz,
  notes text not null default '' check (length(notes) <= 500),
  published_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  -- Mirrors core's USAGE_KEYS; packages/db/test/parity.test.ts asserts the two lists are identical.
  constraint usage_rates_key_check check (key in (
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
    'ai.unknown.mtok'
  ))
);

-- One line per key per version, and one live line per key. The partial unique index is what stops a half-applied
-- publish leaving two live prices for a text: the second insert fails rather than the reader picking one.
create unique index usage_rates_version_key on platform.usage_rates (version, key);
create unique index usage_rates_one_live_per_key on platform.usage_rates (key) where effective_to is null;
create index usage_rates_version_idx on platform.usage_rates (version desc);

create trigger usage_rates_updated_at before update on platform.usage_rates
  for each row execute function private.set_updated_at();

-- A published line is history. Its price, its key, its unit and its version never change again; only
-- `effective_to` (retiring it) and `notes` may be written after the fact.
create trigger usage_rates_immutable before update on platform.usage_rates
  for each row execute function private.forbid_tenant_column_change(
    'version', 'key', 'unit', 'cost_micros', 'markup_bp', 'min_charge_cents', 'round_up_to',
    'effective_from', 'published_by');

comment on table platform.usage_rates is
  'What HandsFreeOS charges a business for a text, a call, a number or AI tokens. Costs in micro-dollars, '
  'charges worked out in cents by core''s priceEvent. A live row is never edited: publishing a new version '
  'retires the old one, so what an event was priced at can always be read back.';

-- ---------- the live card ----------
-- One row per key, at whatever version is live. Every reader goes through this rather than remembering to write
-- `where effective_to is null` — the one that forgets is the one that bills last month's prices.
create or replace view platform.usage_rates_live as
  select key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, version, effective_from, notes
  from platform.usage_rates
  where effective_to is null;

-- ---------- who may see it ----------
alter table platform.usage_rates enable row level security;

-- Any signed-in person reads the card: their own usage page says "a text is 2¢", and that price is worked out
-- from these rows. The query that feeds the page selects the charged price and never `cost_micros`.
create policy usage_rates_read on platform.usage_rates for select to authenticated
  using (true);

create policy usage_rates_write on platform.usage_rates for all to authenticated
  using (private.staff_can('platform.rates.manage'))
  with check (private.staff_can('platform.rates.manage'));

-- The worker reads the card with **no business in scope**: it prices a text for a workspace it is not acting
-- inside, from an outbox handler that holds nothing but a message id. So this policy is unconditional on
-- purpose, and it is the one place in the schema where that is the right answer.
create policy usage_rates_service on platform.usage_rates for all to service_actor
  using (true) with check (true);

grant select on platform.usage_rates, platform.usage_rates_live to authenticated;
grant select, insert, update, delete on platform.usage_rates to service_actor;
grant select on platform.usage_rates_live to service_actor;

-- ---------- version 1 ----------
-- Twilio's and Anthropic's US list prices, September 2026, at 1.5× rounded up to something a person can read —
-- which is why the markups are not all 15000. These are list prices and a guess until the shadow week measures
-- the real ones against Chris's own invoice; the margin column in /admin is what says afterwards which are
-- wrong. Kept in step with core's SEED_RATES, which its own test checks line by line.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
values
  (1, 'number.local.month', 'month', 1150000, 17391, 0, 'none',
    'Twilio local number, $1.15 a month. Charged $2.00.'),
  (1, 'number.tollfree.month', 'month', 2150000, 16279, 0, 'none',
    'Twilio toll-free number, $2.15 a month. Charged $3.50.'),
  (1, 'sms.outbound.segment', 'segment', 10900, 18349, 2, 'none',
    'Twilio $0.0079 plus about $0.003 of carrier pass-through. Charged 2c a segment.'),
  (1, 'sms.inbound.segment', 'segment', 8300, 18072, 2, 'none',
    'Twilio inbound SMS, $0.0083. Charged 1.5c a segment, and never under 2c a message.'),
  (1, 'mms.outbound.message', 'message', 32000, 15625, 5, 'none',
    'Twilio outbound MMS, about $0.032 with the carrier fee. Charged 5c.'),
  (1, 'mms.inbound.message', 'message', 16500, 18182, 3, 'none',
    'Twilio inbound MMS, $0.0165. Charged 3c.'),
  (1, 'voice.outbound.minute', 'minute', 13000, 15385, 2, 'minute',
    'Twilio outbound voice, $0.013 a minute, billed per whole minute. Charged 2c.'),
  (1, 'voice.inbound.local.minute', 'minute', 8500, 17647, 2, 'minute',
    'Twilio inbound to a local number, $0.0085 a minute. Charged 1.5c; recording is folded in.'),
  (1, 'voice.inbound.tollfree.minute', 'minute', 22000, 15909, 4, 'minute',
    'Twilio inbound to a toll-free number, $0.022 a minute. Charged 3.5c, never under 4c a call.'),
  (1, 'ai.input.mtok', 'mtok', 2000000, 15000, 0, 'none',
    'claude-sonnet-5 input, $2.00 a million tokens. Charged $3.00.'),
  (1, 'ai.output.mtok', 'mtok', 10000000, 15000, 0, 'none',
    'claude-sonnet-5 output, $10.00 a million tokens. Charged $15.00.'),
  (1, 'ai.cache_read.mtok', 'mtok', 200000, 15000, 0, 'none',
    'claude-sonnet-5 cache read, a tenth of input. Charged $0.30.'),
  (1, 'ai.cache_write.mtok', 'mtok', 2500000, 15000, 0, 'none',
    'claude-sonnet-5 cache write, a quarter more than input. Charged $3.75.'),
  (1, 'ai.unknown.mtok', 'mtok', 15000000, 15000, 0, 'none',
    'A model with no line of its own: priced high on purpose, so one gets noticed and added.');

-- ---------- publishing a new version ----------
-- One statement, so a publish can never leave the card half old and half new: every live row is retired at the
-- same instant the new ones become live. Staff-only, and it refuses a version that does not price every key —
-- a card missing a line is how a month of texts goes out free.
create or replace function private.publish_usage_rates(p_rows jsonb, p_notes text default '')
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_at timestamptz := now();
  v_keys int;
  v_expected int;
begin
  if not private.staff_can('platform.rates.manage') then
    raise exception 'You cannot publish rates' using errcode = '42501', detail = 'rates_manage';
  end if;
  select count(*) into v_expected from platform.usage_rates_live;
  select count(distinct r->>'key') into v_keys from jsonb_array_elements(p_rows) r;
  if v_keys < v_expected then
    raise exception 'A new rate card must price every key (% given, % live)', v_keys, v_expected
      using errcode = '23514', detail = 'rates_incomplete';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from platform.usage_rates;

  update platform.usage_rates set effective_to = v_at where effective_to is null;
  insert into platform.usage_rates
    (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, effective_from, notes, published_by)
  select v_version, r->>'key', (r->>'unit')::platform.usage_unit, (r->>'cost_micros')::bigint,
    (r->>'markup_bp')::int, coalesce((r->>'min_charge_cents')::int, 0),
    coalesce((r->>'round_up_to')::platform.usage_rounding, 'none'), v_at,
    left(coalesce(r->>'notes', p_notes), 500), auth.uid()
  from jsonb_array_elements(p_rows) r;
  return v_version;
end $$;

grant execute on function private.publish_usage_rates(jsonb, text) to authenticated, service_actor;

-- ---------- who may edit it ----------
-- Only a support admin publishes prices. Mirrored in packages/core/src/permissions.ts, which
-- packages/core/test/permissions-parity.test.ts asserts against these rows.
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.rates.manage');

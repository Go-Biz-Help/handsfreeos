-- =============================================================================
-- Each business pays for its own AI, sets its own daily AI limit, and nobody
-- is Silent any more (the owner's decisions, 26 October 2026).
--
--   1. **A daily AI limit each business sets, in dollars.** It starts at $10 a
--      day and lives on the business's own wallet, so whoever may manage its
--      money (`money.manage`) changes it on Settings → Usage & balance, at
--      any time and to any amount: HandsFreeOS sets no ceiling. It replaces
--      ASSISTANT_DAILY_TOKENS, one number in tokens for every business, which
--      counted a cheap cache read the same as an expensive answer — 2 million
--      tokens came to $1.76 one morning. Today's AI is priced from the live
--      card (`private.ai_spend_today`), so the number a business sets and the
--      numbers on its statement are the same kind of number.
--
--   2. **Ask HandsFreeOS is on the balance**, like the rest of the AI. It runs
--      on Claude Opus, which costs twice what the card's AI lines are priced
--      for, so it gets four lines of its own (`ai.opus.*`) at the usual 1.5×.
--
--   3. **Silent (`off`) is gone.** A business HandsFreeOS covers is `agency`
--      (Paid by the agency); every other business is `enforce` (Stopped at
--      zero). A new business starts at `enforce` with a $5 starting credit, so
--      it can set up and try the AI and texting before it adds a card. A
--      founding partner's founding credit tops that up to the offer's amount
--      rather than adding to it. A business that was Silent and never had a
--      credit gets the starting credit too, so nobody stops the moment this
--      runs.
--
--      Before applying this to the hosted project, move every business
--      HandsFreeOS covers but that isn't marked as its own business to "Paid
--      by the agency" in /admin. This moves only HandsFreeOS's own business
--      (`is_platform`) there; every other Silent one becomes Stopped at zero.
-- =============================================================================

-- ---------- 1. the card: Ask HandsFreeOS's own lines ----------
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
  'ai.unknown.mtok',
  'a2p.brand.registration',
  'a2p.brand.vetting',
  'a2p.campaign.vetting',
  'a2p.campaign.month'
));

-- Kept in step with core's SEED_RATES: Anthropic's list price for Claude Opus 5.5, October 2026, at 1.5×.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, v.key, 'mtok', v.cost_micros, 15000, 0, 'none', v.notes
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live,
  (values
    ('ai.opus.input.mtok', 4000000::bigint,
      'Ask HandsFreeOS (claude-opus-5-5) input, $4.00 a million tokens. Charged $6.00.'),
    ('ai.opus.output.mtok', 20000000::bigint,
      'Ask HandsFreeOS (claude-opus-5-5) output, $20.00 a million tokens. Charged $30.00.'),
    ('ai.opus.cache_read.mtok', 200000::bigint,
      'Ask HandsFreeOS (claude-opus-5-5) cache read, $0.20 a million tokens. Charged $0.30.'),
    ('ai.opus.cache_write.mtok', 5000000::bigint,
      'Ask HandsFreeOS (claude-opus-5-5) cache write, a quarter more than input. Charged $7.50.')
  ) as v (key, cost_micros, notes)
where not exists (
  select 1 from platform.usage_rates r where r.key = v.key and r.effective_to is null
);

-- ---------- 2. the limit, on the business's own wallet ----------
-- Business-writable like the four top-up settings: private.guard_usage_wallet lists what is HandsFreeOS's to
-- write, and this isn't on that list. The upper bound only keeps the column sane ($1,000,000 a day); zero pauses
-- the AI, which a test uses and a person can't set (the command asks for at least $1).
alter table app.usage_wallets
  add column ai_daily_limit_cents bigint not null default 1000
    check (ai_daily_limit_cents >= 0 and ai_daily_limit_cents <= 100000000);

comment on column app.usage_wallets.ai_daily_limit_cents is
  'The most this business''s AI may be charged in one day (midnight to midnight where it is), in cents: the '
  'Assistant, the AI teammate, workflows, builders, add-ons. Set by the business; $10 until it changes it.';

-- ---------- 3. what today's AI comes to ----------
-- Every AI token since midnight where the business is (the Assistant's runs, everyone's, plus app.ai_usage),
-- priced from the live card at what the business is charged. Claude Opus models (Ask HandsFreeOS) are priced
-- from `ai.opus.*`, everything else from `ai.*`: the same rule as core's aiRateKeys, which the worker charges by.
-- Not rounded per request the way the ledger is, so it can differ from the statement by a cent or two.
create or replace function private.ai_spend_today(p_workspace uuid, p_teammate uuid default null)
returns table (limit_cents bigint, spent_cents numeric, teammate_cents numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_since timestamptz;
begin
  -- The same door as private.ai_tokens_today: a person reads the businesses their JWT gives them, the worker
  -- the one its system scope names.
  if p_workspace is null or not coalesce(
    p_workspace in (select private.accessible_workspace_ids())
    or ((select auth.uid()) is null and p_workspace = private.system_scope_workspace()),
    false
  ) then
    raise exception 'Only the business''s own people can read its AI use'
      using errcode = '42501', detail = 'ai_usage_forbidden';
  end if;
  select w.timezone into v_tz from app.workspaces w where w.id = p_workspace;
  v_tz := coalesce(v_tz, 'UTC');
  v_since := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  return query
  with rates as (
    -- Cents per token: micro-dollars per million tokens, marked up, per token, in cents.
    select r.key, r.cost_micros::numeric * r.markup_bp / 10000 / 1000000 / 10000 as per_token
    from platform.usage_rates_live r
    where r.key like 'ai.%'
  ),
  used as (
    select case when u.model like 'claude-opus%' then 'ai.opus.' else 'ai.' end as family,
      u.source::text as source, u.teammate_id,
      u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
    from app.ai_usage u
    where u.workspace_id = p_workspace and u.created_at >= v_since
    union all
    select case when r.model like 'claude-opus%' then 'ai.opus.' else 'ai.' end,
      'assistant_run', null::uuid,
      r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens
    from app.assistant_runs r
    where r.workspace_id = p_workspace and r.started_at >= v_since
  ),
  priced as (
    select x.source, x.teammate_id,
      x.input_tokens * coalesce(ri.per_token, 0)
        + x.output_tokens * coalesce(ro.per_token, 0)
        + x.cache_read_tokens * coalesce(rr.per_token, 0)
        + x.cache_write_tokens * coalesce(rw.per_token, 0) as cents
    from used x
    left join rates ri on ri.key = x.family || 'input.mtok'
    left join rates ro on ro.key = x.family || 'output.mtok'
    left join rates rr on rr.key = x.family || 'cache_read.mtok'
    left join rates rw on rw.key = x.family || 'cache_write.mtok'
  )
  select
    coalesce((select w.ai_daily_limit_cents from app.usage_wallets w where w.workspace_id = p_workspace), 1000)::bigint,
    coalesce(sum(p.cents), 0)::numeric,
    coalesce(sum(p.cents) filter (
      where p.source = 'teammate' and p_teammate is not null and p.teammate_id = p_teammate), 0)::numeric
  from priced p;
end $$;

revoke all on function private.ai_spend_today(uuid, uuid) from public;
grant execute on function private.ai_spend_today(uuid, uuid) to authenticated, service_actor;

-- ---------- 4. no more Silent ----------
alter table app.usage_wallets alter column stage set default 'enforce';

comment on column app.usage_wallets.stage is
  'How far along the wallet this business is: warn (told, nothing stops), enforce (Stopped at zero, the '
  'default) or agency (Paid by the agency: HandsFreeOS covers it). Silent (off) is gone since 20261027012500. '
  'Staff-only: private.guard_usage_wallet refuses a business writing its own.';

-- Moving a business along refuses Silent now; everything else is as 0102 left it.
create or replace function private.set_wallet_stage(p_workspace uuid, p_stage app.wallet_stage)
returns table (was app.wallet_stage, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was app.wallet_stage;
  v_org uuid;
  v_balance bigint;
begin
  if not private.staff_can('platform.wallets.adjust') then
    raise exception 'You cannot change where a business is on the wallet'
      using errcode = '42501', detail = 'wallets_adjust';
  end if;
  if p_stage = 'off' then
    raise exception 'Silent is gone: a business is Paid by the agency, Warned or Stopped at zero'
      using errcode = '22023', detail = 'wallet_stage_off_is_gone';
  end if;
  -- This business's own scope, for the writes below and nothing else.
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  select stage into v_was from app.usage_wallets where workspace_id = p_workspace;
  if not found then
    select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
    if v_org is null then
      perform set_config('app.system_scope.workspace_id', '', true);
      raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
    end if;
    insert into app.usage_wallets (workspace_id, organization_id) values (p_workspace, v_org)
      on conflict (workspace_id) do nothing;
    select stage into v_was from app.usage_wallets where workspace_id = p_workspace;
  end if;
  update app.usage_wallets set stage = p_stage where workspace_id = p_workspace;
  -- Leaving the agency's care: what it paid for is settled, so they don't start out owing it.
  if v_was = 'agency' and p_stage <> 'agency' then
    select w.balance_cents, w.organization_id into v_balance, v_org
      from app.usage_wallets w where w.workspace_id = p_workspace;
    if v_balance < 0 then
      insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
        idempotency_key, meta, occurred_at)
      values (p_workspace, v_org, 'credit', -v_balance, 'Paid by the agency',
        'agency-paid:' || gen_random_uuid()::text,
        jsonb_build_object('reason', 'Paid by the agency', 'by', auth.uid()), now());
    end if;
  end if;
  perform set_config('app.system_scope.workspace_id', '', true);
  return query select v_was, v_was is distinct from p_stage;
end $$;

-- ---------- 5. the starting credit ----------
-- $5 on the balance of a business that is new, once (the ledger's key), opening its wallet if it has none. The
-- system scope it borrows for the ledger insert is put back afterwards, as founding_credit_wallet does.
create or replace function private.starting_credit_wallet(p_workspace uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_entry uuid;
  v_scope text := current_setting('app.system_scope.workspace_id', true);
begin
  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  if v_org is null then
    return false;
  end if;
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  insert into app.usage_wallets (workspace_id, organization_id) values (p_workspace, v_org)
    on conflict (workspace_id) do nothing;
  insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
    idempotency_key, meta, occurred_at)
  values (p_workspace, v_org, 'credit'::app.usage_entry_kind, 500, 'Starting credit',
    'credit:starting:' || p_workspace::text, jsonb_build_object('reason', 'starting credit'), now())
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_entry;
  perform set_config('app.system_scope.workspace_id', coalesce(v_scope, ''), true);
  return v_entry is not null;
end $$;

revoke all on function private.starting_credit_wallet(uuid) from public;

create or replace function private.workspace_starting_credit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.starting_credit_wallet(new.id);
  return null;
end $$;

create trigger workspaces_starting_credit after insert on app.workspaces
  for each row execute function private.workspace_starting_credit();

-- A founding partner's credit is the offer's amount in all: a business that had its starting credit is topped
-- up to it, not given it on top. Otherwise as 0095 left it.
create or replace function private.founding_credit_wallet(p_grant uuid)
returns table (credited_cents bigint, recorded boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_org uuid;
  v_amount bigint;
  v_offer text;
  v_entry uuid;
  v_starting bigint;
  v_scope text := current_setting('app.system_scope.workspace_id', true);
begin
  select g.workspace_id, g.organization_id, o.starting_credit_cents, o.name
    into v_ws, v_org, v_amount, v_offer
  from platform.founding_grants g
  join platform.founding_offers o on o.id = g.offer_id
  where g.id = p_grant and g.status = 'active';

  -- No seat, no workspace on it, or an offer that grants nothing: not an error, simply nothing to do.
  if v_ws is null or coalesce(v_amount, 0) <= 0 then
    return query select 0::bigint, false;
    return;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_starting from app.usage_ledger l
    where l.workspace_id = v_ws and l.idempotency_key = 'credit:starting:' || v_ws::text;
  v_amount := v_amount - v_starting;
  if v_amount <= 0 then
    return query select 0::bigint, false;
    return;
  end if;

  insert into app.usage_wallets (workspace_id, organization_id)
  values (v_ws, v_org)
  on conflict (workspace_id) do nothing;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);

  insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
    idempotency_key, meta, occurred_at)
  values (v_ws, v_org, 'credit'::app.usage_entry_kind, v_amount,
    left('Founding starting credit (' || v_offer || ')', 300),
    'credit:founding:' || p_grant::text,
    jsonb_build_object('reason', 'founding starting credit', 'grant_id', p_grant, 'offer', v_offer,
      'less_starting_credit', v_starting),
    now())
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_entry;

  perform set_config('app.system_scope.workspace_id', coalesce(v_scope, ''), true);

  return query select case when v_entry is null then 0::bigint else v_amount end, v_entry is not null;
end $$;

-- ---------- 6. every business that was Silent ----------
-- One wallet at a time, each in its own scope, because guard_usage_wallet refuses a stage change from anyone
-- else: HandsFreeOS's own business is Paid by the agency, every other one Stopped at zero. A business that never
-- opened a wallet gets one the same way, and one that never had a credit gets the starting credit, so a business
-- a few cents under (Silent counted its usage and told it nothing) doesn't stop the moment this runs.
do $$
declare
  r record;
begin
  for r in
    select w.id, w.organization_id, w.is_platform, uw.stage
    from app.workspaces w
    left join app.usage_wallets uw on uw.workspace_id = w.id
    where uw.workspace_id is null or uw.stage = 'off'
  loop
    perform set_config('app.system_scope.workspace_id', r.id::text, true);
    if r.stage is null then
      insert into app.usage_wallets (workspace_id, organization_id, stage)
      values (r.id, r.organization_id,
        (case when r.is_platform then 'agency' else 'enforce' end)::app.wallet_stage)
      on conflict (workspace_id) do nothing;
    else
      update app.usage_wallets
        set stage = (case when r.is_platform then 'agency' else 'enforce' end)::app.wallet_stage
        where workspace_id = r.id;
    end if;
    if not r.is_platform and not exists (
      select 1 from app.usage_ledger l where l.workspace_id = r.id and l.kind = 'credit'
    ) then
      perform private.starting_credit_wallet(r.id);
    end if;
  end loop;
  perform set_config('app.system_scope.workspace_id', '', true);
end $$;
